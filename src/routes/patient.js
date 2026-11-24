// Patient portal.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireRole, ah, notFound } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { distanceKm } = require('../services/geo');
const { classifySpecialties, classifyWithAI, rankDoctors, redFlags, SPECIALTIES } = require('../services/recommender');
const { uploader, handleUpload, relative } = require('../services/uploads');
const { extractText, parseMedicines } = require('../services/ocr');
const schedule = require('../services/schedule');
const reminders = require('../services/reminders');
const health = require('../services/health');
const reviews = require('../services/reviews');
const assistant = require('../services/assistant');
const analysis = require('../services/analysis');
const stats = require('../stats');

const router = express.Router();
router.use(requireRole('patient'));

const profileOf = (id) => db.get('SELECT * FROM patient_profiles WHERE user_id = ?', id) || {};
const centerStaff = (centerId) => db.all('SELECT user_id FROM center_members WHERE center_id = ?', centerId);
function addEvent(apptId, senderId, body, kind = 'event') {
  db.run('INSERT INTO appointment_messages (appointment_id, sender_id, kind, body) VALUES (?, ?, ?, ?)', apptId, senderId, kind, body);
  db.run('UPDATE appointments SET updated_at = ? WHERE id = ?', db.now(), apptId);
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const ACTIVE = "('requested','proposed','reschedule_requested','confirmed')";

function auditFor(patientId, limit = 6) {
  const TEXT = {
    'report.view': 'viewed', 'report.download': 'downloaded', 'report.uploaded': 'uploaded', 'report.shared': 'shared',
    'access.approved': 'approved access for', 'access.rejected': 'rejected access for', 'access.revoked': 'revoked access for', 'access.requested': 'requested access to',
    'records.list_viewed': 'opened the records list of',
  };
  return db.all(
    `SELECT l.*, u.full_name, u.role, c.name AS center_name, t.name AS test_name FROM audit_log l
       LEFT JOIN users u ON u.id = l.actor_id LEFT JOIN center_members m ON m.user_id = l.actor_id LEFT JOIN centers c ON c.id = m.center_id
       LEFT JOIN reports r ON l.entity = 'report' AND r.id = l.entity_id LEFT JOIN test_catalog t ON t.id = r.test_id
      WHERE l.patient_id = ? AND l.action IN (${Object.keys(TEXT).map(() => '?').join(',')}) ORDER BY l.id DESC LIMIT ?`,
    patientId, ...Object.keys(TEXT), limit
  ).map((l) => {
    const who = l.actor_id === patientId ? 'You' : l.role === 'center' ? (l.center_name || l.full_name) : l.full_name || 'System';
    const what = l.test_name ? `${l.test_name} report` : l.entity === 'access_request' || l.entity === 'access_grant' ? 'your reports' : 'your records';
    return { ...l, text: `${who} ${TEXT[l.action]} ${what}`, color: l.action.includes('upload') ? 'green' : l.action.includes('request') ? 'orange' : l.action.includes('revok') || l.action.includes('reject') ? 'red' : 'blue' };
  });
}

// =============== Dashboard ===============
router.get('/', (req, res) => {
  const id = req.user.id;
  const profile = profileOf(id);
  const appts = db.all(`SELECT a.*, u.full_name AS doctor_name, d.specialty FROM appointments a JOIN users u ON u.id = a.doctor_id JOIN doctor_profiles d ON d.user_id = a.doctor_id
                          WHERE a.patient_id = ? AND a.status IN ${ACTIVE} ORDER BY COALESCE(a.proposed_time, a.created_at)`, id);
  const next = appts.find((a) => a.status === 'confirmed' && new Date(a.proposed_time) > new Date());
  const awaiting = appts.filter((a) => a.status === 'proposed');
  const tests = db.all("SELECT o.*, t.name FROM test_orders o JOIN test_catalog t ON t.id = o.test_id WHERE o.patient_id = ? AND o.status IN ('prescribed','requested','scheduled','sample_collected')", id);
  const reports = db.all('SELECT r.*, t.name AS test_name, c.name AS center_name FROM reports r JOIN test_catalog t ON t.id = r.test_id JOIN centers c ON c.id = r.center_id WHERE r.patient_id = ? ORDER BY r.created_at DESC', id);
  const orders = db.all("SELECT o.*, p.name AS pharmacy FROM orders o JOIN pharmacies p ON p.id = o.pharmacy_id WHERE o.patient_id = ? AND o.status NOT IN ('delivered','rejected','cancelled') ORDER BY o.id DESC", id);
  const requests = db.all(`SELECT r.*, u.full_name AS doctor_name, t.name AS test_name FROM access_requests r JOIN users u ON u.id = r.doctor_id
                             LEFT JOIN reports rp ON rp.id = r.report_id LEFT JOIN test_catalog t ON t.id = rp.test_id WHERE r.patient_id = ? AND r.status = 'pending' ORDER BY r.id DESC`, id);
  const lastEntry = db.get('SELECT * FROM health_entries WHERE patient_id = ? ORDER BY id DESC LIMIT 1', id);
  const lastResult = lastEntry ? JSON.parse(lastEntry.result_json || '{}') : null;

  // Care journey: the latest events from the last 30 days.
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const journey = [
    ...db.all(`SELECT 'consult' AS k, a.proposed_time AS t, u.full_name AS who, a.reason AS what FROM appointments a JOIN users u ON u.id = a.doctor_id WHERE a.patient_id = ? AND a.status = 'completed' AND a.proposed_time >= ?`, id, since),
    ...db.all(`SELECT 'tests' AS k, MIN(o.created_at) AS t, u.full_name AS who, GROUP_CONCAT(t.name, ', ') AS what FROM test_orders o JOIN test_catalog t ON t.id = o.test_id LEFT JOIN users u ON u.id = o.doctor_id WHERE o.patient_id = ? AND o.created_at >= ? AND o.doctor_id IS NOT NULL GROUP BY o.appointment_id`, id, since),
    ...db.all(`SELECT 'report' AS k, r.created_at AS t, c.name AS who, t.name AS what FROM reports r JOIN centers c ON c.id = r.center_id JOIN test_catalog t ON t.id = r.test_id WHERE r.patient_id = ? AND r.created_at >= ?`, id, since),
    ...db.all(`SELECT 'order' AS k, o.created_at AS t, p.name AS who, o.status AS what FROM orders o JOIN pharmacies p ON p.id = o.pharmacy_id WHERE o.patient_id = ? AND o.created_at >= ?`, id, since),
  ].sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, 4).reverse();

  const lines = [];
  if (reports[0] && Date.now() - new Date(reports[0].created_at) < 7 * 86400000) lines.push(`Your ${reports[0].test_name} report is ready`);
  if (awaiting[0]) lines.push(`${awaiting[0].doctor_name} proposed a new consultation time`);
  if (requests[0]) lines.push(`${requests[0].doctor_name} asked to view your records`);
  const summary = lines.length ? `${lines.slice(0, 2).join(', and ')}. Review them below.` : 'Everything is up to date. Describe a health problem to find the right doctor.';

  const tile = (n, t) => stats.daily(`SELECT ${t} AS t FROM ${n} WHERE patient_id = ?`, [id]);
  const cards = [
    { href: '/patient/appointments', tile: 't-blue', icon: 'calendar', color: 'blue', label: 'Upcoming appointments', value: appts.length, sub: awaiting.length ? `${awaiting.length} awaiting your reply` : next ? `Next ${schedule.dateStr(new Date(next.proposed_time)) === schedule.dateStr(new Date()) ? 'today' : 'on ' + new Date(next.proposed_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'None booked', trend: tile('appointments', 'created_at') },
    { href: '/patient/tests', tile: 't-orange', icon: 'flask', color: 'orange', label: 'Pending tests', value: tests.length, sub: tests.map((t) => t.name).join(', ').slice(0, 40) || 'Nothing pending', trend: tile('test_orders', 'created_at') },
    { href: '/patient/records', tile: 't-teal', icon: 'file', color: 'teal', label: 'Reports ready', value: reports.filter((r) => Date.now() - new Date(r.created_at) < 30 * 86400000).length, sub: reports[0] ? `${reports[0].test_name} uploaded ${new Date(reports[0].created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'No reports yet', trend: tile('reports', 'created_at') },
    { href: '/patient/orders', tile: 't-purple', icon: 'pill', color: 'purple', label: 'Active orders', value: orders.length, sub: orders[0] ? require('../helpers').label(orders[0].status) : 'No active orders', trend: tile('orders', 'created_at') },
  ];
  const doses = reminders.today(id);
  res.render('patient/dashboard', { title: 'Dashboard', profile, next, cards, journey, requests, lastEntry, lastResult, summary, greeting: greeting(), doses });
});

// =============== AI doctor match ===============
function doctorCards(specialties, profile, filters = {}) {
  let list = rankDoctors({ specialties, patient: profile, maxFee: filters.maxFee, maxDistanceKm: filters.maxDistance });
  let fallback = false;
  if (!list.length && !filters.maxFee && !filters.maxDistance && !specialties.some((s) => s.specialty === 'General Medicine')) {
    list = rankDoctors({ specialties: [{ specialty: 'General Medicine', confidence: 0.5, matched: [] }], patient: profile });
    fallback = true;
  }
  const out = list.slice(0, 30).map((d) => ({ ...d, nextSlot: schedule.nextAvailable(d.user_id) }));
  out.fallback = fallback;
  return out;
}
const mapPoint = (d) => ({ id: `d${d.user_id}`, kind: 'doctor', live: !!d.live, lat: d.live ? d.live_lat : d.lat, lng: d.live ? d.live_lng : d.lng,
  popup: `<b>${require('../helpers').esc(d.full_name)}</b><br>${require('../helpers').esc(d.specialty)} · BDT ${d.fee}${d.live ? '<br><i>Live location</i>' : ''}` });
router.get('/find-doctor', (req, res) => {
  const profile = profileOf(req.user.id);
  const entry = req.query.entry ? db.get('SELECT * FROM health_entries WHERE id = ? AND patient_id = ?', req.query.entry, req.user.id) : null;
  const result = entry ? JSON.parse(entry.result_json) : null;
  const specialty = SPECIALTIES.includes(req.query.specialty) ? req.query.specialty : '';
  const filters = { maxFee: parseInt(req.query.maxFee, 10) || null, maxDistance: parseInt(req.query.maxDistance, 10) || null };
  let doctors = [];
  if (specialty) doctors = doctorCards([{ specialty, confidence: 1, matched: [] }], profile, filters);
  else if (result) doctors = doctorCards(result.specialties, profile, filters);
  const history = db.all('SELECT id, description, created_at FROM health_entries WHERE patient_id = ? ORDER BY id DESC LIMIT 5', req.user.id);
  const me = { lat: profile.live_lat ?? profile.lat, lng: profile.live_lng ?? profile.lng };
  const points = [...(me.lat != null ? [{ id: 'me', kind: 'me', lat: me.lat, lng: me.lng, label: 'You' }] : []), ...doctors.slice(0, 15).map(mapPoint)];
  res.render('patient/find-doctor', { title: 'Find the right doctor', entry, result, doctors, specialty, filters, SPECIALTIES, history, profile, points });
});
router.post('/find-doctor', ah(async (req, res) => {
  const description = String(req.body.description || '').trim().slice(0, 3000);
  if (description.length < 3) { req.flash('error', 'Describe your symptoms in Bangla or English, e.g. “চামড়ায় চুলকানি” or “broken arm”.'); return res.redirect('/patient/find-doctor'); }
  const entry = { current_problems: description };
  const { specialties, ai } = await classifyWithAI(description);
  const result = { specialties, ai, redFlags: redFlags(entry), terms: [...new Set(specialties.flatMap((s) => s.matched).filter((m) => m !== 'general assessment'))].slice(0, 6) };
  const { id } = db.run('INSERT INTO health_entries (patient_id, description, result_json) VALUES (?, ?, ?)', req.user.id, description, JSON.stringify(result));
  res.redirect(`/patient/find-doctor?entry=${id}#results`);
}));

router.get('/doctors/:id', (req, res) => {
  const doctor = db.get(`SELECT u.id, u.full_name, u.created_at, d.* FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE u.id = ? AND u.status = 'active' AND d.verified = 1`, req.params.id);
  if (!doctor) return notFound(res, 'Doctor');
  const profile = profileOf(req.user.id);
  doctor.live = doctor.share_location && doctor.live_lat != null && Date.now() - new Date(doctor.live_at || 0) < 30 * 60_000;
  const me = { lat: profile.live_lat ?? profile.lat, lng: profile.live_lng ?? profile.lng };
  doctor.distance = distanceKm(me.lat, me.lng, doctor.live ? doctor.live_lat : doctor.lat, doctor.live ? doctor.live_lng : doctor.lng);
  const points = [...(me.lat != null ? [{ id: 'me', kind: 'me', lat: me.lat, lng: me.lng, label: 'You' }] : []), mapPoint(doctor)];
  const thread = db.get("SELECT * FROM chat_threads WHERE patient_id = ? AND doctor_id = ? AND status IN ('pending','accepted') ORDER BY id DESC", req.user.id, doctor.user_id);
  const entry = req.query.entry ? db.get('SELECT * FROM health_entries WHERE id = ? AND patient_id = ?', req.query.entry, req.user.id) : null;
  const strip = schedule.dateStrip(doctor.user_id, 7);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : (strip.find((d) => d.open) || strip[0]).day;
  const { slots, off } = schedule.slotsFor(doctor.user_id, day);
  res.render('patient/doctor', { title: doctor.full_name, doctor, entry, strip, day, slots, off, hours: schedule.hours(doctor.user_id), WEEKDAYS: schedule.WEEKDAYS, points, thread });
});
router.get('/doctors/:id/location', (req, res) => {
  const d = db.get('SELECT u.full_name, d.* FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE u.id = ? AND d.verified = 1', req.params.id);
  if (!d) return res.status(404).json({ points: [] });
  d.live = d.share_location && d.live_lat != null && Date.now() - new Date(d.live_at || 0) < 30 * 60_000;
  res.json({ points: [mapPoint(d)] });
});
router.post('/doctors/:id/request', (req, res) => {
  const doctor = db.get(`SELECT u.id, u.full_name FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE u.id = ? AND u.status = 'active' AND d.verified = 1`, req.params.id);
  if (!doctor) return notFound(res, 'Doctor');
  const reason = String(req.body.reason || '').trim() || 'Consultation';
  if (req.body.slot && !schedule.isOpen(doctor.id, req.body.slot)) { req.flash('error', 'That slot was just taken. Please pick another time.'); return res.redirect(`/patient/doctors/${doctor.id}?day=${String(req.body.slot).slice(0, 10)}`); }
  const slot = req.body.slot && schedule.isOpen(doctor.id, req.body.slot) ? req.body.slot : null;
  if (!slot && !String(req.body.preferred_time || '').trim()) { req.flash('error', 'Pick an available slot, or describe a time that suits you.'); return res.redirect(`/patient/doctors/${doctor.id}`); }
  const pref = slot ? new Date(slot).toISOString() : String(req.body.preferred_time || '').slice(0, 200);
  const entry = req.body.health_entry_id ? db.get('SELECT id FROM health_entries WHERE id = ? AND patient_id = ?', req.body.health_entry_id, req.user.id) : null;
  const { id } = db.run('INSERT INTO appointments (patient_id, doctor_id, health_entry_id, reason, preferred_time, mode) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id, doctor.id, entry ? entry.id : null, reason.slice(0, 2000), pref || null, req.body.mode === 'online' ? 'online' : 'in_person');
  addEvent(id, req.user.id, `You sent a request to ${doctor.full_name}.`);
  notify(doctor.id, slot ? 'New slot booking to approve' : 'New appointment request', `${req.user.full_name}${slot ? ' booked ' + require('../helpers').friendly(pref) : ''}: ${reason.slice(0, 60)}`, `/doctor/requests?id=${id}`, 'appointment');
  req.flash('success', slot ? `Slot sent to ${doctor.full_name} for approval. You will get a notification when it is approved.` : `Request sent to ${doctor.full_name}. You will be notified when the doctor proposes a time.`);
  res.redirect(`/patient/appointments?id=${id}`);
});

// =============== Appointments ===============
function myAppt(req, id) {
  return db.get(`SELECT a.*, u.full_name AS doctor_name, u.phone AS doctor_phone, d.specialty, d.fee, d.address AS doctor_address FROM appointments a
                   JOIN users u ON u.id = a.doctor_id JOIN doctor_profiles d ON d.user_id = a.doctor_id WHERE a.id = ? AND a.patient_id = ?`, id, req.user.id);
}
router.get('/appointments', (req, res) => {
  const all = db.all(`SELECT a.*, u.full_name AS doctor_name, d.specialty, d.fee FROM appointments a JOIN users u ON u.id = a.doctor_id JOIN doctor_profiles d ON d.user_id = a.doctor_id
                        WHERE a.patient_id = ? ORDER BY a.updated_at DESC`, req.user.id);
  const active = all.filter((a) => ['requested', 'proposed', 'reschedule_requested', 'confirmed'].includes(a.status));
  const sel = (req.query.id && all.find((a) => a.id === Number(req.query.id))) || active.find((a) => a.status === 'proposed') || active[0] || all[0];
  let messages = [], strip = [], slots = [], day = null, off = null, alts = [];
  if (sel) {
    messages = db.all('SELECT m.*, u.full_name FROM appointment_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.appointment_id = ? ORDER BY m.id', sel.id);
    alts = sel.alt_times ? JSON.parse(sel.alt_times) : [];
    if (['proposed', 'confirmed', 'reschedule_requested'].includes(sel.status)) {
      strip = schedule.dateStrip(sel.doctor_id, 5);
      day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : (sel.proposed_time && schedule.dateStr(new Date(sel.proposed_time)) >= strip[0].day ? schedule.dateStr(new Date(sel.proposed_time)) : (strip.find((d) => d.open) || strip[0]).day);
      ({ slots, off } = schedule.slotsFor(sel.doctor_id, day, sel.id));
    }
  }
  const upcoming = active.filter((a) => a.status === 'confirmed').sort((x, y) => new Date(x.proposed_time) - new Date(y.proposed_time));
  const history = all.filter((a) => ['completed', 'declined', 'cancelled'].includes(a.status));
  const counts = { reply: active.filter((a) => a.status === 'proposed').length, confirmed: upcoming.length };
  res.render('patient/appointments', { title: 'Appointments', sel, messages, strip, slots, day, off, alts, upcoming, history, active, counts });
});
router.post('/appointments/:id/confirm', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || a.status !== 'proposed') return notFound(res, 'Proposed appointment');
  const options = [a.proposed_time, ...(a.alt_times ? JSON.parse(a.alt_times) : [])];
  const chosen = req.body.time && options.includes(req.body.time) ? req.body.time : a.proposed_time;
  db.run("UPDATE appointments SET status = 'confirmed', proposed_time = ?, alt_times = NULL, updated_at = ? WHERE id = ?", chosen, db.now(), a.id);
  addEvent(a.id, req.user.id, `You confirmed ${new Date(chosen).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`);
  notify(a.doctor_id, 'Appointment confirmed', `${req.user.full_name} confirmed the proposed time.`, `/doctor/appointments/${a.id}`, 'appointment');
  req.flash('success', 'Appointment confirmed. We will remind you before it starts.');
  res.redirect(`/patient/appointments?id=${a.id}`);
});
router.post('/appointments/:id/reschedule', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !['proposed', 'confirmed', 'reschedule_requested'].includes(a.status)) return notFound(res, 'Appointment');
  if (!req.body.slot || !schedule.isOpen(a.doctor_id, req.body.slot, a.id)) { req.flash('error', 'Choose one of the open times.'); return res.redirect(`/patient/appointments?id=${a.id}`); }
  const iso = new Date(req.body.slot).toISOString();
  db.run("UPDATE appointments SET status = 'reschedule_requested', preferred_time = ?, updated_at = ? WHERE id = ?", iso, db.now(), a.id);
  addEvent(a.id, req.user.id, `You asked for ${new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} instead.`);
  notify(a.doctor_id, 'Reschedule requested', `${req.user.full_name} asked for a different time.`, `/doctor/requests?id=${a.id}`, 'appointment');
  req.flash('success', 'Your preferred time was sent to the doctor.');
  res.redirect(`/patient/appointments?id=${a.id}`);
});
router.post('/appointments/:id/cancel', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !['requested', 'proposed', 'reschedule_requested', 'confirmed'].includes(a.status)) return notFound(res, 'Appointment');
  db.run("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?", db.now(), a.id);
  addEvent(a.id, req.user.id, 'You cancelled the appointment.');
  notify(a.doctor_id, 'Appointment cancelled', `${req.user.full_name} cancelled an appointment.`, `/doctor/appointments/${a.id}`, 'appointment');
  res.redirect(`/patient/appointments?id=${a.id}`);
});
router.post('/appointments/:id/message', (req, res) => {
  const a = myAppt(req, req.params.id);
  const body = String(req.body.body || '').trim();
  if (!a) return notFound(res, 'Appointment');
  if (body) {
    addEvent(a.id, req.user.id, body.slice(0, 2000), 'message');
    notify(a.doctor_id, 'New message', `${req.user.full_name}: ${body.slice(0, 80)}`, `/doctor/appointments/${a.id}`, 'appointment');
  }
  res.redirect(`/patient/appointments?id=${a.id}#messages`);
});

