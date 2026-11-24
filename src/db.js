// SQLite database using Node's built-in driver (node:sqlite, Node >= 22.13).
// No native compilation is needed, so `npm install` works on Windows, macOS and Linux.
const fs = require('fs');
const path = require('path');
const config = require('./config');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(`\nMediConnect needs Node.js 22.13 or newer (you have ${process.version}).\nInstall the current LTS from https://nodejs.org and run npm install again.\n`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const SCHEMA_VERSION = 7;
// A database from an older version of MediConnect is backed up and rebuilt with fresh demo data.
if (fs.existsSync(config.dbFile)) {
  const old = new DatabaseSync(config.dbFile);
  const v = old.prepare('PRAGMA user_version').get().user_version;
  const hasUsers = old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  old.close();
  if (hasUsers && v < SCHEMA_VERSION) {
    const backup = `${config.dbFile}.v${v}-${Date.now()}.bak`;
    fs.renameSync(config.dbFile, backup);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(config.dbFile + ext)) fs.rmSync(config.dbFile + ext);
    console.log(`Database upgraded: old data backed up to ${path.basename(backup)}; demo data will be reloaded.`);
  }
}
const raw = new DatabaseSync(config.dbFile);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

raw.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','center','pharmacy','ambulance','admin','caregiver')),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0, phone_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','suspended','rejected')),
  review_note TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','login','reset')), channel TEXT NOT NULL DEFAULT 'email',
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS patient_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  patient_code TEXT, date_of_birth TEXT, gender TEXT, blood_group TEXT, address TEXT,
  emergency_contact TEXT, height_cm REAL, lat REAL, lng REAL, live_lat REAL, live_lng REAL, live_at TEXT,
  notify_reports INTEGER NOT NULL DEFAULT 1, notify_appointments INTEGER NOT NULL DEFAULT 1,
  notify_orders INTEGER NOT NULL DEFAULT 1, default_access_days INTEGER NOT NULL DEFAULT 7,
  language TEXT NOT NULL DEFAULT 'English'
);
CREATE TABLE IF NOT EXISTS doctor_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialty TEXT NOT NULL, qualifications TEXT, experience_years INTEGER NOT NULL DEFAULT 0,
  license_no TEXT, fee INTEGER NOT NULL DEFAULT 0, bio TEXT, address TEXT, lat REAL, lng REAL,
  slot_minutes INTEGER NOT NULL DEFAULT 30, buffer_minutes INTEGER NOT NULL DEFAULT 5,
  max_per_day INTEGER NOT NULL DEFAULT 16, in_person INTEGER NOT NULL DEFAULT 1, online INTEGER NOT NULL DEFAULT 1,
  live_lat REAL, live_lng REAL, live_at TEXT, share_location INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0
);
-- Weekly hours. weekday: 0 = Sunday ... 6 = Saturday
CREATE TABLE IF NOT EXISTS doctor_hours (
  doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  start_time TEXT NOT NULL DEFAULT '09:00', end_time TEXT NOT NULL DEFAULT '13:00',
  PRIMARY KEY (doctor_id, weekday)
);
CREATE TABLE IF NOT EXISTS doctor_time_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT
);
CREATE TABLE IF NOT EXISTS provider_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, file_path TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT, size INTEGER,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, address TEXT, lat REAL, lng REAL, phone TEXT, email TEXT,
  opening_hours TEXT, services TEXT, license_no TEXT,
  online_booking INTEGER NOT NULL DEFAULT 1, verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS center_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  center_id INTEGER NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
  is_admin INTEGER NOT NULL DEFAULT 0, title TEXT
);
CREATE TABLE IF NOT EXISTS pharmacies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, address TEXT, lat REAL, lng REAL, phone TEXT, license_no TEXT,
  delivery_minutes INTEGER NOT NULL DEFAULT 45, delivery_fee INTEGER NOT NULL DEFAULT 30,
  accepts_cod INTEGER NOT NULL DEFAULT 1, accepts_online INTEGER NOT NULL DEFAULT 1,
  discount_pct INTEGER NOT NULL DEFAULT 0, emergency_fee INTEGER NOT NULL DEFAULT 120, emergency_minutes INTEGER NOT NULL DEFAULT 25,
  verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS health_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL, result_json TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER NOT NULL REFERENCES users(id),
  health_entry_id INTEGER REFERENCES health_entries(id),
  reason TEXT, preferred_time TEXT, proposed_time TEXT, alt_times TEXT,
  mode TEXT NOT NULL DEFAULT 'in_person', duration INTEGER NOT NULL DEFAULT 30, doctor_note TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','proposed','reschedule_requested','confirmed','completed','declined','cancelled')),
  consultation_notes TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS appointment_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','event')),
  body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS test_catalog (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, category TEXT);
