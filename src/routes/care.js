// Caregiver proxy and the shared care timeline (patients and Caregiver accounts).
const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/core');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');
const reminders = require('../services/reminders');
const health = require('../services/health');
const care = require('../services/caregivers');
const interactions = require('../services/interactions');

const router = express.Router();
router.use(requireRole('patient', 'caregiver'));

const deny = (res) => res.status(403).render('shared/error', { title: 'Access denied', message: 'You are not an approved caregiver for this patient, or the patient has ended your access.' });
const back = (pid) => `/care/timeline/${pid}`;

// ---------- Hub ----------
router.get('/', (req, res) => {
  const links = care.linksFor(req.user.id);
  const people = links.caringFor.map((l) => ({ ...l, s: care.summary(l) }));
  const order = { red: 0, amber: 1, green: 2 };
  people.sort((a, b) => order[a.s.level] - order[b.s.level] || a.full_name.localeCompare(b.full_name));
  if (req.user.role === 'caregiver' || req.query.view === 'people') {
    return res.render('care/dashboard', { title: 'Care dashboard', ...links, people });
  }
  const log = db.all(
    `SELECT a.action, a.created_at, u.full_name FROM audit_log a JOIN users u ON u.id = a.actor_id
      WHERE a.patient_id = ? AND a.action LIKE 'caregiver.%' AND a.actor_id != ? ORDER BY a.id DESC LIMIT 8`, req.user.id, req.user.id);
  res.render('care/index', { title: 'Caregivers & shared timeline', ...links, people, log, RELATIONSHIPS: care.RELATIONSHIPS, SCOPES: care.SCOPES });
});

