// Caregiver proxy: with the patient's explicit consent, a caregiver (a Caregiver account, or any patient account
// such as a family member) can follow the patient's shared timeline and, if allowed, act for them.
// Consent model:
//  - Only the patient invites. The invite stores the moment of consent (consent_at) and exactly what is shared:
//    medicine reminders, vitals, reports (each can be switched on or off), and whether the caregiver may act.
//  - Nothing is shared until the caregiver accepts. The patient can change permissions or revoke at any time;
//    the caregiver can step down. Every caregiver view and action is audit-logged and shown as "by <name>".
//  - Caregivers are alerted when a dose is missed or a dangerous reading is logged.
const db = require('../db');
const reminders = require('./reminders');
const health = require('./health');
const { notify } = require('./notify');

const RELATIONSHIPS = ['Son', 'Daughter', 'Spouse', 'Parent', 'Sibling', 'Grandchild', 'Relative', 'Friend', 'Professional carer'];
const SCOPES = { reminders: 'Medicine reminders', vitals: 'Vitals (BP, sugar, pulse, oxygen, weight)', reports: 'Reports and lab documents' };
const MISSED_AFTER_MS = 60 * 60000; // a dose still not taken 1 hour after its time counts as missed

const scopesOf = (l) => ({ reminders: !!l.share_reminders, vitals: !!l.share_vitals, reports: !!l.share_reports });
const ALL = { reminders: true, vitals: true, reports: true };

function activeLink(patientId, caregiverId) {
  return db.get("SELECT * FROM caregiver_links WHERE patient_id = ? AND caregiver_id = ? AND status = 'active'", patientId, caregiverId);
}

/** What may `user` see and do on `patientId`'s timeline? */
function access(user, patientId) {
  const pid = Number(patientId);
  if (!user || !pid) return { ok: false };
  if (user.role === 'patient' && user.id === pid) return { ok: true, self: true, canAct: true, scopes: ALL };
  if (!['patient', 'caregiver'].includes(user.role)) return { ok: false };
  const link = activeLink(pid, user.id);
  return link ? { ok: true, self: false, canAct: !!link.can_act, scopes: scopesOf(link), link } : { ok: false };
}

function linksFor(userId) {
  const mine = db.all(
    `SELECT l.*, u.full_name, u.email, u.role AS caregiver_role FROM caregiver_links l JOIN users u ON u.id = l.caregiver_id
      WHERE l.patient_id = ? AND l.status IN ('pending','active') ORDER BY l.status = 'active' DESC, l.id DESC`, userId);
  const invites = db.all(
    `SELECT l.*, u.full_name, u.email FROM caregiver_links l JOIN users u ON u.id = l.patient_id
      WHERE l.caregiver_id = ? AND l.status = 'pending' ORDER BY l.id DESC`, userId);
  const caringFor = db.all(
    `SELECT l.*, u.full_name, u.email, u.phone, p.patient_code, p.date_of_birth, p.blood_group, p.emergency_contact
       FROM caregiver_links l JOIN users u ON u.id = l.patient_id LEFT JOIN patient_profiles p ON p.user_id = l.patient_id
      WHERE l.caregiver_id = ? AND l.status = 'active' ORDER BY u.full_name`, userId);
  return { mine, invites, caringFor };
}

const nameOf = (id) => (id ? (db.get('SELECT full_name FROM users WHERE id = ?', id) || {}).full_name : null);
const isMissed = (d) => d.status === 'due' && new Date(d.due_at).getTime() < Date.now() - MISSED_AFTER_MS;

