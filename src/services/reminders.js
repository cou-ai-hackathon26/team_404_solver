// Medicine reminders: turn prescriptions into dose schedules, notify when a dose
// is due, track Taken / Skipped, compute adherence and send refill alerts.
const db = require('../db');
const { notify } = require('./notify');
const { dateStr } = require('./schedule');

const SLOT_TIMES = ['08:00', '14:00', '21:00']; // morning, afternoon, night
const FREQUENCIES = {
  'Once a day': ['09:00'],
  '2 times a day': ['08:00', '21:00'],
  '3 times a day': ['08:00', '14:00', '21:00'],
  '4 times a day': ['08:00', '12:00', '16:00', '21:00'],
  'Before breakfast': ['07:30'],
  'After lunch': ['14:00'],
  'At night': ['21:30'],
};
const PER_DAY = Object.fromEntries(Object.entries(FREQUENCIES).map(([k, v]) => [k, v.length]));

/** Dose times from a frequency label or a "1+0+1" pattern. */
function timesFor(frequency, dose) {
  if (FREQUENCIES[frequency]) return FREQUENCIES[frequency];
  const m = String(`${frequency || ''} ${dose || ''}`).match(/(\d)\s*\+\s*(\d)\s*\+\s*(\d)/);
  if (m) {
    const t = [m[1], m[2], m[3]].map(Number).flatMap((n, i) => (n > 0 ? [SLOT_TIMES[i]] : []));
    if (t.length) return t;
  }
  const n = Number((String(frequency || '').match(/(\d)\s*(?:times|x)/i) || [])[1]);
  if (n >= 1 && n <= 4) return FREQUENCIES[n === 1 ? 'Once a day' : `${n} times a day`];
  return ['09:00'];
}

function createFromPrescription(patientId, prescriptionId) {
  const items = db.all(
    `SELECT i.*, m.name, m.strength FROM prescription_items i LEFT JOIN medicines m ON m.id = i.medicine_id
      WHERE i.prescription_id = ?`, prescriptionId);
  const today = dateStr(new Date());
  let made = 0;
  for (const i of items) {
    if (db.get('SELECT 1 FROM reminders WHERE prescription_id = ? AND medicine_name = ? AND active = 1', prescriptionId, i.name ? `${i.name} ${i.strength || ''}`.trim() : i.raw_name)) continue;
    const times = timesFor(i.frequency, i.dose);
    const days = i.duration_days || Math.max(1, Math.ceil((i.quantity || times.length * 7) / times.length));
    const end = new Date();
    end.setDate(end.getDate() + days - 1);
    db.run(
      `INSERT INTO reminders (patient_id, prescription_id, medicine_id, medicine_name, dose, times, start_date, end_date, pills_left)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      patientId, prescriptionId, i.medicine_id, i.name ? `${i.name} ${i.strength || ''}`.trim() : i.raw_name,
      i.dose || '1', times.join(','), today, dateStr(end), i.quantity || times.length * days);
    made++;
  }
  materialize(patientId);
  return made;
}

/** Make sure dose rows exist for today and tomorrow. */
function materialize(patientId = null) {
  const rows = patientId
    ? db.all('SELECT * FROM reminders WHERE active = 1 AND patient_id = ?', patientId)
    : db.all('SELECT * FROM reminders WHERE active = 1');
  const t = new Date();
  for (const r of rows) {
    for (let k = 0; k < 2; k++) {
      const day = dateStr(new Date(t.getFullYear(), t.getMonth(), t.getDate() + k));
      if (day < r.start_date || day > r.end_date) continue;
      for (const time of r.times.split(',')) {
        const due = new Date(`${day}T${time}:00`).toISOString();
        db.run("INSERT OR IGNORE INTO dose_logs (reminder_id, due_at, status) VALUES (?, ?, 'due')", r.id, due);
      }
    }
    if (r.end_date < dateStr(t)) db.run('UPDATE reminders SET active = 0 WHERE id = ?', r.id);
  }
}

function today(patientId) {
  materialize(patientId);
  const t = new Date();
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString();
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).toISOString();
  return db.all(
    `SELECT d.*, r.medicine_name, r.dose, r.pills_left FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id
      WHERE r.patient_id = ? AND d.due_at >= ? AND d.due_at < ? ORDER BY d.due_at`, patientId, start, end);
}

/** Share of past doses taken in the last `days` days (doses still "due" 2h after time count as missed). */
function adherence(patientId, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const cutoff = new Date(Date.now() - 2 * 3600000).toISOString();
  const rows = db.all(
    `SELECT d.status, d.due_at FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id
      WHERE r.patient_id = ? AND d.due_at >= ? AND d.due_at <= ?`, patientId, since, new Date().toISOString());
  const counted = rows.filter((r) => r.status !== 'due' || r.due_at < cutoff);
  const taken = counted.filter((r) => r.status === 'taken').length;
  return { taken, total: counted.length, pct: counted.length ? Math.round((taken / counted.length) * 100) : null };
}

function mark(patientId, doseId, status, actorId = null) {
  const d = db.get(
    `SELECT d.*, r.patient_id, r.pills_left, r.id AS rid, r.medicine_name, r.prescription_id FROM dose_logs d
      JOIN reminders r ON r.id = d.reminder_id WHERE d.id = ? AND r.patient_id = ?`, doseId, patientId);
  if (!d || !['taken', 'skipped'].includes(status)) return false;
  db.run('UPDATE dose_logs SET status = ?, acted_at = ?, acted_by = ? WHERE id = ?', status, db.now(), actorId, d.id);
  if (status === 'taken' && d.status !== 'taken' && d.pills_left != null) {
    const left = Math.max(0, d.pills_left - 1);
    db.run('UPDATE reminders SET pills_left = ? WHERE id = ?', left, d.rid);
    if (left === 3) {
      notify(patientId, `Refill soon: ${d.medicine_name}`, 'Only 3 doses left. Reorder from the same pharmacy in one click.', '/patient/reminders', 'order');
    }
  }
  return true;
}

/** Runs every minute: notify due doses. */
function tick() {
  try {
    materialize();
    const now = new Date();
    const due = db.all(
      `SELECT d.id, d.due_at, r.patient_id, r.medicine_name, r.dose FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id
        WHERE d.status = 'due' AND d.notified = 0 AND d.due_at <= ? AND d.due_at >= ?`,
      now.toISOString(), new Date(now - 30 * 60000).toISOString());
    for (const d of due) {
      notify(d.patient_id, `Time to take ${d.medicine_name}`, `Dose: ${d.dose || '1'}. Mark it as taken in Medicine Reminders.`, '/patient/reminders', 'reminder');
      db.run('UPDATE dose_logs SET notified = 1 WHERE id = ?', d.id);
    }
    require('./caregivers').alertMissedDoses(); // tell caregivers about doses missed by more than an hour
  } catch (e) {
    console.error('Reminder tick failed:', e.message);
  }
}

function start() {
  tick();
  setInterval(tick, 60_000).unref();
}

module.exports = { FREQUENCIES, PER_DAY, timesFor, createFromPrescription, materialize, today, adherence, mark, start };