CREATE TABLE IF NOT EXISTS center_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  center_id INTEGER NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
  test_id INTEGER NOT NULL REFERENCES test_catalog(id),
  price INTEGER NOT NULL, report_time TEXT NOT NULL DEFAULT 'Same day',
  available INTEGER NOT NULL DEFAULT 1, online_booking INTEGER NOT NULL DEFAULT 1, discount_pct INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (center_id, test_id)
);
CREATE TABLE IF NOT EXISTS test_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER REFERENCES users(id),
  appointment_id INTEGER REFERENCES appointments(id),
  prescription_id INTEGER,
  test_id INTEGER NOT NULL REFERENCES test_catalog(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'prescribed'
    CHECK (status IN ('prescribed','requested','scheduled','sample_collected','completed','cancelled')),
  center_id INTEGER REFERENCES centers(id),
  preferred_date TEXT, scheduled_at TEXT, collected_at TEXT, price INTEGER, paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_order_id INTEGER REFERENCES test_orders(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  center_id INTEGER NOT NULL REFERENCES centers(id),
  doctor_id INTEGER REFERENCES users(id),
  test_id INTEGER NOT NULL REFERENCES test_catalog(id),
  test_date TEXT NOT NULL, technician TEXT, summary TEXT,
  file_path TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT, size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  report_id INTEGER REFERENCES reports(id),
  reason TEXT, duration_hours INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at TEXT NOT NULL DEFAULT ${NOW}, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS access_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  report_id INTEGER REFERENCES reports(id),
  source TEXT NOT NULL CHECK (source IN ('request','share')),
  request_id INTEGER REFERENCES access_requests(id),
  expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id), actor_role TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER, patient_id INTEGER, ip TEXT, details TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, body TEXT, link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE, brand TEXT, form TEXT, strength TEXT,
  rx_required INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pharmacy_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  price REAL NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, expiry TEXT, sold INTEGER NOT NULL DEFAULT 0,
  discount_pct INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
  deliverable INTEGER NOT NULL DEFAULT 1,
  UNIQUE (pharmacy_id, medicine_id)
);
CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER REFERENCES users(id),
  appointment_id INTEGER REFERENCES appointments(id),
  source TEXT NOT NULL CHECK (source IN ('doctor','upload')),
  image_path TEXT, original_name TEXT, ocr_text TEXT, diagnosis TEXT, notes TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS prescription_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_id INTEGER REFERENCES medicines(id),
  raw_name TEXT NOT NULL, dose TEXT, frequency TEXT, duration_days INTEGER, quantity INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  prescription_id INTEGER REFERENCES prescriptions(id),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','preparing','ready','out_for_delivery','delivered','rejected','cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod','online')), payment_channel TEXT, payment_provider TEXT, payment_ref TEXT,
  order_type TEXT NOT NULL DEFAULT 'regular' CHECK (order_type IN ('regular','emergency')), lat REAL, lng REAL, discount REAL NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  delivery_address TEXT, accepted INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0,
  prescription_checked INTEGER NOT NULL DEFAULT 0, pharmacy_note TEXT,
  rider_name TEXT, rider_phone TEXT, out_at TEXT,
  delivery_fee REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  quantity INTEGER NOT NULL, fulfilled_quantity INTEGER, unit_price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- New features -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pharmacy_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  availability INTEGER NOT NULL, price INTEGER NOT NULL, delivery INTEGER NOT NULL, service INTEGER NOT NULL,
  overall REAL NOT NULL, comment TEXT, hidden INTEGER NOT NULL DEFAULT 0, reply TEXT, replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prescription_id INTEGER REFERENCES prescriptions(id),
  medicine_id INTEGER REFERENCES medicines(id),
  medicine_name TEXT NOT NULL, dose TEXT, times TEXT NOT NULL,       -- times: "08:00,21:00"
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  pills_left INTEGER, active INTEGER NOT NULL DEFAULT 1, notify_push INTEGER NOT NULL DEFAULT 1, notify_voice INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS dose_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('due','taken','skipped')),
  notified INTEGER NOT NULL DEFAULT 0, acted_at TEXT,
  UNIQUE (reminder_id, due_at)
);
CREATE TABLE IF NOT EXISTS health_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bp','sugar','weight','pulse','spo2')),
  value1 REAL NOT NULL, value2 REAL, context TEXT, measured_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')), body TEXT NOT NULL, flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS blood_donors (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blood_group TEXT NOT NULL, lat REAL, lng REAL, area TEXT, last_donation TEXT, phone TEXT, show_phone INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1, donations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS blood_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  patient_name TEXT NOT NULL, blood_group TEXT NOT NULL, units INTEGER NOT NULL,
  hospital TEXT NOT NULL, lat REAL, lng REAL, needed_by TEXT, urgency TEXT NOT NULL DEFAULT 'normal',
  contact_phone TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','cancelled')),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS blood_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES blood_requests(id) ON DELETE CASCADE,
  donor_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'notified' CHECK (status IN ('notified','accepted','declined','donated')),
  distance REAL, responded_at TEXT,
  UNIQUE (request_id, donor_id)
);

