// Doctor portal: requests and time proposals, schedule, consultations,
// prescriptions, test orders, patient record access and messages.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireRole, notFound } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { activeGrants, reportsVisibleToDoctor } = require('../services/access');
const schedule = require('../services/schedule');
const reminders = require('../services/reminders');
const health = require('../services/health');
const stats = require('../stats');
const H = require('../helpers');

const router = express.Router();
router.use(requireRole('doctor'));

const age = (dob) => (dob ? Math.floor((Date.now() - new Date(dob)) / 31557600000) : null);
function addEvent(apptId, senderId, body, kind = 'event') {
  db.run('INSERT INTO appointment_messages (appointment_id, sender_id, kind, body) VALUES (?, ?, ?, ?)', apptId, senderId, kind, body);
  db.run('UPDATE appointments SET updated_at = ? WHERE id = ?', db.now(), apptId);
}
const dayRange = (d = new Date()) => [new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString(), new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString()];
function myAppt(req, id) {
  return db.get(`SELECT a.*, u.full_name AS patient_name, u.phone AS patient_phone, p.date_of_birth, p.gender, p.blood_group, p.address
                   FROM appointments a JOIN users u ON u.id = a.patient_id LEFT JOIN patient_profiles p ON p.user_id = a.patient_id WHERE a.id = ? AND a.doctor_id = ?`, id, req.user.id);
}