// The patient invites a caregiver. The invite records consent and exactly what is shared.
router.post('/invite', (req, res) => {
  if (req.user.role !== 'patient') return res.redirect('/care');
  const email = String(req.body.email || '').trim().toLowerCase();
  const sc = care.scopesFromBody(req.body);
  if (req.body.consent !== 'yes') {
    req.flash('error', 'Tick the consent box to let this person see what you chose to share.');
    return res.redirect('/care');
  }
  if (!sc.share_reminders && !sc.share_vitals && !sc.share_reports) {
    req.flash('error', 'Choose at least one thing to share: medicine reminders, vitals or reports.');
    return res.redirect('/care');
  }
  const cg = db.get('SELECT id, full_name, role FROM users WHERE lower(email) = ?', email);
  if (!cg || !['patient', 'caregiver'].includes(cg.role)) {
    req.flash('error', 'No caregiver or patient account uses that email. Ask them to create a free Caregiver account first, then invite them again.');
    return res.redirect('/care');
  }
  if (cg.id === req.user.id) { req.flash('error', 'You cannot add yourself as your own caregiver.'); return res.redirect('/care'); }
  const existing = db.get("SELECT * FROM caregiver_links WHERE patient_id = ? AND caregiver_id = ? AND status IN ('pending','active')", req.user.id, cg.id);
  if (existing) { req.flash('error', `${cg.full_name} is already ${existing.status === 'active' ? 'your caregiver' : 'invited'}.`); return res.redirect('/care'); }
  const rel = care.RELATIONSHIPS.includes(req.body.relationship) ? req.body.relationship : 'Relative';
  const canAct = req.body.can_act === '1' ? 1 : 0;
  const { id } = db.run(
    `INSERT INTO caregiver_links (patient_id, caregiver_id, relationship, can_act, share_reminders, share_vitals, share_reports, invited_by, consent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.id, cg.id, rel, canAct, sc.share_reminders, sc.share_vitals, sc.share_reports, req.user.id, db.now());
  audit(req, 'caregiver.invited', { entity: 'caregiver_link', entityId: id, patientId: req.user.id, details: { caregiver: cg.id, can_act: canAct, ...sc } });
  notify(cg.id, 'Caregiver invitation', `${req.user.full_name} invited you to be their caregiver (${rel}). Accept to see their shared timeline.`, '/care', 'access');
  req.flash('success', `Invitation sent to ${cg.full_name}. Nothing is shared until they accept.`);
  res.redirect('/care');
});

// The invited caregiver accepts or declines.
router.post('/links/:id/:action(accept|decline)', (req, res) => {
  const l = db.get("SELECT * FROM caregiver_links WHERE id = ? AND caregiver_id = ? AND status = 'pending'", req.params.id, req.user.id);
  if (!l) return res.redirect('/care');
  const status = req.params.action === 'accept' ? 'active' : 'declined';
  db.run('UPDATE caregiver_links SET status = ?, responded_at = ? WHERE id = ?', status, db.now(), l.id);
  audit(req, `caregiver.${status === 'active' ? 'accepted' : 'declined'}`, { entity: 'caregiver_link', entityId: l.id, patientId: l.patient_id });
  notify(l.patient_id, status === 'active' ? 'Caregiver joined' : 'Caregiver invitation declined',
    `${req.user.full_name} ${status === 'active' ? 'accepted and can now see your shared timeline.' : 'declined your invitation.'}`, '/care', 'access');
  req.flash('success', status === 'active' ? 'You are now a caregiver. Their timeline is on your care dashboard.' : 'Invitation declined.');
  res.redirect('/care');
});

// Either side can end the link at any time.
router.post('/links/:id/revoke', (req, res) => {
  const l = db.get("SELECT * FROM caregiver_links WHERE id = ? AND (patient_id = ? OR caregiver_id = ?) AND status IN ('pending','active')", req.params.id, req.user.id, req.user.id);
  if (!l) return res.redirect('/care');
  db.run("UPDATE caregiver_links SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?", db.now(), req.user.id, l.id);
  audit(req, 'caregiver.revoked', { entity: 'caregiver_link', entityId: l.id, patientId: l.patient_id });
  const other = req.user.id === l.patient_id ? l.caregiver_id : l.patient_id;
  notify(other, 'Caregiver access ended', `${req.user.full_name} ended the caregiver link.`, '/care', 'access');
  req.flash('success', 'Caregiver access ended. They can no longer see or act on the timeline.');
  res.redirect('/care');
});

// The patient changes what is shared and whether the caregiver may act.
router.post('/links/:id/permission', (req, res) => {
  const l = db.get("SELECT * FROM caregiver_links WHERE id = ? AND patient_id = ? AND status IN ('pending','active')", req.params.id, req.user.id);
  if (!l) return res.redirect('/care');
  const canAct = req.body.can_act === '1' ? 1 : 0;
  const sc = req.body.scopes === '1' ? care.scopesFromBody(req.body) : { share_reminders: l.share_reminders, share_vitals: l.share_vitals, share_reports: l.share_reports };
  db.run('UPDATE caregiver_links SET can_act = ?, share_reminders = ?, share_vitals = ?, share_reports = ? WHERE id = ?', canAct, sc.share_reminders, sc.share_vitals, sc.share_reports, l.id);
  audit(req, 'caregiver.permission', { entity: 'caregiver_link', entityId: l.id, patientId: l.patient_id, details: { can_act: canAct, ...sc } });
  notify(l.caregiver_id, 'Caregiver permissions changed', `${req.user.full_name} updated what you can see and do on their timeline.`, '/care', 'access');
  req.flash('success', canAct ? 'Permissions saved. Your caregiver can act for you.' : 'Permissions saved. Your caregiver can only view.');
  res.redirect('/care');
});

// ---------- Shared timeline ----------
router.get('/timeline/:patientId', (req, res) => {
  const a = care.access(req.user, req.params.patientId);
  if (!a.ok) return deny(res);
  const pid = Number(req.params.patientId);
  const patient = db.get('SELECT u.id, u.full_name, u.phone, p.patient_code, p.blood_group, p.date_of_birth, p.emergency_contact FROM users u LEFT JOIN patient_profiles p ON p.user_id = u.id WHERE u.id = ?', pid);
  const since = a.link ? a.link.last_viewed_at || a.link.responded_at : null;
  if (!a.self) {
    audit(req, 'caregiver.timeline_view', { entity: 'patient', entityId: pid, patientId: pid });
    db.run('UPDATE caregiver_links SET last_viewed_at = ? WHERE id = ?', db.now(), a.link.id);
  }
  const days = [3, 7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const all = care.timeline(pid, days, a.scopes);
  const filter = ['dose', 'vital', 'report', 'appointment', 'note'].includes(req.query.type) ? req.query.type : 'all';
  const doses = a.scopes.reminders ? reminders.today(pid).map((d) => ({ ...d, by: care.nameOf(d.acted_by), missed: care.isMissed(d) })) : [];
  const caregivers = db.all("SELECT l.*, u.full_name FROM caregiver_links l JOIN users u ON u.id = l.caregiver_id WHERE l.patient_id = ? AND l.status = 'active'", pid);
  res.render('care/timeline', {
    title: a.self ? 'My shared timeline' : `${patient.full_name}'s timeline`,
    patient, access: a, events: filter === 'all' ? all : all.filter((e) => e.type === filter), filter, days, since,
    newCount: since ? all.filter((e) => e.at > since && e.at <= new Date().toISOString() && e.byId !== req.user.id).length : 0,
    doses, adherence: a.scopes.reminders ? reminders.adherence(pid) : null, vitals: a.scopes.vitals ? health.overview(pid) : null, fmt: health.fmt,
    alerts: a.scopes.reminders ? interactions.forPatient(pid) : [], caregivers,
  });
});