// =============== Medical tests ===============
function nearbyCenters(testId, profile) {
  return db.all(`SELECT c.*, ct.price, ct.report_time FROM centers c JOIN center_tests ct ON ct.center_id = c.id WHERE c.verified = 1 AND ct.test_id = ? AND ct.available = 1`, testId)
    .map((c) => ({ ...c, distance: distanceKm(profile.lat, profile.lng, c.lat, c.lng),
      tests: db.all('SELECT t.name FROM center_tests ct JOIN test_catalog t ON t.id = ct.test_id WHERE ct.center_id = ? AND ct.available = 1 LIMIT 4', c.id).map((x) => x.name) }))
    .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
}
router.get('/tests', (req, res) => {
  const id = req.user.id;
  const profile = profileOf(id);
  const tests = db.all(`SELECT o.*, t.name, t.category, u.full_name AS doctor_name, c.name AS center_name, (SELECT id FROM reports r WHERE r.test_order_id = o.id) AS report_id
                          FROM test_orders o JOIN test_catalog t ON t.id = o.test_id LEFT JOIN users u ON u.id = o.doctor_id LEFT JOIN centers c ON c.id = o.center_id
                         WHERE o.patient_id = ? AND o.status <> 'cancelled' ORDER BY (o.status = 'completed'), o.created_at DESC`, id);
  const bookable = tests.filter((t) => t.status === 'prescribed');
  const sel = (req.query.test && tests.find((t) => t.id === Number(req.query.test))) || bookable[0];
  const centers = sel ? nearbyCenters(sel.test_id, profile) : [];
  const request = db.get(`SELECT r.*, u.full_name AS doctor_name, t.name AS test_name FROM access_requests r JOIN users u ON u.id = r.doctor_id LEFT JOIN reports rp ON rp.id = r.report_id LEFT JOIN test_catalog t ON t.id = rp.test_id
                            WHERE r.patient_id = ? AND r.status = 'pending' ORDER BY r.id DESC`, id);
  const pending = tests.filter((t) => !['completed'].includes(t.status));
  const doctors = [...new Set(tests.filter((t) => t.doctor_name && t.status !== 'completed').map((t) => t.doctor_name))];
  const cards = [
    { href: '#prescribed', tile: 't-blue', icon: 'flask', color: 'blue', label: 'Prescribed tests', value: tests.filter((t) => t.doctor_id && Date.now() - new Date(t.created_at) < 30 * 86400000).length, sub: doctors.length ? `By ${doctors.join(', ')}` : 'In the last 30 days', trend: stats.daily('SELECT created_at AS t FROM test_orders WHERE patient_id = ?', [id]) },
    { href: '/patient/records', tile: 't-teal', icon: 'file', color: 'teal', label: 'Reports ready', value: tests.filter((t) => t.report_id).length, sub: tests.find((t) => t.report_id) ? `${tests.find((t) => t.report_id).name} uploaded` : 'None yet', trend: stats.daily('SELECT created_at AS t FROM reports WHERE patient_id = ?', [id]) },
    { href: '#prescribed', tile: 't-orange', icon: 'calendar', color: 'orange', label: 'Pending', value: pending.length, sub: pending.map((t) => t.name).join(', ').slice(0, 42) || 'Nothing pending', trend: stats.daily('SELECT updated_at AS t FROM test_orders WHERE patient_id = ?', [id]) },
  ];
  res.render('patient/tests', { title: 'Medical tests', tests, sel, centers, request, cards, log: auditFor(id, 3), profile });
});
router.post('/tests/:id/book', (req, res) => {
  const test = db.get('SELECT o.*, t.name FROM test_orders o JOIN test_catalog t ON t.id = o.test_id WHERE o.id = ? AND o.patient_id = ?', req.params.id, req.user.id);
  if (!test || test.status !== 'prescribed') return notFound(res, 'Bookable test');
  const c = db.get('SELECT c.*, ct.price, ct.online_booking AS tob FROM centers c JOIN center_tests ct ON ct.center_id = c.id WHERE c.id = ? AND c.verified = 1 AND ct.test_id = ? AND ct.available = 1', req.body.center_id, test.test_id);
  if (!c) return notFound(res, 'Center offering this test');
  if (!c.online_booking || !c.tob) { req.flash('error', `${c.name} does not take online bookings. Please call ${c.phone}.`); return res.redirect(`/patient/tests?test=${test.id}`); }
  db.run("UPDATE test_orders SET status = 'requested', center_id = ?, preferred_date = ?, price = ?, updated_at = ? WHERE id = ?", c.id, req.body.preferred_date || null, c.price, db.now(), test.id);
  for (const m of centerStaff(c.id)) notify(m.user_id, 'New test request', `${req.user.full_name} requested ${test.name}.`, '/center/requests', 'test');
  req.flash('success', `${test.name} requested at ${c.name}. The center will confirm a time.`);
  res.redirect('/patient/tests');
});
router.post('/tests/:id/cancel', (req, res) => {
  const t = db.get('SELECT o.*, tc.name FROM test_orders o JOIN test_catalog tc ON tc.id = o.test_id WHERE o.id = ? AND o.patient_id = ?', req.params.id, req.user.id);
  if (!t || !['requested', 'scheduled'].includes(t.status)) return notFound(res, 'Test booking');
  db.run("UPDATE test_orders SET status = 'prescribed', center_id = NULL, scheduled_at = NULL, price = NULL, updated_at = ? WHERE id = ?", db.now(), t.id);
  if (t.center_id) for (const m of centerStaff(t.center_id)) notify(m.user_id, 'Booking cancelled', `${req.user.full_name} cancelled ${t.name}.`, '/center/requests', 'test');
  req.flash('success', 'Booking cancelled. You can book another center.');
  res.redirect('/patient/tests');
});