/** One merged, newest-first timeline of what the viewer is allowed to see. */
function timeline(patientId, days = 7, scopes = ALL) {
  reminders.materialize(patientId);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const height = (db.get('SELECT height_cm FROM patient_profiles WHERE user_id = ?', patientId) || {}).height_cm;
  const events = [];

  if (scopes.reminders) {
    for (const d of db.all(
      `SELECT d.*, r.medicine_name, r.dose FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id
        WHERE r.patient_id = ? AND d.due_at >= ? AND d.due_at <= ? ORDER BY d.due_at DESC`, patientId, since, endToday.toISOString())) {
      const missed = isMissed(d);
      events.push({
        at: d.status === 'due' ? d.due_at : d.acted_at || d.due_at, type: 'dose', icon: 'pill',
        tone: d.status === 'taken' ? 'green' : d.status === 'skipped' || missed ? 'red' : 'orange',
        title: `${d.medicine_name} ${d.dose ? '(' + d.dose + ')' : ''}`.trim(),
        detail: d.status === 'taken' ? 'Dose taken' : d.status === 'skipped' ? 'Dose skipped' : missed ? 'Dose missed' : 'Dose due',
        by: nameOf(d.acted_by), byId: d.acted_by,
      });
    }
  }
  if (scopes.vitals) {
    for (const r of db.all('SELECT * FROM health_readings WHERE patient_id = ? AND measured_at >= ? ORDER BY measured_at DESC', patientId, since)) {
      const s = health.classify(r, height);
      events.push({
        at: r.measured_at, type: 'vital', icon: 'activity', tone: { normal: 'green', watch: 'orange', doctor: 'red', urgent: 'red' }[s.level] || 'gray',
        title: `${health.KINDS[r.kind].name}: ${health.fmt(r)} ${health.KINDS[r.kind].unit}`, detail: s.note, by: nameOf(r.recorded_by), byId: r.recorded_by,
      });
    }
  }
  if (scopes.reports) {
    const reportSince = new Date(Date.now() - Math.max(days, 30) * 86400000).toISOString();
    for (const r of db.all(
      `SELECT r.id, r.created_at, r.summary, t.name AS test, c.name AS center FROM reports r
         JOIN test_catalog t ON t.id = r.test_id JOIN centers c ON c.id = r.center_id
        WHERE r.patient_id = ? AND r.created_at >= ? ORDER BY r.created_at DESC`, patientId, reportSince)) {
      events.push({ at: r.created_at, type: 'report', icon: 'file', tone: 'purple', title: `${r.test} report`, detail: `${r.center}${r.summary ? ' · ' + r.summary : ''}`, link: `/files/report/${r.id}` });
    }
    for (const d of db.all('SELECT id, title, doc_date, created_at, file_path FROM health_documents WHERE patient_id = ? AND created_at >= ? AND report_id IS NULL ORDER BY created_at DESC', patientId, reportSince)) {
      events.push({ at: d.created_at, type: 'report', icon: 'file', tone: 'purple', title: d.title, detail: `Health document · ${d.doc_date}`, link: d.file_path ? `/files/health-doc/${d.id}` : null });
    }
  }
  for (const a of db.all(
    `SELECT a.*, u.full_name AS doctor FROM appointments a JOIN users u ON u.id = a.doctor_id
      WHERE a.patient_id = ? AND a.proposed_time IS NOT NULL AND a.proposed_time >= ? AND a.status IN ('confirmed','completed','proposed')
      ORDER BY a.proposed_time DESC`, patientId, since)) {
    events.push({ at: a.proposed_time, type: 'appointment', icon: 'calendar', tone: a.status === 'completed' ? 'green' : 'blue', title: `Appointment with ${a.doctor}`, detail: a.status === 'completed' ? 'Completed' : a.status === 'proposed' ? 'Time proposed' : 'Confirmed' });
  }
  for (const n of db.all('SELECT n.*, u.full_name FROM care_notes n JOIN users u ON u.id = n.author_id WHERE n.patient_id = ? AND n.created_at >= ? ORDER BY n.created_at DESC', patientId, since)) {
    events.push({ at: n.created_at, type: 'note', icon: 'message', tone: 'blue', title: `Care note from ${n.full_name}`, detail: n.body, byId: n.author_id });
  }
  return events.sort((x, y) => (x.at < y.at ? 1 : -1));
}

/** At-a-glance care status for one patient, as seen through one caregiver link. */
function summary(link) {
  const pid = link.patient_id;
  const scopes = scopesOf(link);
  const out = { level: 'green', reasons: [], doses: [], missed: 0, taken: 0, due: 0, vitals: [], alerts: [], newCount: 0, adherence: null };
  if (scopes.reminders) {
    out.doses = reminders.today(pid);
    for (const d of out.doses) {
      if (d.status === 'taken') out.taken++;
      else if (d.status === 'skipped' || isMissed(d)) out.missed++;
      else out.due++;
    }
    out.adherence = reminders.adherence(pid);
    if (out.missed) out.reasons.push({ level: 'red', text: `${out.missed} dose${out.missed > 1 ? 's' : ''} missed or skipped today` });
  }
  if (scopes.vitals) {
    const o = health.overview(pid);
    for (const k of Object.values(o.kinds)) {
      if (!k.last || !k.status) continue;
      out.vitals.push(k);
      if (k.status.level === 'urgent') out.reasons.push({ level: 'red', text: `${k.name} ${health.fmt(k.last)} ${k.unit}: ${k.status.note}` });
      else if (k.status.level === 'doctor') out.reasons.push({ level: 'amber', text: `${k.name} ${health.fmt(k.last)} ${k.unit}: ${k.status.note}` });
    }
  }
  if (scopes.reminders) {
    out.alerts = require('./interactions').forPatient(pid);
    for (const a of out.alerts) out.reasons.push({ level: 'amber', text: `Medicine safety: ${a.drugs.map((d) => d[0].toUpperCase() + d.slice(1)).join(' + ')} needs a doctor’s review` });
  }
  const since = link.last_viewed_at || link.responded_at || link.created_at;
  out.newCount = timeline(pid, 7, scopes).filter((e) => e.at > since && e.at <= new Date().toISOString() && e.byId !== link.caregiver_id).length;
  out.level = out.reasons.some((r) => r.level === 'red') ? 'red' : out.reasons.length ? 'amber' : 'green';
  return out;
}