// =============== Dashboard ===============
router.get('/', (req, res) => {
  const id = req.user.id;
  const [s, e] = dayRange();
  const today = db.all(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id
                          WHERE a.doctor_id = ? AND a.status IN ('confirmed','completed') AND a.proposed_time >= ? AND a.proposed_time < ? ORDER BY a.proposed_time`, id, s, e);
  const requests = db.all(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id
                             WHERE a.doctor_id = ? AND a.status IN ('requested','reschedule_requested') ORDER BY a.created_at DESC`, id);
  const counts = Object.fromEntries(db.all(`SELECT status, COUNT(*) n FROM appointments WHERE doctor_id = ? AND proposed_time >= ? AND proposed_time < ? GROUP BY status`, id, s, e).map((r) => [r.status, r.n]));
  const patients = db.get('SELECT COUNT(DISTINCT patient_id) n FROM appointments WHERE doctor_id = ?', id).n;
  const newPatients = db.get('SELECT COUNT(DISTINCT patient_id) n FROM appointments WHERE doctor_id = ? AND created_at >= ?', id, new Date(Date.now() - 30 * 86400000).toISOString()).n;
  const accessPending = db.get("SELECT COUNT(*) n FROM access_requests WHERE doctor_id = ? AND status = 'pending'", id).n;
  const next = db.get(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id WHERE a.doctor_id = ? AND a.status = 'confirmed' AND a.proposed_time >= ? ORDER BY a.proposed_time`, id, db.now());
  const nextTests = next ? db.all("SELECT t.name FROM test_orders o JOIN test_catalog t ON t.id = o.test_id WHERE o.patient_id = ? AND o.doctor_id = ? AND o.status <> 'completed'", next.patient_id, id).map((t) => t.name) : [];
  const cards = [
    { href: '/doctor/schedule', tile: 't-blue', icon: 'calendar', color: 'blue', label: "Today's appointments", value: today.length, sub: `${today.filter((a) => a.status === 'completed').length} completed`, trend: stats.daily('SELECT proposed_time AS t FROM appointments WHERE doctor_id = ?', [id]) },
    { href: '/doctor/requests', tile: 't-orange', icon: 'users', color: 'orange', label: 'Pending requests', value: requests.length, sub: 'Need a proposed time', trend: stats.daily('SELECT created_at AS t FROM appointments WHERE doctor_id = ?', [id]) },
    { href: '/doctor/patients', tile: 't-teal', icon: 'heart', color: 'teal', label: 'Active patients', value: patients, sub: `+${newPatients} this month`, trend: stats.daily('SELECT created_at AS t FROM appointments WHERE doctor_id = ?', [id]) },
    { href: '/doctor/access', tile: 't-purple', icon: 'shield', color: 'purple', label: 'Report access', value: accessPending, sub: 'Awaiting patient approval', trend: stats.daily('SELECT created_at AS t FROM access_requests WHERE doctor_id = ?', [id]) },
  ];
  const chart = stats.monthly("SELECT proposed_time AS t FROM appointments WHERE doctor_id = ? AND status = 'completed'", [id]);
  const donut = [
    { label: 'Confirmed', value: counts.confirmed || 0, color: '#4f46e5' },
    { label: 'Pending', value: (counts.proposed || 0) + (counts.reschedule_requested || 0), color: '#f59e0b' },
    { label: 'Done', value: counts.completed || 0, color: '#10b981' },
    { label: 'Cancelled', value: (counts.cancelled || 0) + (counts.declined || 0), color: '#ef4444' },
  ];
  const me = db.get('SELECT share_location, fee FROM doctor_profiles WHERE user_id = ?', id);
  const chatRequests = db.all("SELECT t.*, u.full_name AS patient_name FROM chat_threads t JOIN users u ON u.id = t.patient_id WHERE t.doctor_id = ? AND t.status = 'pending' ORDER BY t.id DESC", id);
  res.render('doctor/dashboard', { title: 'Dashboard', cards, chart, ring: donut, today, requests, next, nextTests, todayTotal: today.length, me, chatRequests });
});

// =============== Appointment requests and time proposals ===============
router.get('/requests', (req, res) => {
  const id = req.user.id;
  const pending = db.all(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id
                            WHERE a.doctor_id = ? AND a.status IN ('requested','reschedule_requested','proposed') ORDER BY (a.status = 'proposed'), a.created_at DESC`, id);
  const sel = req.query.id ? myAppt(req, req.query.id) : pending[0] ? myAppt(req, pending[0].id) : null;
  let entry = null, strip = [], slots = [], off = null, day = null, profile = db.get('SELECT * FROM doctor_profiles WHERE user_id = ?', id), prior = null, daySchedule = [];
  if (sel) {
    sel.age = age(sel.date_of_birth);
    entry = sel.health_entry_id ? db.get('SELECT * FROM health_entries WHERE id = ?', sel.health_entry_id) : null;
    prior = db.get("SELECT GROUP_CONCAT(DISTINCT reason) r FROM appointments WHERE patient_id = ? AND doctor_id = ? AND status = 'completed'", sel.patient_id, id).r;
    strip = schedule.dateStrip(id, 7);
    const pref = sel.preferred_time && /^\d{4}-\d{2}-\d{2}T/.test(sel.preferred_time) ? schedule.dateStr(new Date(sel.preferred_time)) : null;
    day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : pref && pref >= strip[0].day ? pref : (strip.find((d) => d.open) || strip[0]).day;
    ({ slots, off } = schedule.slotsFor(id, day, sel.id));
    const d = new Date(`${day}T00:00:00`);
    const [s, e] = dayRange(d);
    daySchedule = db.all(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id WHERE a.doctor_id = ? AND a.status IN ('confirmed','proposed','completed') AND a.proposed_time >= ? AND a.proposed_time < ? ORDER BY a.proposed_time`, id, s, e);
  }
  const counts = { pending: pending.filter((p) => p.status !== 'proposed').length, proposed: pending.filter((p) => p.status === 'proposed').length };
  res.render('doctor/requests', { title: 'Appointment requests', pending, sel, entry, strip, slots, off, day, profile, prior, daySchedule, counts });
});

router.post('/appointments/:id/propose', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !['requested', 'reschedule_requested', 'proposed', 'confirmed'].includes(a.status)) return notFound(res, 'Open appointment');
  const picked = [].concat(req.body.slots || []).slice(0, 3).filter((t) => schedule.isOpen(req.user.id, t, a.id)).map((t) => new Date(t).toISOString());
  if (!picked.length) { req.flash('error', 'Choose at least one open time from your schedule.'); return res.redirect(`/doctor/requests?id=${a.id}`); }
  const mode = req.body.mode === 'online' ? 'online' : 'in_person';
  const duration = [15, 20, 30, 45, 60].includes(Number(req.body.duration)) ? Number(req.body.duration) : 30;
  const note = String(req.body.note || '').trim().slice(0, 500);
  db.run("UPDATE appointments SET status = 'proposed', proposed_time = ?, alt_times = ?, mode = ?, duration = ?, doctor_note = ?, updated_at = ? WHERE id = ?",
    picked[0], picked.length > 1 ? JSON.stringify(picked.slice(1)) : null, mode, duration, note || null, db.now(), a.id);
  addEvent(a.id, req.user.id, `Doctor proposed ${H.friendly(picked[0])}${picked.length > 1 ? ` and ${picked.length - 1} other option(s)` : ''}.`);
  if (note) addEvent(a.id, req.user.id, note, 'message');
  notify(a.patient_id, 'New time proposed', `${req.user.full_name} proposed ${H.friendly(picked[0])}. Confirm or reschedule.`, `/patient/appointments?id=${a.id}`, 'appointment');
  req.flash('success', `Time proposal sent to ${a.patient_name}.`);
  res.redirect(`/doctor/requests?id=${a.id}`);
});
router.post('/appointments/:id/accept-preferred', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !a.preferred_time || !/^\d{4}-\d{2}-\d{2}T/.test(a.preferred_time) || !schedule.isOpen(req.user.id, a.preferred_time, a.id)) {
    req.flash('error', 'That time is no longer open. Propose another time.');
    return res.redirect(`/doctor/requests?id=${req.params.id}`);
  }
  db.run("UPDATE appointments SET status = 'confirmed', proposed_time = ?, alt_times = NULL, updated_at = ? WHERE id = ?", a.preferred_time, db.now(), a.id);
  addEvent(a.id, req.user.id, `Doctor accepted ${H.friendly(a.preferred_time)}. Appointment confirmed.`);
  notify(a.patient_id, 'Appointment confirmed', `${req.user.full_name} accepted your preferred time: ${H.friendly(a.preferred_time)}.`, `/patient/appointments?id=${a.id}`, 'appointment');
  req.flash('success', 'Appointment confirmed at the patient’s preferred time.');
  res.redirect(String(req.get('referer') || '').includes('/doctor/requests') || String(req.get('referer') || '').endsWith('/doctor') ? '/doctor/requests' : `/doctor/appointments/${a.id}`);
});
router.post('/appointments/:id/decline', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !['requested', 'reschedule_requested', 'proposed'].includes(a.status)) return notFound(res, 'Open appointment');
  const note = String(req.body.note || '').trim();
  db.run("UPDATE appointments SET status = 'declined', updated_at = ? WHERE id = ?", db.now(), a.id);
  addEvent(a.id, req.user.id, `Doctor declined the request.${note ? ' Reason: ' + note : ''}`);
  notify(a.patient_id, 'Appointment declined', `${req.user.full_name} could not take this appointment.${note ? ' ' + note : ''}`, `/patient/appointments?id=${a.id}`, 'appointment');
  req.flash('success', 'Request deleted. The patient was notified.');
  res.redirect(String(req.get('referer') || '').endsWith('/doctor') ? '/doctor' : '/doctor/requests');
});

// =============== Consultation detail ===============
router.get('/appointments', (req, res) => res.redirect('/doctor/schedule'));
router.get('/appointments/:id', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a) return notFound(res, 'Appointment');
  a.age = age(a.date_of_birth);
  const entry = a.health_entry_id ? db.get('SELECT * FROM health_entries WHERE id = ?', a.health_entry_id) : null;
  const messages = db.all('SELECT m.*, u.full_name FROM appointment_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.appointment_id = ? ORDER BY m.id', a.id);
  const tests = db.all('SELECT o.*, t.name FROM test_orders o JOIN test_catalog t ON t.id = o.test_id WHERE o.appointment_id = ?', a.id);
  const prescriptions = db.all('SELECT * FROM prescriptions WHERE appointment_id = ?', a.id);
  const vitals = health.overview(a.patient_id);
  const hasAccess = activeGrants(req.user.id, a.patient_id).length > 0;
  res.render('doctor/appointment', { title: a.patient_name, a, entry, messages, tests, prescriptions, vitals: hasAccess ? vitals : null, adherence: hasAccess ? reminders.adherence(a.patient_id) : null, fmt: health.fmt });
});
router.post('/appointments/:id/complete', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || a.status !== 'confirmed') return notFound(res, 'Confirmed appointment');
  db.run("UPDATE appointments SET status = 'completed', consultation_notes = ?, updated_at = ? WHERE id = ?", String(req.body.notes || '').slice(0, 5000), db.now(), a.id);
  addEvent(a.id, req.user.id, 'Consultation completed.');
  notify(a.patient_id, 'Consultation completed', `Your consultation with ${req.user.full_name} is complete.`, `/patient/appointments?id=${a.id}`, 'appointment');
  req.flash('success', 'Consultation completed. Write the prescription next.');
  res.redirect(`/doctor/appointments/${a.id}/prescribe`);
});
router.post('/appointments/:id/message', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a) return notFound(res, 'Appointment');
  const body = String(req.body.body || '').trim();
  if (body) {
    addEvent(a.id, req.user.id, body.slice(0, 2000), 'message');
    notify(a.patient_id, 'New message from your doctor', `${req.user.full_name}: ${body.slice(0, 80)}`, `/patient/appointments?id=${a.id}#messages`, 'appointment');
  }
  res.redirect(String(req.get('referer') || '').includes('/doctor/messages') ? `/doctor/messages?id=${a.id}` : `/doctor/appointments/${a.id}#messages`);
});

// =============== Write prescription (medicines + tests) ===============
router.get('/appointments/:id/prescribe', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !['confirmed', 'completed'].includes(a.status)) return notFound(res, 'Confirmed or completed consultation');
  a.age = age(a.date_of_birth);
  const medicines = db.all('SELECT * FROM medicines ORDER BY name');
  const catalog = db.all('SELECT * FROM test_catalog ORDER BY category, name');
  const prescribed = db.all('SELECT test_id FROM test_orders WHERE appointment_id = ?', a.id).map((t) => t.test_id);
  const existing = db.get('SELECT * FROM prescriptions WHERE appointment_id = ? ORDER BY id DESC', a.id);
  const access = activeGrants(req.user.id, a.patient_id).length > 0;
  res.render('doctor/prescribe', { title: 'New prescription', a, medicines, catalog, prescribed, existing, existingItems: existing ? db.all('SELECT i.*, m.name, m.strength FROM prescription_items i LEFT JOIN medicines m ON m.id = i.medicine_id WHERE prescription_id = ?', existing.id) : [], access, FREQUENCIES: Object.keys(reminders.FREQUENCIES) });
});
router.post('/appointments/:id/prescribe', (req, res) => {
  const a = myAppt(req, req.params.id);
  if (!a || !['confirmed', 'completed'].includes(a.status)) return notFound(res, 'Confirmed or completed consultation');
  const meds = [].concat(req.body.medicine_id || []);
  const doses = [].concat(req.body.dose || []);
  const freqs = [].concat(req.body.frequency || []);
  const days = [].concat(req.body.duration || []);
  const items = meds.map((m, i) => {
    const med = db.get('SELECT * FROM medicines WHERE id = ?', Number(m));
    if (!med) return null;
    const d = Math.min(Math.max(parseInt(days[i], 10) || 7, 1), 365);
    const freq = reminders.FREQUENCIES[freqs[i]] ? freqs[i] : 'Once a day';
    return { med, dose: String(doses[i] || '1 tablet').slice(0, 40), freq, days: d, qty: reminders.PER_DAY[freq] * d };
  }).filter(Boolean);
  const tests = [].concat(req.body.test_ids || []).map(Number).map((tid) => db.get('SELECT * FROM test_catalog WHERE id = ?', tid)).filter(Boolean);
  const already = new Set(db.all('SELECT test_id FROM test_orders WHERE appointment_id = ?', a.id).map((t) => t.test_id));
  const newTests = tests.filter((t) => !already.has(t.id));
  if (!items.length && !newTests.length) { req.flash('error', 'Add at least one medicine or test.'); return res.redirect(`/doctor/appointments/${a.id}/prescribe`); }
  const diagnosis = String(req.body.diagnosis || '').trim().slice(0, 2000);
  const pid = db.tx(() => {
    let pid = null;
    if (items.length) {
      pid = db.run("INSERT INTO prescriptions (patient_id, doctor_id, appointment_id, source, diagnosis, notes, verified) VALUES (?, ?, ?, 'doctor', ?, ?, 1)", a.patient_id, req.user.id, a.id, diagnosis || null, String(req.body.advice || '').slice(0, 500) || null).id;
      for (const it of items) db.run('INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, frequency, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', pid, it.med.id, it.med.name, it.dose, it.freq, it.days, it.qty);
    }
    for (const t of newTests) db.run('INSERT INTO test_orders (patient_id, doctor_id, appointment_id, prescription_id, test_id, notes) VALUES (?, ?, ?, ?, ?, ?)', a.patient_id, req.user.id, a.id, pid, t.id, String(req.body.test_notes || '').slice(0, 300) || null);
    return pid;
  });
  if (diagnosis && !a.consultation_notes) db.run('UPDATE appointments SET consultation_notes = ? WHERE id = ?', diagnosis, a.id);
  addEvent(a.id, req.user.id, `Prescription signed${items.length ? `: ${items.length} medicine(s)` : ''}${newTests.length ? `${items.length ? ',' : ':'} tests ${newTests.map((t) => t.name).join(', ')}` : ''}.`);
  if (items.length) notify(a.patient_id, 'New prescription', `${req.user.full_name} sent a prescription. Order medicines or set reminders.`, `/patient/order?rx=${pid}`, 'order');
  if (newTests.length) notify(a.patient_id, 'New tests prescribed', `${newTests.map((t) => t.name).join(', ')} added to Medical Tests.`, '/patient/tests', 'test');
  audit(req, 'prescription.signed', { entity: 'prescription', entityId: pid, patientId: a.patient_id });
  req.flash('success', 'Prescription signed and sent to the patient.');
  res.redirect(`/doctor/appointments/${a.id}`);
});