// =============== Search several tests at once and compare centers ===============
/** For each verified center: which of the chosen tests it offers, regular and discounted totals, distance. */
function compareCenters(testIds, me) {
  if (!testIds.length) return [];
  const ph = testIds.map(() => '?').join(',');
  return db.all('SELECT * FROM centers WHERE verified = 1').map((c) => {
    const rows = db.all(`SELECT ct.*, t.name FROM center_tests ct JOIN test_catalog t ON t.id = ct.test_id WHERE ct.center_id = ? AND ct.available = 1 AND ct.test_id IN (${ph})`, c.id, ...testIds);
    const regular = rows.reduce((a, r) => a + r.price, 0);
    const final = rows.reduce((a, r) => a + Math.round(r.price * (1 - (r.discount_pct || 0) / 100)), 0);
    const distance = distanceKm(me.lat, me.lng, c.lat, c.lng);
    return { ...c, rows, has: rows.length, all: rows.length === testIds.length, missing: testIds.length - rows.length, regular, final, saved: regular - final,
      pct: regular ? Math.round(((regular - final) / regular) * 100) : 0, distance, slowest: rows.map((r) => r.report_time).sort().pop() };
  }).filter((c) => c.has > 0);
}
router.get('/tests/compare', (req, res) => {
  const profile = profileOf(req.user.id);
  const me = { lat: profile.live_lat ?? profile.lat, lng: profile.live_lng ?? profile.lng };
  const catalog = db.all('SELECT * FROM test_catalog ORDER BY category, name');
  let ids = [].concat(req.query.t || []).map(Number).filter((id) => catalog.some((c) => c.id === id));
  if (req.query.prescribed === '1') ids = db.all("SELECT DISTINCT test_id FROM test_orders WHERE patient_id = ? AND status = 'prescribed'", req.user.id).map((r) => r.test_id);
  const sort = ['nearest', 'cheapest', 'discount'].includes(req.query.sort) ? req.query.sort : 'nearest';
  const list = compareCenters(ids, me);
  const SORT = {
    nearest: (a, b) => (b.all - a.all) || ((a.distance ?? 999) - (b.distance ?? 999)),
    cheapest: (a, b) => (b.all - a.all) || (a.final - b.final),
    discount: (a, b) => (b.all - a.all) || (b.pct - a.pct) || (a.final - b.final),
  };
  list.sort(SORT[sort]);
  const full = list.filter((c) => c.all);
  const best = {
    nearest: [...full].sort(SORT.nearest)[0],
    cheapest: [...full].sort(SORT.cheapest)[0],
    discount: [...full].sort(SORT.discount)[0],
  };
  const points = [...(me.lat != null ? [{ id: 'me', kind: 'me', lat: me.lat, lng: me.lng, label: 'You' }] : []),
    ...list.slice(0, 12).map((c) => ({ id: `c${c.id}`, kind: 'center', lat: c.lat, lng: c.lng, popup: `<b>${require('../helpers').esc(c.name)}</b><br>BDT ${c.final} for ${c.has} test(s)` }))];
  const prescribed = db.all("SELECT DISTINCT test_id FROM test_orders WHERE patient_id = ? AND status = 'prescribed'", req.user.id).map((r) => r.test_id);
  res.render('patient/tests-compare', { title: 'Compare test prices', catalog, ids, list, sort, best, points, prescribed });
});
router.post('/tests/book-multi', (req, res) => {
  const ids = [].concat(req.body.t || []).map(Number);
  const profile = profileOf(req.user.id);
  const c = compareCenters(ids, { lat: profile.lat, lng: profile.lng }).find((x) => x.id === Number(req.body.center_id));
  if (!c) return notFound(res, 'Center offering these tests');
  if (!c.online_booking) { req.flash('error', `${c.name} takes bookings by phone only: ${c.phone}.`); return res.redirect(`/patient/tests/compare?${ids.map((i) => 't=' + i).join('&')}`); }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.preferred_date || '') ? req.body.preferred_date : null;
  let n = 0;
  db.tx(() => {
    for (const r of c.rows) {
      const price = Math.round(r.price * (1 - (r.discount_pct || 0) / 100));
      const rx = db.get("SELECT id FROM test_orders WHERE patient_id = ? AND test_id = ? AND status = 'prescribed' ORDER BY id LIMIT 1", req.user.id, r.test_id);
      if (rx) db.run("UPDATE test_orders SET status = 'requested', center_id = ?, preferred_date = ?, price = ?, updated_at = ? WHERE id = ?", c.id, date, price, db.now(), rx.id);
      else db.run("INSERT INTO test_orders (patient_id, test_id, status, center_id, preferred_date, price, notes) VALUES (?, ?, 'requested', ?, ?, ?, 'Booked by patient')", req.user.id, r.test_id, c.id, date, price);
      n++;
    }
  });
  for (const m of centerStaff(c.id)) notify(m.user_id, 'New test booking', `${req.user.full_name} booked ${n} test(s): ${c.rows.map((r) => r.name).join(', ')}.`, '/center/requests', 'test');
  req.flash('success', `${n} test${n > 1 ? 's' : ''} booked at ${c.name} for ${require('../helpers').money(c.final)}${c.saved ? ` (you save ${require('../helpers').money(c.saved)})` : ''}. The center will confirm the sample time.`);
  res.redirect('/patient/tests');
});