router.post('/timeline/:patientId/dose/:doseId/:status(taken|skipped)', (req, res) => {
  const a = care.access(req.user, req.params.patientId);
  const pid = Number(req.params.patientId);
  if (!a.ok) return deny(res);
  if (!a.canAct || !a.scopes.reminders) { req.flash('error', 'The patient has allowed you to view only, not to act for them.'); return res.redirect(back(pid)); }
  const d = db.get('SELECT d.id, r.medicine_name FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id WHERE d.id = ? AND r.patient_id = ?', req.params.doseId, pid);
  if (!d || !reminders.mark(pid, d.id, req.params.status, a.self ? null : req.user.id)) { req.flash('error', 'That dose could not be updated.'); return res.redirect(back(pid)); }
  if (!a.self) {
    audit(req, `caregiver.dose_${req.params.status}`, { entity: 'dose', entityId: d.id, patientId: pid, details: { medicine: d.medicine_name } });
    notify(pid, `Dose marked ${req.params.status}`, `${req.user.full_name} (your caregiver) marked ${d.medicine_name} as ${req.params.status}.`, back(pid), 'reminder');
  }
  req.flash('success', `${d.medicine_name} marked as ${req.params.status}.`);
  res.redirect(req.body.from === 'dashboard' ? '/care' : back(pid));
});

router.post('/timeline/:patientId/reading', (req, res) => {
  const a = care.access(req.user, req.params.patientId);
  const pid = Number(req.params.patientId);
  if (!a.ok) return deny(res);
  if (!a.canAct || !a.scopes.vitals) { req.flash('error', 'The patient has allowed you to view only, not to act for them.'); return res.redirect(back(pid)); }
  const r = care.addReading(pid, req.body, a.self ? null : req.user.id);
  if (r.error) { req.flash('error', r.error); return res.redirect(back(pid)); }
  const label = `${health.KINDS[r.reading.kind].name} ${health.fmt(r.reading)} ${health.KINDS[r.reading.kind].unit}`;
  if (!a.self) {
    audit(req, 'caregiver.reading_logged', { entity: 'health_reading', entityId: r.id, patientId: pid, details: { reading: label } });
    notify(pid, 'Reading logged by your caregiver', `${req.user.full_name} logged ${label}: ${r.status.note}.`, back(pid), r.status.level === 'urgent' ? 'alert' : 'info');
  }
  if (['urgent', 'doctor'].includes(r.status.level)) {
    const who = db.get('SELECT full_name FROM users WHERE id = ?', pid).full_name;
    care.alertCaregivers(pid, 'vitals', `${r.status.level === 'urgent' ? 'Urgent reading' : 'Reading to review'}: ${who}`, `${label}: ${r.status.note}.`, 'alert', req.user.id);
  }
  if (r.status.level === 'urgent') req.flash('error', `${label}: ${r.status.note}. If the patient feels unwell, call 999 or go to the nearest emergency department now.`);
  else req.flash('success', `Saved ${label}. ${r.status.note}.`);
  res.redirect(back(pid));
});

// Care notes: the patient and caregivers leave short handover messages on the timeline.
router.post('/timeline/:patientId/note', (req, res) => {
  const a = care.access(req.user, req.params.patientId);
  const pid = Number(req.params.patientId);
  if (!a.ok) return deny(res);
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (!body) { req.flash('error', 'Write a short note first.'); return res.redirect(back(pid)); }
  const { id } = db.run('INSERT INTO care_notes (patient_id, author_id, body) VALUES (?, ?, ?)', pid, req.user.id, body);
  if (!a.self) {
    audit(req, 'caregiver.note', { entity: 'care_note', entityId: id, patientId: pid });
    notify(pid, `Care note from ${req.user.full_name}`, body.slice(0, 140), back(pid), 'message');
  }
  care.alertCaregivers(pid, null, `Care note from ${req.user.full_name}`, body.slice(0, 140), 'message', req.user.id);
  req.flash('success', 'Note added to the shared timeline.');
  res.redirect(back(pid));
});

module.exports = router;