/** Notify every active caregiver who may see `scope` for this patient. */
function alertCaregivers(patientId, scope, title, body, kind = 'alert', exceptId = null) {
  const col = { reminders: 'share_reminders', vitals: 'share_vitals', reports: 'share_reports' }[scope];
  const rows = db.all(`SELECT caregiver_id FROM caregiver_links WHERE patient_id = ? AND status = 'active'${col ? ` AND ${col} = 1` : ''}`, patientId);
  for (const r of rows) if (r.caregiver_id !== exceptId) notify(r.caregiver_id, title, body, `/care/timeline/${patientId}`, kind);
  return rows.length;
}

/** Runs every minute from the reminder scheduler: tell caregivers about doses missed by more than an hour. */
function alertMissedDoses() {
  const cutoff = new Date(Date.now() - MISSED_AFTER_MS).toISOString();
  const since = new Date(Date.now() - 6 * 3600000).toISOString();
  const rows = db.all(
    `SELECT d.id, d.due_at, r.patient_id, r.medicine_name, u.full_name FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id
       JOIN users u ON u.id = r.patient_id
      WHERE d.status = 'due' AND d.caregiver_alerted = 0 AND d.due_at <= ? AND d.due_at >= ?
        AND EXISTS (SELECT 1 FROM caregiver_links l WHERE l.patient_id = r.patient_id AND l.status = 'active' AND l.share_reminders = 1)`, cutoff, since);
  for (const d of rows) {
    const t = new Date(d.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    alertCaregivers(d.patient_id, 'reminders', `Missed dose: ${d.full_name}`, `${d.full_name} has not taken ${d.medicine_name} (due ${t}). Check in, or mark it on their timeline.`, 'reminder');
    db.run('UPDATE dose_logs SET caregiver_alerted = 1 WHERE id = ?', d.id);
  }
  return rows.length;
}

/** Validate and save a vital reading; returns { id, reading, status } or { error }. */
function addReading(patientId, body, recordedBy = null) {
  const kind = body.kind;
  if (!health.KINDS[kind]) return { error: 'Choose a reading type.' };
  const v1 = Number(body.value1);
  const v2 = kind === 'bp' ? Number(body.value2) : null;
  const RANGE = { bp: [50, 260], sugar: [1, 40], weight: [2, 300], pulse: [20, 250], spo2: [50, 100] };
  if (!(v1 >= RANGE[kind][0] && v1 <= RANGE[kind][1]) || (kind === 'bp' && !(v2 >= 30 && v2 <= 180 && v2 < v1))) {
    return { error: 'That reading does not look right. Check the numbers and try again.' };
  }
  const when = body.measured_at ? new Date(body.measured_at) : new Date();
  const measured = isNaN(when) || when > new Date() ? new Date() : when;
  const { id } = db.run('INSERT INTO health_readings (patient_id, kind, value1, value2, context, measured_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    patientId, kind, v1, v2, kind === 'sugar' ? (body.context === 'fasting' ? 'fasting' : 'random') : null, measured.toISOString(), recordedBy);
  const r = db.get('SELECT * FROM health_readings WHERE id = ?', id);
  const height = (db.get('SELECT height_cm FROM patient_profiles WHERE user_id = ?', patientId) || {}).height_cm;
  return { id, reading: r, status: health.classify(r, height) };
}

/** Parse the scope checkboxes of an invite / permission form. */
function scopesFromBody(b) {
  return { share_reminders: b.share_reminders === '1' ? 1 : 0, share_vitals: b.share_vitals === '1' ? 1 : 0, share_reports: b.share_reports === '1' ? 1 : 0 };
}

module.exports = { RELATIONSHIPS, SCOPES, MISSED_AFTER_MS, access, activeLink, linksFor, timeline, summary, alertCaregivers, alertMissedDoses, addReading, nameOf, scopesOf, scopesFromBody, isMissed };