// =============== Records, sharing and access ===============
function grantsOf(id) {
  return db.all(`SELECT g.*, u.full_name AS doctor_name, t.name AS test_name FROM access_grants g JOIN users u ON u.id = g.doctor_id LEFT JOIN reports r ON r.id = g.report_id LEFT JOIN test_catalog t ON t.id = r.test_id
                  WHERE g.patient_id = ? AND g.revoked = 0 AND g.expires_at > ? ORDER BY g.expires_at`, id, db.now());
}
router.get('/records', (req, res) => {
  const id = req.user.id;
  const cat = ['Blood', 'Imaging', 'Cardiology'].includes(req.query.cat) ? req.query.cat : '';
  const reports = db.all(`SELECT r.*, t.name AS test_name, t.category, c.name AS center_name, u.full_name AS doctor_name FROM reports r JOIN test_catalog t ON t.id = r.test_id
                            JOIN centers c ON c.id = r.center_id LEFT JOIN users u ON u.id = r.doctor_id WHERE r.patient_id = ? ${cat ? 'AND t.category = ?' : ''} ORDER BY r.test_date DESC, r.id DESC`, id, ...(cat ? [cat] : []));
  const pendingTests = db.all(`SELECT o.*, t.name AS test_name, t.category, c.name AS center_name, u.full_name AS doctor_name FROM test_orders o JOIN test_catalog t ON t.id = o.test_id
                                 LEFT JOIN centers c ON c.id = o.center_id LEFT JOIN users u ON u.id = o.doctor_id WHERE o.patient_id = ? AND o.status NOT IN ('completed','cancelled') ${cat ? 'AND t.category = ?' : ''}`, id, ...(cat ? [cat] : []));
  const grants = grantsOf(id);
  const doctors = db.all(`SELECT u.id, u.full_name, d.specialty FROM users u JOIN doctor_profiles d ON d.user_id = u.id WHERE u.status = 'active' AND d.verified = 1
                           ORDER BY (u.id IN (SELECT doctor_id FROM appointments WHERE patient_id = ?)) DESC, u.full_name`, id);
  const all = db.get('SELECT COUNT(*) n, COUNT(DISTINCT center_id) c FROM reports WHERE patient_id = ?', id);
  const shared = grants.filter((g) => g.report_id);
  const soonest = grants[0];
  const cards = [
    { tile: 't-blue', icon: 'file', color: 'blue', label: 'Total reports', value: all.n, sub: `Across ${all.c} center${all.c === 1 ? '' : 's'}`, trend: stats.daily('SELECT created_at AS t FROM reports WHERE patient_id = ?', [id]) },
    { tile: 't-teal', icon: 'shield', color: 'teal', label: 'Shared reports', value: shared.length, sub: shared.length ? `With ${[...new Set(shared.map((g) => g.doctor_name))].join(', ')}` : 'Nothing shared', trend: stats.daily("SELECT created_at AS t FROM access_grants WHERE patient_id = ?", [id]) },
    { tile: 't-orange', icon: 'users', color: 'orange', label: 'Active access', value: [...new Set(grants.map((g) => g.doctor_id))].length, sub: soonest ? `Expires in ${Math.max(1, Math.ceil((new Date(soonest.expires_at) - Date.now()) / 86400000))} days` : 'No doctor has access', trend: stats.daily("SELECT created_at AS t FROM audit_log WHERE patient_id = ?", [id]) },
  ];
  res.render('patient/records', { title: 'Medical records', reports, pendingTests, grants, doctors, cards, cat, log: auditFor(id, 6), defaultDays: profileOf(id).default_access_days || 7 });
});
router.post('/records/share', (req, res) => {
  const ids = [].concat(req.body.report_ids || []).map(Number);
  const reports = ids.map((rid) => db.get('SELECT * FROM reports WHERE id = ? AND patient_id = ?', rid, req.user.id)).filter(Boolean);
  const doctor = db.get("SELECT id, full_name FROM users WHERE id = ? AND role = 'doctor' AND status = 'active'", req.body.doctor_id);
  if (!reports.length || !doctor) { req.flash('error', 'Select at least one report and a doctor.'); return res.redirect('/patient/records'); }
  const days = Math.min(Math.max(parseInt(req.body.days, 10) || 7, 1), 30);
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  for (const r of reports) {
    const { id } = db.run("INSERT INTO access_grants (doctor_id, patient_id, report_id, source, expires_at) VALUES (?, ?, ?, 'share', ?)", doctor.id, req.user.id, r.id, expires);
    audit(req, 'report.shared', { entity: 'report', entityId: r.id, patientId: req.user.id, details: { doctor: doctor.id, days, grant: id } });
  }
  notify(doctor.id, 'Reports shared with you', `${req.user.full_name} shared ${reports.length} report(s) for ${days} days.`, `/doctor/patients?id=${req.user.id}`, 'access');
  req.flash('success', `Shared ${reports.length} report${reports.length > 1 ? 's' : ''} with ${doctor.full_name} for ${days} days.`);
  res.redirect('/patient/records');
});
router.get('/access', (req, res) => {
  const id = req.user.id;
  const requests = db.all(`SELECT a.*, u.full_name AS doctor_name, d.specialty, t.name AS test_name FROM access_requests a JOIN users u ON u.id = a.doctor_id JOIN doctor_profiles d ON d.user_id = a.doctor_id
                             LEFT JOIN reports r ON r.id = a.report_id LEFT JOIN test_catalog t ON t.id = r.test_id WHERE a.patient_id = ? ORDER BY (a.status = 'pending') DESC, a.id DESC LIMIT 30`, id);
  res.render('patient/access', { title: 'Access requests', requests, grants: grantsOf(id), log: auditFor(id, 12) });
});
router.post('/access/:id/:decision(approve|reject)', (req, res) => {
  const r = db.get("SELECT * FROM access_requests WHERE id = ? AND patient_id = ? AND status = 'pending'", req.params.id, req.user.id);
  if (!r) return notFound(res, 'Access request');
  const approve = req.params.decision === 'approve';
  db.tx(() => {
    db.run('UPDATE access_requests SET status = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'rejected', db.now(), r.id);
    if (approve) db.run("INSERT INTO access_grants (doctor_id, patient_id, report_id, source, request_id, expires_at) VALUES (?, ?, ?, 'request', ?, ?)",
      r.doctor_id, r.patient_id, r.report_id, r.id, new Date(Date.now() + r.duration_hours * 3600000).toISOString());
  });
  audit(req, approve ? 'access.approved' : 'access.rejected', { entity: 'access_request', entityId: r.id, patientId: req.user.id });
  notify(r.doctor_id, approve ? 'Access approved' : 'Access request declined',
    approve ? `${req.user.full_name} approved access for ${r.duration_hours >= 48 ? Math.round(r.duration_hours / 24) + ' days' : r.duration_hours + ' hours'}.` : `${req.user.full_name} declined your request.`, `/doctor/patients?id=${req.user.id}`, 'access');
  req.flash('success', approve ? 'Access approved. It ends automatically and you can revoke it anytime.' : 'Request rejected.');
  res.redirect(String(req.get('referer') || '').includes('/patient') ? req.get('referer') : '/patient/access');
});
router.post('/grants/:id/revoke', (req, res) => {
  const g = db.get('SELECT * FROM access_grants WHERE id = ? AND patient_id = ?', req.params.id, req.user.id);
  if (!g) return notFound(res, 'Access');
  db.run('UPDATE access_grants SET revoked = 1 WHERE id = ?', g.id);
  audit(req, 'access.revoked', { entity: 'access_grant', entityId: g.id, patientId: req.user.id });
  notify(g.doctor_id, 'Access revoked', `${req.user.full_name} revoked your access to their records.`, '/doctor/access', 'access');
  req.flash('success', 'Access revoked.');
  res.redirect(String(req.get('referer') || '').includes('/patient') ? req.get('referer') : '/patient/records');
});

// =============== Order medicine ===============
const rxUpload = uploader('prescriptions');
function itemsOf(rxId) {
  return db.all('SELECT i.*, m.name, m.strength, m.form, m.rx_required FROM prescription_items i LEFT JOIN medicines m ON m.id = i.medicine_id WHERE i.prescription_id = ? ORDER BY i.id', rxId);
}
/** For each verified pharmacy: what it can supply for these items, the total, distance and rating. */
function pharmacyOptions(items, profile) {
  const wanted = items.filter((i) => i.medicine_id);
  return db.all("SELECT p.* FROM pharmacies p JOIN users u ON u.id = p.admin_user_id WHERE p.verified = 1 AND u.status = 'active'")
    .map((p) => {
      const lines = wanted.map((i) => {
        const s = db.get('SELECT price, quantity FROM pharmacy_stock WHERE pharmacy_id = ? AND medicine_id = ? AND deliverable = 1', p.id, i.medicine_id);
        const available = s ? Math.min(s.quantity, i.quantity) : 0;
        return { item: i, price: s ? s.price : null, stock: s ? s.quantity : 0, available, full: !!s && s.quantity >= i.quantity };
      });
      const availableCount = lines.filter((l) => l.available > 0).length;
      const subtotal = lines.reduce((s, l) => s + (l.price || 0) * l.available, 0);
      const distance = distanceKm(profile.lat, profile.lng, p.lat, p.lng);
      const eta = p.delivery_minutes + (distance ? Math.round(distance * 4) : 0);
      return { ...p, lines, availableCount, allAvailable: wanted.length > 0 && lines.every((l) => l.full), subtotal, total: subtotal + p.delivery_fee, distance, eta, rating: reviews.summary(p.id) };
    })
    .filter((p) => p.availableCount > 0)
    .sort((a, b) => b.availableCount - a.availableCount || (a.distance ?? 99) - (b.distance ?? 99))
    .slice(0, 6);
}
router.get('/order', (req, res) => {
  const id = req.user.id;
  const profile = profileOf(id);
  const prescriptions = db.all(`SELECT p.*, u.full_name AS doctor_name, (SELECT COUNT(*) FROM prescription_items i WHERE i.prescription_id = p.id) AS n FROM prescriptions p LEFT JOIN users u ON u.id = p.doctor_id WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT 6`, id);
  const rx = req.query.rx ? db.get('SELECT p.*, u.full_name AS doctor_name FROM prescriptions p LEFT JOIN users u ON u.id = p.doctor_id WHERE p.id = ? AND p.patient_id = ?', req.query.rx, id) : null;
  const items = rx ? itemsOf(rx.id) : [];
  const options = rx ? pharmacyOptions(items, profile) : [];
  const active = db.get("SELECT o.*, p.name AS pharmacy FROM orders o JOIN pharmacies p ON p.id = o.pharmacy_id WHERE o.patient_id = ? AND o.status NOT IN ('delivered','rejected','cancelled') ORDER BY o.id DESC", id);
  res.render('patient/order', { title: 'Order medicine', rx, items, options, prescriptions, active, profile });
});
router.post('/order/upload', handleUpload(rxUpload.single('file'), '/patient/order'), ah(async (req, res) => {
  const typed = String(req.body.typed || '').trim();
  if (!req.file && !typed) { req.flash('error', 'Upload a prescription photo or type the medicines.'); return res.redirect('/patient/order'); }
  let ocrText = '', ocrError = null;
  if (req.file) ({ text: ocrText, error: ocrError } = await extractText(req.file.path, req.file.mimetype));
  const items = parseMedicines([ocrText, typed].filter(Boolean).join('\n'));
  const rxId = db.tx(() => {
    const { id } = db.run("INSERT INTO prescriptions (patient_id, source, image_path, original_name, ocr_text, notes) VALUES (?, 'upload', ?, ?, ?, ?)",
      req.user.id, req.file ? relative(req.file.path) : null, req.file ? req.file.originalname : null, ocrText || null, typed || null);
    for (const i of items) db.run('INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, quantity) VALUES (?, ?, ?, ?, ?)', id, i.medicine_id, i.raw_name, i.dose, i.quantity);
    return id;
  });
  if (ocrError) req.flash('error', ocrError);
  req.flash('success', `Prescription saved. We found ${items.filter((i) => i.medicine_id).length} medicine(s). Check the list, then compare pharmacies.`);
  res.redirect(`/patient/order?rx=${rxId}`);
}));
router.post('/order/:rx/items', (req, res) => {
  const rx = db.get("SELECT * FROM prescriptions WHERE id = ? AND patient_id = ? AND source = 'upload'", req.params.rx, req.user.id);
  if (!rx) return notFound(res, 'Editable prescription');
  const items = parseMedicines(req.body.lines);
  db.tx(() => {
    db.run('DELETE FROM prescription_items WHERE prescription_id = ?', rx.id);
    for (const i of items) db.run('INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, quantity) VALUES (?, ?, ?, ?, ?)', rx.id, i.medicine_id, i.raw_name, i.dose, i.quantity);
  });
  req.flash('success', 'Medicine list updated.');
  res.redirect(`/patient/order?rx=${rx.id}`);
});
router.post('/order', (req, res) => {
  const profile = profileOf(req.user.id);
  const rx = db.get('SELECT * FROM prescriptions WHERE id = ? AND patient_id = ?', req.body.rx, req.user.id);
  if (!rx) return notFound(res, 'Prescription');
  const option = pharmacyOptions(itemsOf(rx.id), profile).find((o) => o.id === Number(req.body.pharmacy_id));
  if (!option) return notFound(res, 'Pharmacy with these medicines');
  const method = req.body.payment_method === 'online' ? 'online' : 'cod';
  if ((method === 'cod' && !option.accepts_cod) || (method === 'online' && !option.accepts_online)) { req.flash('error', `${option.name} does not accept ${method === 'cod' ? 'cash on delivery' : 'online payment'}. Choose the other option.`); return res.redirect(`/patient/order?rx=${rx.id}`); }
  const address = String(req.body.delivery_address || profile.address || '').trim();
  if (!address) { req.flash('error', 'Add a delivery address.'); return res.redirect(`/patient/order?rx=${rx.id}`); }
  const lines = option.lines.filter((l) => l.available > 0);
  const subtotal = lines.reduce((s, l) => s + l.price * l.available, 0);
  const orderId = db.tx(() => {
    const { id } = db.run(`INSERT INTO orders (patient_id, pharmacy_id, prescription_id, payment_method, delivery_address, delivery_fee, total, prescription_checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, option.id, rx.id, method, address.slice(0, 300), option.delivery_fee, subtotal + option.delivery_fee, rx.verified ? 1 : 0);
    for (const l of lines) db.run('INSERT INTO order_items (order_id, medicine_id, quantity, unit_price) VALUES (?, ?, ?, ?)', id, l.item.medicine_id, l.available, l.price);
    db.run("INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'received', 'Order placed by patient')", id);
    return id;
  });
  notify(option.admin_user_id, 'New medicine order', `${req.user.full_name} ordered ${lines.length} medicine(s).`, `/pharmacy/orders/${orderId}`, 'order');
  req.flash('success', `Order placed with ${option.name}. You will be notified at every step.`);
  res.redirect(`/patient/orders/${orderId}`);
});

// =============== Medicine shop: cart -> best pharmacy -> checkout ===============
const BANKS = ['Dutch-Bangla Bank', 'BRAC Bank', 'City Bank', 'Islami Bank', 'Eastern Bank', 'Sonali Bank', 'Prime Bank', 'Mutual Trust Bank'];
const WALLETS = ['bKash', 'Nagad', 'Rocket', 'Upay'];
const cartOf = (req) => (req.session.cart = req.session.cart || {});
function cartItems(req) {
  const cart = cartOf(req);
  const ids = Object.keys(cart).map(Number).filter(Boolean);
  if (!ids.length) return [];
  return db.all(`SELECT * FROM medicines WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`, ...ids).map((m) => ({ ...m, medicine_id: m.id, quantity: cart[m.id] }));
}
const discOf = (stock, p) => Math.max(stock.discount_pct || 0, p.discount_pct || 0);
/** Pharmacies ranked for a cart: those with every item first, then by distance / price / discount. */
function shopOptions(items, me, sort = 'nearest') {
  const list = db.all("SELECT p.* FROM pharmacies p JOIN users u ON u.id = p.admin_user_id WHERE p.verified = 1 AND u.status = 'active'").map((p) => {
    const lines = items.map((i) => {
      const st = db.get('SELECT * FROM pharmacy_stock WHERE pharmacy_id = ? AND medicine_id = ? AND deliverable = 1', p.id, i.medicine_id);
      const d = st ? discOf(st, p) : 0;
      const unit = st ? Math.round(st.price * (1 - d / 100) * 100) / 100 : null;
      return { item: i, stock: st ? st.quantity : 0, price: st ? st.price : null, unit, discount: d, full: !!st && st.quantity >= i.quantity, available: st ? Math.min(st.quantity, i.quantity) : 0 };
    });
    const regular = lines.reduce((a, l) => a + (l.price || 0) * l.available, 0);
    const subtotal = Math.round(lines.reduce((a, l) => a + (l.unit || 0) * l.available, 0));
    const distance = distanceKm(me.lat, me.lng, p.lat, p.lng);
    return { ...p, lines, has: lines.filter((l) => l.available > 0).length, all: lines.every((l) => l.full), regular: Math.round(regular), subtotal, saved: Math.round(regular) - subtotal,
      pct: regular ? Math.round(((regular - subtotal) / regular) * 100) : 0, distance, eta: p.delivery_minutes + (distance ? Math.round(distance * 4) : 0),
      etaEmergency: p.emergency_minutes + (distance ? Math.round(distance * 2) : 0), rating: reviews.summary(p.id) };
  }).filter((p) => p.has > 0);
  const SORT = {
    nearest: (a, b) => (b.all - a.all) || (b.has - a.has) || ((a.distance ?? 99) - (b.distance ?? 99)),
    cheapest: (a, b) => (b.all - a.all) || (b.has - a.has) || (a.subtotal + a.delivery_fee - b.subtotal - b.delivery_fee),
    discount: (a, b) => (b.all - a.all) || (b.has - a.has) || (b.pct - a.pct),
  };
  return list.sort(SORT[sort] || SORT.nearest);
}
const meLoc = (profile) => ({ lat: profile.live_lat ?? profile.lat, lng: profile.live_lng ?? profile.lng });

router.get('/shop', (req, res) => {
  const q = String(req.query.q || '').trim();
  const meds = db.all(`SELECT m.*, MIN(s.price) AS min_price, MAX(s.price) AS max_price, COUNT(s.id) AS shops, SUM(s.quantity) AS total, MAX(MAX(s.discount_pct, p.discount_pct)) AS best_discount
                         FROM medicines m LEFT JOIN pharmacy_stock s ON s.medicine_id = m.id AND s.quantity > 0 AND s.deliverable = 1
                         LEFT JOIN pharmacies p ON p.id = s.pharmacy_id AND p.verified = 1
                        WHERE (? = '' OR m.name LIKE ? OR m.brand LIKE ?) GROUP BY m.id ORDER BY m.name`, q, `%${q}%`, `%${q}%`);
  const items = cartItems(req);
  res.render('patient/shop', { title: 'Medicine shop', meds, q, cart: cartOf(req), count: items.reduce((a, i) => a + i.quantity, 0) });
});
router.post('/shop/cart', (req, res) => {
  const cart = cartOf(req);
  const m = db.get('SELECT id, name FROM medicines WHERE id = ?', req.body.medicine_id);
  const qty = Math.min(500, Math.max(0, parseInt(req.body.qty, 10) || 0));
  if (m) {
    if (req.body.set === '1') { if (qty) cart[m.id] = qty; else delete cart[m.id]; }
    else cart[m.id] = Math.min(500, (cart[m.id] || 0) + (qty || 1));
    if (req.body.set !== '1') req.flash('success', `${m.name} added to cart.`);
  }
  res.redirect(req.body.back === 'cart' ? '/patient/shop/cart' : `/patient/shop${req.body.q ? '?q=' + encodeURIComponent(req.body.q) : ''}#m${m ? m.id : ''}`);
});
router.post('/shop/cart/clear', (req, res) => { req.session.cart = {}; res.redirect('/patient/shop'); });
router.get('/shop/cart', (req, res) => {
  const profile = profileOf(req.user.id);
  const items = cartItems(req);
  const sort = ['nearest', 'cheapest', 'discount'].includes(req.query.sort) ? req.query.sort : 'nearest';
  const options = items.length ? shopOptions(items, meLoc(profile), sort) : [];
  const me = meLoc(profile);
  const points = [...(me.lat != null ? [{ id: 'me', kind: 'me', lat: me.lat, lng: me.lng, label: 'You' }] : []),
    ...options.slice(0, 10).map((p) => ({ id: `p${p.id}`, kind: 'pharmacy', lat: p.lat, lng: p.lng, popup: `<b>${require('../helpers').esc(p.name)}</b><br>${p.has}/${items.length} items · BDT ${p.subtotal}` }))];
  res.render('patient/cart', { title: 'Cart', items, options, sort, points });
});
router.get('/shop/checkout', (req, res) => {
  const profile = profileOf(req.user.id);
  const items = cartItems(req);
  if (!items.length) return res.redirect('/patient/shop');
  const option = shopOptions(items, meLoc(profile)).find((o) => o.id === Number(req.query.pharmacy));
  if (!option) return notFound(res, 'Pharmacy with your medicines');
  const prescriptions = db.all('SELECT p.*, u.full_name AS doctor_name FROM prescriptions p LEFT JOIN users u ON u.id = p.doctor_id WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT 8', req.user.id);
  const me = meLoc(profile);
  const points = [...(me.lat != null ? [{ id: 'me', kind: 'me', lat: me.lat, lng: me.lng, label: 'Delivery here' }] : []), { id: 'shop', kind: 'pharmacy', lat: option.lat, lng: option.lng, label: option.name }];
  res.render('patient/checkout', { title: 'Checkout', items, option, profile, prescriptions, needsRx: items.some((i) => i.rx_required), BANKS, WALLETS, points, me });
});
router.post('/shop/checkout', handleUpload(rxUpload.single('rx_file'), (req) => `/patient/shop/checkout?pharmacy=${req.query.pharmacy || ''}`), ah(async (req, res) => {
  const profile = profileOf(req.user.id);
  const items = cartItems(req);
  const b = req.body;
  const back = `/patient/shop/checkout?pharmacy=${b.pharmacy_id}`;
  if (!items.length) return res.redirect('/patient/shop');
  const lat = Number(b.lat), lng = Number(b.lng);
  const loc = b.lat !== '' && Number.isFinite(lat) ? { lat, lng } : meLoc(profile);
  const option = shopOptions(items, loc).find((o) => o.id === Number(b.pharmacy_id));
  if (!option) return notFound(res, 'Pharmacy');
  const address = String(b.delivery_address || '').trim();
  const errors = [];
  if (!address) errors.push('Add a delivery address.');
  const type = b.order_type === 'emergency' ? 'emergency' : 'regular';
  const channel = ['cod', 'bank', 'mobile', 'card'].includes(b.payment) ? b.payment : 'cod';
  let provider = null, hint = null;
  if (channel === 'cod' && !option.accepts_cod) errors.push(`${option.name} does not take cash on delivery.`);
  if (channel !== 'cod' && !option.accepts_online) errors.push(`${option.name} does not take online payment.`);
  if (channel === 'bank') { provider = BANKS.includes(b.bank) ? b.bank : null; hint = String(b.bank_account || '').replace(/\D/g, '').slice(-4); if (!provider || hint.length < 4) errors.push('Choose your bank and enter the account number.'); }
  if (channel === 'mobile') { provider = WALLETS.includes(b.wallet) ? b.wallet : null; const n = String(b.wallet_number || '').replace(/\D/g, ''); hint = n.slice(-4); if (!provider || !/^01\d{9}$/.test(n)) errors.push('Choose bKash, Nagad, Rocket or Upay and enter your 11-digit wallet number.'); }
  if (channel === 'card') {
    const n = String(b.card_number || '').replace(/\D/g, '');
    const luhn = (num) => num.split('').reverse().reduce((s, d, i) => { let x = Number(d); if (i % 2) { x *= 2; if (x > 9) x -= 9; } return s + x; }, 0) % 10 === 0;
    const [mm, yy] = String(b.card_expiry || '').split('/').map((x) => parseInt(x, 10));
    const exp = mm >= 1 && mm <= 12 && yy >= 0 ? new Date(2000 + yy, mm, 1) : null;
    provider = /^4/.test(n) ? 'Visa' : /^5[1-5]|^2[2-7]/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'American Express' : 'Card';
    hint = n.slice(-4);
    if (n.length < 13 || !luhn(n)) errors.push('Card number is not valid.');
    if (!exp || exp < new Date()) errors.push('Card expiry must be a future month (MM/YY).');
    if (!/^\d{3,4}$/.test(String(b.card_cvv || ''))) errors.push('Enter the 3 or 4 digit CVV.');
  }
  if (errors.length) { req.flash('error', errors.join(' ')); return res.redirect(back); }

  // Prescription: pick a saved one, upload a new photo, or none (the pharmacy checks Rx-only medicines).
  let rxId = b.prescription_id ? (db.get('SELECT id FROM prescriptions WHERE id = ? AND patient_id = ?', b.prescription_id, req.user.id) || {}).id : null;
  if (req.file) {
    const { text } = await extractText(req.file.path, req.file.mimetype);
    rxId = db.run("INSERT INTO prescriptions (patient_id, source, image_path, original_name, ocr_text) VALUES (?, 'upload', ?, ?, ?)", req.user.id, relative(req.file.path), req.file.originalname, text || null).id;
  }
  const lines = option.lines.filter((l) => l.available > 0);
  const fee = type === 'emergency' ? option.emergency_fee : option.delivery_fee;
  const subtotal = Math.round(lines.reduce((a, l) => a + l.unit * l.available, 0));
  const total = subtotal + fee;
  const method = channel === 'cod' ? 'cod' : 'online';
  const orderId = db.tx(() => {
    const { id } = db.run(`INSERT INTO orders (patient_id, pharmacy_id, prescription_id, payment_method, payment_channel, payment_provider, payment_status, delivery_address, delivery_fee, total, order_type, lat, lng, discount)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.id, option.id, rxId || null, method, channel, provider, method === 'online' ? 'paid' : 'unpaid',
    address.slice(0, 300), fee, total, type, loc.lat, loc.lng, option.saved);
    for (const l of lines) db.run('INSERT INTO order_items (order_id, medicine_id, quantity, unit_price) VALUES (?, ?, ?, ?)', id, l.item.medicine_id, l.available, l.unit);
    db.run("INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'received', ?)", id, `${type === 'emergency' ? 'EMERGENCY order' : 'Order'} placed · ${channel === 'cod' ? 'cash on delivery' : provider + ' payment'}`);
    if (method === 'online') {
      const txn = `${{ bank: 'BNK', mobile: provider.slice(0, 3).toUpperCase(), card: 'CRD' }[channel]}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;
      db.run('INSERT INTO payments (order_id, channel, provider, account_hint, amount, txn_id) VALUES (?, ?, ?, ?, ?, ?)', id, channel, provider, hint, total, txn);
    }
    return id;
  });
  req.session.cart = {};
  notify(option.admin_user_id, type === 'emergency' ? 'EMERGENCY medicine order' : 'New medicine order', `${req.user.full_name} ordered ${lines.length} medicine(s) · ${require('../helpers').money(total)}.`, `/pharmacy/orders/${orderId}`, 'order');
  audit(req, 'order.placed', { entity: 'order', entityId: orderId, patientId: req.user.id, details: { channel, type } });
  req.flash('success', `Order placed with ${option.name}${method === 'online' ? ` and paid by ${provider}` : ''}. ${type === 'emergency' ? 'Emergency delivery' : 'Delivery'} in about ${type === 'emergency' ? option.etaEmergency : option.eta} minutes.`);
  res.redirect(`/patient/orders/${orderId}`);
}));

// =============== Health analysis from documents (bar charts + prediction) ===============
const docUploadH = uploader('health-docs');
router.get('/analysis', (req, res) => {
  const id = req.user.id;
  const a = analysis.analyze(id, Math.min(12, Math.max(3, parseInt(req.query.months, 10) || 6)));
  const docs = db.all('SELECT d.*, (SELECT COUNT(*) FROM health_markers m WHERE m.document_id = d.id) AS n FROM health_documents d WHERE d.patient_id = ? ORDER BY d.doc_date DESC, d.id DESC', id);
  const doc = req.query.doc ? db.get('SELECT * FROM health_documents WHERE id = ? AND patient_id = ?', req.query.doc, id) : null;
  const docValues = doc ? Object.fromEntries(db.all('SELECT marker, value FROM health_markers WHERE document_id = ?', doc.id).map((m) => [m.marker, m.value])) : {};
  const sel = a.markers.find((m) => m.key === req.query.m) || a.markers[0] || null;
  const importable = db.get('SELECT COUNT(*) n FROM reports r WHERE r.patient_id = ? AND NOT EXISTS (SELECT 1 FROM health_documents d WHERE d.report_id = r.id)', id).n;
  res.render('patient/analysis', { title: 'Health analysis', a, docs, doc, docValues, sel, MARKERS: analysis.MARKERS, months: a.keys.length, importable });
});
router.post('/analysis/upload', handleUpload(docUploadH.single('file'), '/patient/analysis'), ah(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120) || (req.file ? req.file.originalname : 'Health record');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.doc_date || '') && new Date(req.body.doc_date) <= new Date() ? req.body.doc_date : new Date().toISOString().slice(0, 10);
  let text = String(req.body.text || '').slice(0, 5000), error = null;
  if (req.file) { const r = await analysis.readText(req.file.path, req.file.mimetype); text = [r.text, text].filter(Boolean).join('\n'); error = r.error; }
  const values = analysis.parseValues(text);
  const docId = db.tx(() => {
    const { id } = db.run('INSERT INTO health_documents (patient_id, title, doc_date, file_path, original_name, mime_type, size, extracted_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      req.user.id, title, date, req.file ? relative(req.file.path) : null, req.file ? req.file.originalname : null, req.file ? req.file.mimetype : null, req.file ? req.file.size : null, text.slice(0, 20000) || null);
    for (const v of values) db.run('INSERT INTO health_markers (patient_id, document_id, marker, value, measured_on) VALUES (?, ?, ?, ?, ?)', req.user.id, id, v.marker, v.value, date);
    return id;
  });
  if (error) req.flash('error', error);
  req.flash('success', values.length ? `Found ${values.length} value${values.length > 1 ? 's' : ''} in “${title}”. Check them below; the charts are updated.` : 'Document saved. No values were found automatically; type them below.');
  res.redirect(`/patient/analysis?doc=${docId}#review`);
}));
router.post('/analysis/doc/:id/values', (req, res) => {
  const d = db.get('SELECT * FROM health_documents WHERE id = ? AND patient_id = ?', req.params.id, req.user.id);
  if (!d) return notFound(res, 'Document');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.doc_date || '') ? req.body.doc_date : d.doc_date;
  db.tx(() => {
    db.run('UPDATE health_documents SET doc_date = ? WHERE id = ?', date, d.id);
    db.run('DELETE FROM health_markers WHERE document_id = ?', d.id);
    for (const key of Object.keys(analysis.MARKERS)) {
      const v = Number(String(req.body[key] ?? '').replace(',', '.'));
      if (req.body[key] !== '' && req.body[key] !== undefined && Number.isFinite(v) && v > 0) db.run('INSERT INTO health_markers (patient_id, document_id, marker, value, measured_on) VALUES (?, ?, ?, ?, ?)', req.user.id, d.id, key, v, date);
    }
  });
  req.flash('success', 'Values saved. Your charts and prediction are updated.');
  res.redirect('/patient/analysis');
});
router.post('/analysis/doc/:id/delete', (req, res) => {
  db.run('DELETE FROM health_documents WHERE id = ? AND patient_id = ?', req.params.id, req.user.id);
  req.flash('success', 'Document removed from the analysis.');
  res.redirect('/patient/analysis');
});
// Bring lab reports that diagnostic centers uploaded into the analysis.
router.post('/analysis/import-reports', ah(async (req, res) => {
  const reports = db.all('SELECT r.*, t.name AS test_name FROM reports r JOIN test_catalog t ON t.id = r.test_id WHERE r.patient_id = ? AND NOT EXISTS (SELECT 1 FROM health_documents d WHERE d.report_id = r.id)', req.user.id);
  let found = 0;
  for (const r of reports) {
    const file = require('path').join(config.uploadDir, r.file_path);
    const { text } = require('fs').existsSync(file) ? await analysis.readText(file, r.mime_type || 'application/pdf') : { text: '' };
    const values = analysis.parseValues([text, r.summary].filter(Boolean).join('\n'));
    const date = String(r.test_date).slice(0, 10);
    db.tx(() => {
      const { id } = db.run('INSERT INTO health_documents (patient_id, title, doc_date, original_name, mime_type, extracted_text, report_id) VALUES (?, ?, ?, ?, ?, ?, ?)', req.user.id, `${r.test_name} report`, date, r.original_name, r.mime_type, text.slice(0, 20000) || null, r.id);
      for (const v of values) db.run('INSERT INTO health_markers (patient_id, document_id, marker, value, measured_on) VALUES (?, ?, ?, ?, ?)', req.user.id, id, v.marker, v.value, date);
    });
    found += values.length;
  }
  req.flash('success', `${reports.length} lab report${reports.length === 1 ? '' : 's'} imported, ${found} value${found === 1 ? '' : 's'} found.`);
  res.redirect('/patient/analysis');
}));

// =============== Order history and tracking ===============
router.get('/orders', (req, res) => {
  const id = req.user.id;
  const f = ['active', 'delivered', 'cancelled'].includes(req.query.f) ? req.query.f : 'all';
  const where = { all: '', active: "AND o.status NOT IN ('delivered','rejected','cancelled')", delivered: "AND o.status = 'delivered'", cancelled: "AND o.status IN ('rejected','cancelled')" }[f];
  const orders = db.all(`SELECT o.*, p.name AS pharmacy, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS n,
                           (SELECT 1 FROM pharmacy_reviews r WHERE r.order_id = o.id) AS reviewed FROM orders o JOIN pharmacies p ON p.id = o.pharmacy_id WHERE o.patient_id = ? ${where} ORDER BY o.id DESC`, id);
  const prescriptions = db.all(`SELECT p.*, u.full_name AS doctor_name, (SELECT COUNT(*) FROM prescription_items i WHERE i.prescription_id = p.id) AS n,
                                  (SELECT COUNT(*) FROM test_orders t WHERE t.prescription_id = p.id) AS tests FROM prescriptions p LEFT JOIN users u ON u.id = p.doctor_id WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT 6`, id);
  const c = db.get(`SELECT COUNT(*) total, SUM(status = 'delivered') delivered, SUM(status NOT IN ('delivered','rejected','cancelled')) active FROM orders WHERE patient_id = ?`, id);
  const active = db.get("SELECT status FROM orders WHERE patient_id = ? AND status NOT IN ('delivered','rejected','cancelled') ORDER BY id DESC", id);
  const cards = [
    { tile: 't-blue', icon: 'pill', color: 'blue', label: 'Total orders', value: c.total, sub: 'Since you joined', trend: stats.daily('SELECT created_at AS t FROM orders WHERE patient_id = ?', [id]) },
    { tile: 't-teal', icon: 'shield', color: 'teal', label: 'Delivered', value: c.delivered || 0, sub: 'No issues', trend: stats.daily("SELECT updated_at AS t FROM orders WHERE patient_id = ? AND status = 'delivered'", [id]) },
    { tile: 't-purple', icon: 'message', color: 'purple', label: 'Active order', value: c.active || 0, sub: active ? require('../helpers').label(active.status) : 'None', trend: stats.daily('SELECT created_at AS t FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE patient_id = ?)', [id]) },
    { tile: 't-orange', icon: 'file', color: 'orange', label: 'Prescriptions', value: db.get('SELECT COUNT(*) n FROM prescriptions WHERE patient_id = ?', id).n, sub: 'Saved in your records', trend: stats.daily('SELECT created_at AS t FROM prescriptions WHERE patient_id = ?', [id]) },
  ];
  res.render('patient/orders', { title: 'Order history', orders, prescriptions, cards, f });
});
function myOrder(req) {
  return db.get(`SELECT o.*, p.name AS pharmacy, p.phone AS pharmacy_phone, p.admin_user_id, p.delivery_minutes, p.lat AS plat, p.lng AS plng FROM orders o JOIN pharmacies p ON p.id = o.pharmacy_id WHERE o.id = ? AND o.patient_id = ?`, req.params.id, req.user.id);
}
router.get('/orders/:id', (req, res) => {
  const order = myOrder(req);
  if (!order) return notFound(res, 'Order');
  const items = db.all('SELECT oi.*, m.name, m.strength FROM order_items oi JOIN medicines m ON m.id = oi.medicine_id WHERE oi.order_id = ?', order.id);
  const history = db.all('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id', order.id);
  const profile = profileOf(req.user.id);
  const distance = distanceKm(order.plat, order.plng, profile.lat, profile.lng) ?? 2;
  let progress = 0, eta = null, away = distance;
  if (order.status === 'out_for_delivery' && order.out_at) {
    const total = Math.max(15, Math.round(distance * 6 + 12));
    const gone = (Date.now() - new Date(order.out_at)) / 60000;
    progress = Math.min(0.92, Math.max(0.08, gone / total));
    eta = Math.max(2, Math.round(total - gone));
    away = Math.round(distance * (1 - progress) * 10) / 10;
  } else if (order.status === 'delivered') progress = 1;
  const review = db.get('SELECT * FROM pharmacy_reviews WHERE order_id = ?', order.id);
  res.render('patient/track', { title: `Track order ${require('../helpers').code(order.id)}`, order, items, history, profile, progress, eta, away, review, ASPECTS: reviews.ASPECTS, rating: reviews.summary(order.pharmacy_id) });
});
router.post('/orders/:id/cancel', (req, res) => {
  const o = myOrder(req);
  if (!o || o.status !== 'received' || o.accepted) { req.flash('error', 'This order can no longer be cancelled.'); return res.redirect(`/patient/orders/${req.params.id}`); }
  db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", db.now(), o.id);
  db.run("INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'cancelled', 'Cancelled by patient')", o.id);
  notify(o.admin_user_id, 'Order cancelled', `Order ${require('../helpers').code(o.id)} was cancelled by the patient.`, `/pharmacy/orders/${o.id}`, 'order');
  res.redirect(`/patient/orders/${o.id}`);
});
router.post('/orders/:id/pay', (req, res) => {
  const o = myOrder(req);
  if (!o || o.payment_method !== 'online' || o.payment_status !== 'unpaid' || !o.accepted) { req.flash('error', 'Payment is not available for this order right now.'); return res.redirect(`/patient/orders/${req.params.id}`); }
  db.run("UPDATE orders SET payment_status = 'paid', updated_at = ? WHERE id = ?", db.now(), o.id);
  db.run("INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, 'Online payment received (demo gateway)')", o.id, o.status);
  notify(o.admin_user_id, 'Payment received', `Order ${require('../helpers').code(o.id)} was paid online.`, `/pharmacy/orders/${o.id}`, 'order');
  req.flash('success', 'Payment successful (demo gateway).');
  res.redirect(`/patient/orders/${o.id}`);
});
router.post('/orders/:id/review', (req, res) => {
  const o = myOrder(req);
  if (!o || o.status !== 'delivered') { req.flash('error', 'You can review a pharmacy after your order is delivered.'); return res.redirect(`/patient/orders/${req.params.id}`); }
  if (db.get('SELECT 1 FROM pharmacy_reviews WHERE order_id = ?', o.id)) { req.flash('error', 'You already reviewed this order.'); return res.redirect(`/patient/orders/${o.id}`); }
  const r = Object.fromEntries(Object.keys(reviews.ASPECTS).map((k) => [k, Math.min(5, Math.max(1, parseInt(req.body[k], 10) || 0))]));
  if (Object.values(r).some((v) => !v)) { req.flash('error', 'Rate all four aspects.'); return res.redirect(`/patient/orders/${o.id}#review`); }
  const { text, hidden } = reviews.moderate(req.body.comment);
  db.run('INSERT INTO pharmacy_reviews (order_id, pharmacy_id, patient_id, availability, price, delivery, service, overall, comment, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    o.id, o.pharmacy_id, req.user.id, r.availability, r.price, r.delivery, r.service, (r.availability + r.price + r.delivery + r.service) / 4, text || null, hidden ? 1 : 0);
  notify(o.admin_user_id, 'New review', `${req.user.full_name} rated your pharmacy ${((r.availability + r.price + r.delivery + r.service) / 4).toFixed(1)} of 5.`, '/pharmacy/reviews', 'review');
  req.flash('success', hidden ? 'Thanks. Your review was held for moderation because of its wording.' : 'Thanks for your review. It helps other patients choose.');
  res.redirect(`/patient/orders/${o.id}`);
});
router.post('/orders/:id/reorder', (req, res) => {
  const o = myOrder(req);
  if (!o || !o.prescription_id) { req.flash('error', 'This order cannot be repeated.'); return res.redirect('/patient/orders'); }
  res.redirect(`/patient/order?rx=${o.prescription_id}`);
});

// =============== Profile & settings ===============
router.get('/profile', (req, res) => {
  const sessions = db.all("SELECT sid, data FROM sessions WHERE json_extract(data, '$.userId') = ? AND expires > ?", req.user.id, Date.now())
    .map((s) => { const d = JSON.parse(s.data); return { key: require('crypto').createHash('sha256').update(s.sid).digest('hex').slice(0, 16), current: s.sid === req.sessionID, ua: d.ua || 'Browser', loginAt: d.loginAt }; });
  res.render('patient/profile', { title: 'Profile and settings', profile: profileOf(req.user.id), sessions, since: db.get('SELECT created_at FROM users WHERE id = ?', req.user.id).created_at, tab: req.query.tab || 'personal' });
});
router.post('/profile', (req, res) => {
  const b = req.body;
  const name = String(b.full_name || '').trim();
  const phone = String(b.phone || '').trim();
  if (!name || !/^\+?[0-9 -]{7,20}$/.test(phone)) { req.flash('error', 'Enter your name and a valid phone number.'); return res.redirect('/patient/profile'); }
  const num = (v, lo, hi) => (v === '' || v == null || isNaN(Number(v)) || Number(v) < lo || Number(v) > hi ? null : Number(v));
  db.run('UPDATE users SET full_name = ?, phone = ? WHERE id = ?', name, phone, req.user.id);
  db.run(`UPDATE patient_profiles SET date_of_birth = ?, gender = ?, blood_group = ?, address = ?, emergency_contact = ?, height_cm = ?, lat = ?, lng = ? WHERE user_id = ?`,
    b.date_of_birth || null, b.gender || null, b.blood_group || null, b.address || null, b.emergency_contact || null, num(b.height_cm, 50, 250), num(b.lat, -90, 90), num(b.lng, -180, 180), req.user.id);
  req.flash('success', 'Profile saved.');
  res.redirect('/patient/profile');
});
router.post('/profile/preferences', (req, res) => {
  const b = req.body;
  db.run('UPDATE patient_profiles SET notify_reports = ?, notify_appointments = ?, notify_orders = ?, default_access_days = ?, language = ? WHERE user_id = ?',
    b.notify_reports ? 1 : 0, b.notify_appointments ? 1 : 0, b.notify_orders ? 1 : 0, [1, 3, 7, 14, 30].includes(Number(b.default_access_days)) ? Number(b.default_access_days) : 7,
    ['English', 'বাংলা'].includes(b.language) ? b.language : 'English', req.user.id);
  req.flash('success', 'Preferences saved.');
  res.redirect('/patient/profile#notifications');
});

// =============== Health status (new) ===============
router.get('/health', (req, res) => {
  const o = health.overview(req.user.id);
  const kind = health.KINDS[req.query.kind] ? req.query.kind : 'bp';
  const recent = db.all('SELECT * FROM health_readings WHERE patient_id = ? ORDER BY measured_at DESC LIMIT 12', req.user.id);
  const profile = profileOf(req.user.id);
  const shares = db.all(`SELECT DISTINCT u.id, u.full_name FROM appointments a JOIN users u ON u.id = a.doctor_id WHERE a.patient_id = ? AND a.status IN ('confirmed','completed')`, req.user.id);
  res.render('patient/health', { title: 'Health status', o, kind, recent, summary: health.weeklySummary(o), profile, shares, classify: health.classify, fmt: health.fmt, LEVEL_TEXT: health.LEVEL_TEXT });
});
router.post('/health', (req, res) => {
  const kind = req.body.kind;
  if (!health.KINDS[kind]) return res.redirect('/patient/health');
  const v1 = Number(req.body.value1);
  const v2 = kind === 'bp' ? Number(req.body.value2) : null;
  const RANGE = { bp: [50, 260], sugar: [1, 40], weight: [2, 300], pulse: [20, 250], spo2: [50, 100] };
  if (!(v1 >= RANGE[kind][0] && v1 <= RANGE[kind][1]) || (kind === 'bp' && !(v2 >= 30 && v2 <= 180 && v2 < v1))) {
    req.flash('error', 'That reading does not look right. Check the numbers and try again.');
    return res.redirect(`/patient/health?kind=${kind}`);
  }
  const when = req.body.measured_at ? new Date(req.body.measured_at) : new Date();
  const measured = isNaN(when) || when > new Date() ? new Date() : when;
  const { id } = db.run('INSERT INTO health_readings (patient_id, kind, value1, value2, context, measured_at) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id, kind, v1, v2, kind === 'sugar' ? (req.body.context === 'fasting' ? 'fasting' : 'random') : null, measured.toISOString());
  const r = db.get('SELECT * FROM health_readings WHERE id = ?', id);
  const s = health.classify(r, profileOf(req.user.id).height_cm);
  if (s.level === 'urgent' || s.level === 'doctor') {
    require('../services/caregivers').alertCaregivers(req.user.id, 'vitals', `${s.level === 'urgent' ? 'Urgent reading' : 'Reading to review'}: ${req.user.full_name}`,
      `${health.KINDS[kind].name} ${health.fmt(r)} ${health.KINDS[kind].unit}: ${s.note}.`, 'alert');
  }
  if (s.level === 'urgent') req.flash('error', `${s.note}. If you feel unwell, call 999 or go to the nearest emergency department now.`);
  else if (s.level === 'doctor') req.flash('error', `${s.note}. Book a doctor to review it.`);
  else req.flash('success', `Saved. ${s.note}.`);
  res.redirect(`/patient/health?kind=${kind}`);
});
router.post('/health/:id/delete', (req, res) => {
  db.run('DELETE FROM health_readings WHERE id = ? AND patient_id = ?', req.params.id, req.user.id);
  res.redirect('/patient/health');
});

// =============== Medicine reminders (new) ===============
router.get('/reminders', (req, res) => {
  const id = req.user.id;
  const doses = reminders.today(id);
  const list = db.all('SELECT * FROM reminders WHERE patient_id = ? ORDER BY active DESC, end_date DESC', id);
  const prescriptions = db.all(`SELECT p.*, u.full_name AS doctor_name, (SELECT COUNT(*) FROM reminders r WHERE r.prescription_id = p.id AND r.active = 1) AS has FROM prescriptions p LEFT JOIN users u ON u.id = p.doctor_id
                                  WHERE p.patient_id = ? AND (SELECT COUNT(*) FROM prescription_items i WHERE i.prescription_id = p.id AND i.medicine_id IS NOT NULL) > 0 ORDER BY p.created_at DESC LIMIT 6`, id);
  const week = [];
  for (let d = 6; d >= 0; d--) {
    const t = new Date();
    const s = new Date(t.getFullYear(), t.getMonth(), t.getDate() - d);
    const e = new Date(t.getFullYear(), t.getMonth(), t.getDate() - d + 1);
    const rows = db.all('SELECT d.status, d.due_at FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id WHERE r.patient_id = ? AND d.due_at >= ? AND d.due_at < ?', id, s.toISOString(), e.toISOString());
    week.push({ label: s.toLocaleDateString('en-US', { weekday: 'short' }), taken: rows.filter((r) => r.status === 'taken').length, total: rows.filter((r) => r.status !== 'due' || new Date(r.due_at) < new Date()).length });
  }
  res.render('patient/reminders', { title: 'Medicine reminders', doses, list, prescriptions, adherence: reminders.adherence(id, 7), week, FREQUENCIES: Object.keys(reminders.FREQUENCIES) });
});
router.post('/reminders/from-rx', (req, res) => {
  const rx = db.get('SELECT * FROM prescriptions WHERE id = ? AND patient_id = ?', req.body.prescription_id, req.user.id);
  if (!rx) return notFound(res, 'Prescription');
  const n = reminders.createFromPrescription(req.user.id, rx.id);
  req.flash('success', n ? `${n} reminder${n > 1 ? 's' : ''} created. You will be notified when each dose is due.` : 'Reminders for this prescription already exist.');
  res.redirect('/patient/reminders');
});
router.post('/reminders/custom', (req, res) => {
  const name = String(req.body.medicine_name || '').trim().slice(0, 80);
  const perDay = Math.min(6, Math.max(1, parseInt(req.body.per_day, 10) || 1));
  const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 7));
  const times = [...new Set([].concat(req.body.times || []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].slice(0, perDay).sort();
  if (!name) { req.flash('error', 'Enter the medicine name.'); return res.redirect('/patient/reminders#add'); }
  if (times.length < perDay) { req.flash('error', `Set ${perDay} different time${perDay > 1 ? 's' : ''} for ${perDay} dose${perDay > 1 ? 's' : ''} a day.`); return res.redirect('/patient/reminders#add'); }
  if (!req.body.notify_push && !req.body.notify_voice) { req.flash('error', 'Choose notification, voice or both.'); return res.redirect('/patient/reminders#add'); }
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.body.start_date || '') ? req.body.start_date : schedule.dateStr(new Date());
  const end = new Date(`${start}T00:00:00`); end.setDate(end.getDate() + days - 1);
  db.run('INSERT INTO reminders (patient_id, medicine_name, dose, times, start_date, end_date, pills_left, notify_push, notify_voice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.user.id, name, String(req.body.dose || '1').slice(0, 40), times.join(','), start, schedule.dateStr(end), times.length * days, req.body.notify_push ? 1 : 0, req.body.notify_voice ? 1 : 0);
  reminders.materialize(req.user.id);
  req.flash('success', `Reminder added for ${name}: ${times.join(', ')} every day for ${days} days.`);
  res.redirect('/patient/reminders');
});
router.post('/reminders/:id/alerts', (req, res) => {
  const push = req.body.notify_push ? 1 : 0, voice = req.body.notify_voice ? 1 : 0;
  db.run('UPDATE reminders SET notify_push = ?, notify_voice = ? WHERE id = ? AND patient_id = ?', push || !voice ? push || 1 : 0, voice, req.params.id, req.user.id);
  req.flash('success', 'Alert settings saved.');
  res.redirect('/patient/reminders');
});
// Polled by the browser on every patient page: doses due now, with the alert style the patient chose.
router.get('/reminders/due', (req, res) => {
  reminders.materialize(req.user.id);
  const now = Date.now();
  const rows = db.all(`SELECT d.id, d.due_at, r.medicine_name, r.dose, r.notify_push, r.notify_voice FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id
                        WHERE r.patient_id = ? AND r.active = 1 AND d.status = 'due' AND d.due_at <= ? AND d.due_at >= ? ORDER BY d.due_at`,
  req.user.id, new Date(now + 30_000).toISOString(), new Date(now - 15 * 60_000).toISOString());
  res.json({ doses: rows.map((r) => ({ ...r, time: new Date(r.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) })) });
});
router.post('/reminders/dose/:id/:status(taken|skipped)', (req, res) => {
  if (!reminders.mark(req.user.id, req.params.id, req.params.status)) return notFound(res, 'Dose');
  res.redirect(req.get('referer') && req.get('referer').includes('/patient') ? req.get('referer') : '/patient/reminders');
});
router.post('/reminders/:id/stop', (req, res) => {
  db.run('UPDATE reminders SET active = 0 WHERE id = ? AND patient_id = ?', req.params.id, req.user.id);
  db.run("DELETE FROM dose_logs WHERE reminder_id = ? AND status = 'due' AND due_at > ?", req.params.id, db.now());
  req.flash('success', 'Reminder stopped.');
  res.redirect('/patient/reminders');
});
router.post('/reminders/:id/refill', (req, res) => {
  const r = db.get('SELECT * FROM reminders WHERE id = ? AND patient_id = ?', req.params.id, req.user.id);
  if (!r || !r.prescription_id) { req.flash('error', 'Upload a prescription to reorder this medicine.'); return res.redirect('/patient/order'); }
  res.redirect(`/patient/order?rx=${r.prescription_id}`);
});

// =============== Health assistant chatbot (new) ===============
router.get('/assistant', (req, res) => {
  const messages = db.all('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 40', req.user.id).reverse();
  res.render('patient/assistant', { title: 'Health assistant', messages, ai: !!config.anthropicKey });
});
router.post('/assistant', ah(async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!message) return res.redirect('/patient/assistant');
  db.run("INSERT INTO chat_messages (user_id, role, body) VALUES (?, 'user', ?)", req.user.id, message);
  const r = await assistant.reply(req.user, message);
  db.run("INSERT INTO chat_messages (user_id, role, body, flagged) VALUES (?, 'assistant', ?, ?)", req.user.id, r.text, r.flagged ? 1 : 0);
  if (r.abstained) {
    audit(req, 'assistant.abstained', { patientId: req.user.id, details: r.conflicts.map((c) => `${c.drugs.join('+')}: ${c.why}`).join(' | ').slice(0, 500) });
  }
  res.redirect('/patient/assistant#end');
}));
router.post('/assistant/clear', (req, res) => {
  db.run('DELETE FROM chat_messages WHERE user_id = ?', req.user.id);
  res.redirect('/patient/assistant');
});

module.exports = router;