// =============== Schedule and availability ===============
router.get('/schedule', (req, res) => {
  const id = req.user.id;
  const profile = db.get('SELECT * FROM doctor_profiles WHERE user_id = ?', id);
  const strip = schedule.dateStrip(id, 7);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : (strip.find((d) => d.open) || strip[0]).day;
  const { slots, off } = schedule.slotsFor(id, day);
  const timeOff = db.all('SELECT * FROM doctor_time_off WHERE doctor_id = ? AND end_date >= ? ORDER BY start_date', id, schedule.dateStr(new Date()));
  const [s, e] = dayRange(new Date(`${day}T00:00:00`));
  const booked = db.all(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id WHERE a.doctor_id = ? AND a.status IN ('confirmed','proposed','completed') AND a.proposed_time >= ? AND a.proposed_time < ? ORDER BY a.proposed_time`, id, s, e);
  res.render('doctor/schedule', { title: 'Schedule and availability', hours: schedule.hours(id), WEEKDAYS: schedule.WEEKDAYS, profile, strip, day, slots, off, timeOff, booked });
});
router.post('/schedule', (req, res) => {
  const id = req.user.id;
  const T = /^([01]\d|2[0-3]):[0-5]\d$/;
  const errors = [];
  db.tx(() => {
    for (let wd = 0; wd < 7; wd++) {
      const on = req.body[`on_${wd}`] ? 1 : 0;
      const st = req.body[`start_${wd}`], en = req.body[`end_${wd}`];
      if (on && (!T.test(st) || !T.test(en) || st >= en)) { errors.push(`${schedule.WEEKDAYS[wd]}: end time must be after start time.`); continue; }
      db.run(`INSERT INTO doctor_hours (doctor_id, weekday, enabled, start_time, end_time) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(doctor_id, weekday) DO UPDATE SET enabled = excluded.enabled, start_time = excluded.start_time, end_time = excluded.end_time`,
        id, wd, on, T.test(st) ? st : '09:00', T.test(en) ? en : '13:00');
    }
    const b = req.body;
    const pick = (v, list, d) => (list.includes(Number(v)) ? Number(v) : d);
    db.run('UPDATE doctor_profiles SET slot_minutes = ?, buffer_minutes = ?, fee = ?, max_per_day = ?, in_person = ?, online = ? WHERE user_id = ?',
      pick(b.slot_minutes, [15, 20, 30, 45, 60], 30), pick(b.buffer_minutes, [0, 5, 10, 15], 5), Math.max(0, parseInt(b.fee, 10) || 0),
      Math.min(Math.max(parseInt(b.max_per_day, 10) || 16, 1), 60), b.in_person ? 1 : 0, b.online ? 1 : 0, id);
  });
  if (errors.length) req.flash('error', errors.join(' ')); else req.flash('success', 'Schedule saved. Patients now see these times.');
  res.redirect('/doctor/schedule');
});
router.post('/schedule/time-off', (req, res) => {
  const { start_date: s, end_date: e, reason } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') || (e && e < s)) { req.flash('error', 'Choose valid dates.'); return res.redirect('/doctor/schedule'); }
  db.run('INSERT INTO doctor_time_off (doctor_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)', req.user.id, s, e || s, String(reason || '').slice(0, 80) || 'Time off');
  req.flash('success', 'Time off added. Those days are blocked for new bookings.');
  res.redirect('/doctor/schedule');
});
router.post('/schedule/time-off/:id/delete', (req, res) => {
  db.run('DELETE FROM doctor_time_off WHERE id = ? AND doctor_id = ?', req.params.id, req.user.id);
  res.redirect('/doctor/schedule');
});

// =============== Patients ===============
router.get('/patients', (req, res) => {
  const id = req.user.id;
  const f = ['followup', 'approved'].includes(req.query.f) ? req.query.f : 'all';
  const q = String(req.query.q || '').trim().toLowerCase();
  let patients = db.all(`SELECT u.id, u.full_name, p.date_of_birth, MAX(a.proposed_time) AS last_visit, COUNT(a.id) AS visits,
                            (SELECT reason FROM appointments x WHERE x.patient_id = u.id AND x.doctor_id = ? ORDER BY x.created_at DESC LIMIT 1) AS reason,
                            (SELECT status FROM access_requests r WHERE r.patient_id = u.id AND r.doctor_id = ? ORDER BY r.id DESC LIMIT 1) AS req_status,
                            SUM(a.status = 'confirmed' AND a.proposed_time >= ?) AS upcoming
                           FROM appointments a JOIN users u ON u.id = a.patient_id LEFT JOIN patient_profiles p ON p.user_id = u.id
                          WHERE a.doctor_id = ? GROUP BY u.id ORDER BY last_visit DESC`, id, id, db.now(), id)
    .map((p) => ({ ...p, age: age(p.date_of_birth), access: activeGrants(id, p.id).length > 0 }));
  const counts = { total: patients.length, followups: patients.filter((p) => p.upcoming).length, approved: patients.filter((p) => p.access).length, pending: patients.filter((p) => !p.access && p.req_status === 'pending').length };
  if (q) patients = patients.filter((p) => p.full_name.toLowerCase().includes(q) || String(p.reason || '').toLowerCase().includes(q));
  if (f === 'followup') patients = patients.filter((p) => p.upcoming);
  if (f === 'approved') patients = patients.filter((p) => p.access);
  const selId = Number(req.query.id) || (patients[0] && patients[0].id);
  const sel = selId ? patientDetail(req, selId) : null;
  const cards = [
    { tile: 't-blue', icon: 'users', color: 'blue', label: 'Active patients', value: counts.total, sub: 'All time', trend: stats.daily('SELECT created_at AS t FROM appointments WHERE doctor_id = ?', [id]) },
    { tile: 't-orange', icon: 'calendar', color: 'orange', label: 'Follow-ups due', value: counts.followups, sub: 'Confirmed upcoming', trend: stats.daily("SELECT proposed_time AS t FROM appointments WHERE doctor_id = ? AND status = 'confirmed'", [id]) },
    { tile: 't-teal', icon: 'shield', color: 'teal', label: 'Access approved', value: counts.approved, sub: 'Reports shared with you', trend: stats.daily('SELECT created_at AS t FROM access_grants WHERE doctor_id = ?', [id]) },
    { tile: 't-purple', icon: 'bell', color: 'purple', label: 'Access pending', value: counts.pending, sub: 'Awaiting patients', trend: stats.daily('SELECT created_at AS t FROM access_requests WHERE doctor_id = ?', [id]) },
  ];
  res.render('doctor/patients', { title: 'My patients', patients, sel, cards, f, q, defaultHours: config.accessGrantHours });
});
function patientDetail(req, pid) {
  const p = db.get(`SELECT u.id, u.full_name, p.date_of_birth, p.gender, p.blood_group, p.address FROM users u LEFT JOIN patient_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'patient'`, pid);
  if (!p) return null;
  const related = db.get('SELECT 1 FROM appointments WHERE doctor_id = ? AND patient_id = ?', req.user.id, p.id) || db.get('SELECT 1 FROM access_grants WHERE doctor_id = ? AND patient_id = ?', req.user.id, p.id);
  if (!related) return null;
  p.age = age(p.date_of_birth);
  p.reports = reportsVisibleToDoctor(req.user.id, p.id);
  p.grants = activeGrants(req.user.id, p.id);
  p.requests = db.all('SELECT * FROM access_requests WHERE doctor_id = ? AND patient_id = ? ORDER BY id DESC LIMIT 5', req.user.id, p.id);
  p.journey = [
    ...db.all("SELECT 'consult' k, proposed_time t, reason d, status FROM appointments WHERE doctor_id = ? AND patient_id = ? AND proposed_time IS NOT NULL", req.user.id, p.id),
    ...db.all("SELECT 'test' k, o.created_at t, GROUP_CONCAT(t.name, ', ') d, '' status FROM test_orders o JOIN test_catalog t ON t.id = o.test_id WHERE o.doctor_id = ? AND o.patient_id = ? GROUP BY o.appointment_id", req.user.id, p.id),
    ...p.grants.map((g) => ({ k: 'share', t: g.created_at, d: `Access expires ${H.friendly(g.expires_at)}`, status: '' })),
  ].sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, 5);
  p.vitals = p.grants.length ? health.overview(p.id) : null;
  p.adherence = p.grants.length ? reminders.adherence(p.id) : null;
  if (p.grants.length) audit(req, 'records.list_viewed', { entity: 'patient', entityId: p.id, patientId: p.id, details: { visibleReports: p.reports.length } });
  return p;
}
router.post('/patients/:id/request-access', (req, res) => {
  const pid = Number(req.params.id);
  if (!db.get('SELECT 1 FROM appointments WHERE doctor_id = ? AND patient_id = ?', req.user.id, pid)) return notFound(res, 'Patient');
  if (db.get("SELECT 1 FROM access_requests WHERE doctor_id = ? AND patient_id = ? AND status = 'pending'", req.user.id, pid)) { req.flash('error', 'You already have a pending request for this patient.'); return res.redirect(`/doctor/patients?id=${pid}`); }
  const hours = [24, 48, 72, 168].includes(Number(req.body.hours)) ? Number(req.body.hours) : config.accessGrantHours;
  const reason = String(req.body.reason || 'To review your diagnostic reports for your consultation').trim().slice(0, 300);
  const { id } = db.run('INSERT INTO access_requests (doctor_id, patient_id, report_id, reason, duration_hours) VALUES (?, ?, NULL, ?, ?)', req.user.id, pid, reason, hours);
  audit(req, 'access.requested', { entity: 'access_request', entityId: id, patientId: pid, details: { hours } });
  notify(pid, 'Access request', `${req.user.full_name} wants to view your diagnostic reports for ${hours >= 48 ? hours / 24 + ' days' : hours + ' hours'}.`, '/patient/access', 'access');
  req.flash('success', 'Request sent. You will be notified when the patient responds.');
  res.redirect(`/doctor/patients?id=${pid}`);
});

// =============== Lists: prescriptions, test orders, report access, messages ===============
router.get('/prescriptions', (req, res) => {
  const list = db.all(`SELECT p.*, u.full_name AS patient_name, (SELECT GROUP_CONCAT(m.name, ', ') FROM prescription_items i JOIN medicines m ON m.id = i.medicine_id WHERE i.prescription_id = p.id) AS meds
                         FROM prescriptions p JOIN users u ON u.id = p.patient_id WHERE p.doctor_id = ? ORDER BY p.created_at DESC LIMIT 60`, req.user.id);
  const toWrite = db.all(`SELECT a.*, u.full_name AS patient_name FROM appointments a JOIN users u ON u.id = a.patient_id
                            WHERE a.doctor_id = ? AND a.status IN ('confirmed','completed') AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.appointment_id = a.id) AND a.proposed_time <= ?
                            ORDER BY a.proposed_time DESC LIMIT 8`, req.user.id, new Date(Date.now() + 86400000).toISOString());
  res.render('doctor/prescriptions', { title: 'Prescriptions', list, toWrite });
});
router.get('/test-orders', (req, res) => {
  const list = db.all(`SELECT o.*, t.name, u.full_name AS patient_name, c.name AS center_name, (SELECT id FROM reports r WHERE r.test_order_id = o.id) AS report_id
                         FROM test_orders o JOIN test_catalog t ON t.id = o.test_id JOIN users u ON u.id = o.patient_id LEFT JOIN centers c ON c.id = o.center_id
                        WHERE o.doctor_id = ? ORDER BY o.created_at DESC LIMIT 80`, req.user.id);
  for (const o of list) o.canView = o.report_id ? activeGrants(req.user.id, o.patient_id).some((g) => g.report_id === null || g.report_id === o.report_id) : false;
  res.render('doctor/test-orders', { title: 'Test orders', list });
});
router.get('/access', (req, res) => {
  const requests = db.all(`SELECT r.*, u.full_name AS patient_name FROM access_requests r JOIN users u ON u.id = r.patient_id WHERE r.doctor_id = ? ORDER BY r.id DESC LIMIT 40`, req.user.id);
  const grants = db.all(`SELECT g.*, u.full_name AS patient_name, t.name AS test_name FROM access_grants g JOIN users u ON u.id = g.patient_id LEFT JOIN reports r ON r.id = g.report_id LEFT JOIN test_catalog t ON t.id = r.test_id
                          WHERE g.doctor_id = ? AND g.revoked = 0 AND g.expires_at > ? ORDER BY g.expires_at`, req.user.id, db.now());
  res.render('doctor/access', { title: 'Report access', requests, grants });
});
router.get('/messages', (req, res) => {
  const threads = db.all(`SELECT a.id, a.status, u.full_name AS patient_name, a.patient_id, (SELECT body FROM appointment_messages m WHERE m.appointment_id = a.id ORDER BY m.id DESC LIMIT 1) AS last,
                            (SELECT created_at FROM appointment_messages m WHERE m.appointment_id = a.id ORDER BY m.id DESC LIMIT 1) AS at
                           FROM appointments a JOIN users u ON u.id = a.patient_id WHERE a.doctor_id = ? AND EXISTS (SELECT 1 FROM appointment_messages m WHERE m.appointment_id = a.id AND m.kind = 'message')
                          ORDER BY at DESC LIMIT 40`, req.user.id);
  const sel = req.query.id ? myAppt(req, req.query.id) : threads[0] ? myAppt(req, threads[0].id) : null;
  const messages = sel ? db.all('SELECT m.*, u.full_name FROM appointment_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.appointment_id = ? ORDER BY m.id', sel.id) : [];
  res.render('doctor/messages', { title: 'Messages', threads, sel, messages });
});

// =============== Profile ===============
router.get('/profile', (req, res) => res.render('doctor/profile', { title: 'Doctor profile', profile: db.get('SELECT * FROM doctor_profiles WHERE user_id = ?', req.user.id) }));
router.post('/location-sharing', (req, res) => {
  const on = req.body.on === '1' ? 1 : 0;
  db.run('UPDATE doctor_profiles SET share_location = ? WHERE user_id = ?', on, req.user.id);
  req.flash('success', on ? 'Live location sharing is on. Patients see your distance while this browser is open.' : 'Live location sharing is off. Patients see your chamber address.');
  res.redirect(req.get('referer') || '/doctor');
});
router.post('/profile', (req, res) => {
  const b = req.body;
  db.run('UPDATE doctor_profiles SET qualifications = ?, experience_years = ?, bio = ?, address = ?, lat = ?, lng = ?, fee = ? WHERE user_id = ?',
    b.qualifications || null, parseInt(b.experience_years, 10) || 0, String(b.bio || '').slice(0, 2000), b.address || null,
    b.lat === '' || isNaN(Number(b.lat)) ? null : Number(b.lat), b.lng === '' || isNaN(Number(b.lng)) ? null : Number(b.lng), Math.max(0, parseInt(b.fee, 10) || 0), req.user.id);
  req.flash('success', 'Profile saved. Specialty and license changes go through an administrator.');
  res.redirect('/doctor/profile');
});

module.exports = router;