CREATE TABLE IF NOT EXISTS blood_donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  donated_on TEXT NOT NULL, place TEXT, created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Patient <-> doctor chat (needs the doctor's acceptance)
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','closed')),
  created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS chat_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, read_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Ambulance service
CREATE TABLE IF NOT EXISTS ambulances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL, vehicle_no TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'Non-AC',
  driver_name TEXT, driver_phone TEXT, base_area TEXT, license_no TEXT,
  base_fare INTEGER NOT NULL DEFAULT 800, per_km INTEGER NOT NULL DEFAULT 60,
  lat REAL, lng REAL, location_at TEXT, online INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS ambulance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  ambulance_id INTEGER NOT NULL REFERENCES ambulances(id),
  pickup_lat REAL, pickup_lng REAL, pickup_address TEXT, destination TEXT, phone TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','on_the_way','arrived','completed','declined','cancelled')),
  distance REAL, fare INTEGER, start_lat REAL, start_lng REAL, accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Health documents and values extracted from them (for analysis and prediction)
CREATE TABLE IF NOT EXISTS health_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, doc_date TEXT NOT NULL, file_path TEXT, original_name TEXT, mime_type TEXT, size INTEGER,
  extracted_text TEXT, report_id INTEGER REFERENCES reports(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS health_markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id INTEGER REFERENCES health_documents(id) ON DELETE CASCADE,
  marker TEXT NOT NULL, value REAL NOT NULL, measured_on TEXT NOT NULL
);

-- Payments (sandbox: no real money moves)
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, provider TEXT, account_hint TEXT, amount REAL NOT NULL, txn_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success', created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Caregiver proxy: a patient lets another account (family member, carer) see and act on their timeline.
CREATE TABLE IF NOT EXISTS caregiver_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caregiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship TEXT,
  can_act INTEGER NOT NULL DEFAULT 1,
  share_reminders INTEGER NOT NULL DEFAULT 1, share_vitals INTEGER NOT NULL DEFAULT 1, share_reports INTEGER NOT NULL DEFAULT 1,
  last_viewed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','declined','revoked')),
  invited_by INTEGER NOT NULL REFERENCES users(id),
  consent_at TEXT NOT NULL,
  responded_at TEXT, revoked_at TEXT, revoked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
-- Care notes: short messages on the shared timeline between the patient and their caregivers.
CREATE TABLE IF NOT EXISTS care_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_care_patient ON caregiver_links(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_care_caregiver ON caregiver_links(caregiver_id, status);

CREATE INDEX IF NOT EXISTS idx_markers ON health_markers(patient_id, marker, measured_on);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_doctor ON appointments(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reports_patient ON reports(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log(patient_id);
CREATE INDEX IF NOT EXISTS idx_dose_due ON dose_logs(status, due_at);
`);

// Who did it: set when a caregiver marks a dose or logs a reading for the patient.
// Allergies and long-term conditions: the Health AI checks them before suggesting any medicine.
for (const [table, col, type] of [['dose_logs', 'acted_by', 'INTEGER REFERENCES users(id)'], ['health_readings', 'recorded_by', 'INTEGER REFERENCES users(id)'],
  ['dose_logs', 'caregiver_alerted', 'INTEGER NOT NULL DEFAULT 0'], ['patient_profiles', 'allergies', 'TEXT'], ['patient_profiles', 'conditions', 'TEXT']]) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = raw.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

const db = {
  raw,
  get: (sql, ...p) => stmt(sql).get(...p),
  all: (sql, ...p) => stmt(sql).all(...p),
  run: (sql, ...p) => {
    const r = stmt(sql).run(...p);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
  exec: (sql) => raw.exec(sql),
  tx(fn) {
    raw.exec('BEGIN');
    try {
      const out = fn();
      raw.exec('COMMIT');
      return out;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  },
  now: () => new Date().toISOString(),
};

module.exports = db;
