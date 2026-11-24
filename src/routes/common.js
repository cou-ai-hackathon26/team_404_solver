// Shared by all roles: notifications, secure file access, account security, search.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { requireAuth, ah } = require('../middleware/core');
const { subscribe } = require('../services/notify');
const { audit } = require('../services/audit');
const { canViewReport } = require('../services/access');

const router = express.Router();
const sidHash = (sid) => crypto.createHash('sha256').update(sid).digest('hex').slice(0, 16);

// ---------- Notifications ----------
router.get('/notifications', requireAuth, (req, res) => {
  const filter = req.query.filter === 'unread' ? 'unread' : 'all';
  const items = db.all(`SELECT * FROM notifications WHERE user_id = ? ${filter === 'unread' ? 'AND is_read = 0' : ''} ORDER BY id DESC LIMIT 100`, req.user.id);
  res.render('shared/notifications', { title: 'Notifications', items, filter });
});
router.get('/notifications/:id/open', requireAuth, (req, res) => {
  const n = db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!n) return res.redirect('/notifications');
  db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', n.id);
  res.redirect(n.link || '/notifications');
});
router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.user.id);
  res.redirect(req.get('referer') || '/notifications');
});
router.get('/notifications/stream', requireAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  const unsubscribe = subscribe(req.user.id, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
});

// ---------- Secure files (stored outside /public, every access checked) ----------
function sendStored(res, relPath, name, download) {
  const abs = path.join(config.uploadDir, relPath);
  if (!abs.startsWith(config.uploadDir) || !fs.existsSync(abs)) return res.status(404).render('shared/error', { title: 'File missing', message: 'The file could not be found on the server.' });
  res.set('Cache-Control', 'private, no-store');
  if (download) return res.download(abs, name);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
  return res.sendFile(abs);
}

router.get('/files/report/:id', requireAuth, (req, res) => {
  const report = db.get('SELECT * FROM reports WHERE id = ?', req.params.id);
  if (!canViewReport(req.user, report)) {
    if (report) audit(req, 'report.access_denied', { entity: 'report', entityId: report.id, patientId: report.patient_id });
    return res.status(403).render('shared/error', { title: 'Access denied', message: 'You do not have permission to view this report. Doctors need the patient’s approval first.' });
  }
  const download = req.query.download === '1';
  audit(req, download ? 'report.download' : 'report.view', { entity: 'report', entityId: report.id, patientId: report.patient_id });
  sendStored(res, report.file_path, report.original_name, download);
});

router.get('/files/prescription/:id', requireAuth, (req, res) => {
  const p = db.get('SELECT * FROM prescriptions WHERE id = ?', req.params.id);
  if (!p || !p.image_path) return res.status(404).render('shared/error', { title: 'Not found', message: 'No file for this prescription.' });
  const u = req.user;
  const ok = (u.role === 'patient' && p.patient_id === u.id) || (u.role === 'doctor' && p.doctor_id === u.id)
    || (u.role === 'pharmacy' && db.get('SELECT 1 FROM orders WHERE prescription_id = ? AND pharmacy_id = ?', p.id, u.pharmacyId));
  if (!ok) return res.status(403).render('shared/error', { title: 'Access denied', message: 'You cannot view this prescription.' });
  audit(req, 'prescription.view', { entity: 'prescription', entityId: p.id, patientId: p.patient_id });
  sendStored(res, p.image_path, p.original_name || 'prescription', false);
});

router.get('/files/document/:id', requireAuth, (req, res) => {
  const d = db.get('SELECT * FROM provider_documents WHERE id = ?', req.params.id);
  if (!d || (req.user.role !== 'admin' && d.user_id !== req.user.id)) return res.status(403).render('shared/error', { title: 'Access denied', message: 'You cannot view this document.' });
  audit(req, 'document.view', { entity: 'document', entityId: d.id });
  sendStored(res, d.file_path, d.original_name, false);
});

// ---------- Account & security (all roles; patients use their own settings page) ----------
function sessionsOf(req) {
  return db.all("SELECT sid, data, expires FROM sessions WHERE json_extract(data, '$.userId') = ? AND expires > ?", req.user.id, Date.now())
    .map((s) => { const d = JSON.parse(s.data); return { key: sidHash(s.sid), current: s.sid === req.sessionID, ua: d.ua || 'Unknown browser', ip: d.ip, loginAt: d.loginAt }; });
}
router.get('/account', requireAuth, (req, res) => {
  if (req.user.role === 'patient') return res.redirect('/patient/profile?tab=security');
  res.render('shared/account', { title: 'Account & security', sessions: sessionsOf(req) });
});
router.post('/account/password', requireAuth, ah(async (req, res) => {
  const back = req.user.role === 'patient' ? '/patient/profile?tab=security' : '/account';
  const row = db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!(await bcrypt.compare(req.body.current_password || '', row.password_hash))) { req.flash('error', 'Current password is incorrect.'); return res.redirect(back); }
  const pw = req.body.password || '';
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw) || pw !== req.body.confirm_password) {
    req.flash('error', 'New password must be 8+ characters with a letter and a number, and both entries must match.');
    return res.redirect(back);
  }
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(pw, 12), req.user.id);
  db.run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid <> ?", req.user.id, req.sessionID);
  audit(req, 'auth.password_changed', { entity: 'user', entityId: req.user.id });
  req.flash('success', 'Password changed. Other devices have been signed out.');
  res.redirect(back);
}));
router.post('/account/details', requireAuth, (req, res) => {
  const name = String(req.body.full_name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!name || !/^\+?[0-9 -]{7,20}$/.test(phone)) { req.flash('error', 'Enter your name and a valid phone number.'); return res.redirect('/account'); }
  db.run('UPDATE users SET full_name = ?, phone = ? WHERE id = ?', name, phone, req.user.id);
  req.flash('success', 'Details saved.');
  res.redirect('/account');
});
router.post('/account/sessions/:key/logout', requireAuth, (req, res) => {
  for (const s of db.all("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ?", req.user.id)) {
    if (sidHash(s.sid) === req.params.key && s.sid !== req.sessionID) db.run('DELETE FROM sessions WHERE sid = ?', s.sid);
  }
  req.flash('success', 'That device has been signed out.');
  res.redirect(req.get('referer') || '/account');
});

// ---------- Search ----------
router.get('/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const like = `%${q}%`;
  const out = { doctors: [], medicines: [], reports: [], tests: [], patients: [] };
  if (q) {
    out.doctors = db.all(`SELECT u.id, u.full_name, d.specialty, d.fee FROM users u JOIN doctor_profiles d ON d.user_id = u.id
                           WHERE u.status = 'active' AND d.verified = 1 AND (u.full_name LIKE ? OR d.specialty LIKE ?) LIMIT 8`, like, like);
    out.medicines = db.all('SELECT * FROM medicines WHERE name LIKE ? OR brand LIKE ? LIMIT 8', like, like);
    out.tests = db.all('SELECT * FROM test_catalog WHERE name LIKE ? OR category LIKE ? LIMIT 8', like, like);
    if (req.user.role === 'patient') {
      out.reports = db.all(`SELECT r.id, t.name, r.test_date, c.name AS center FROM reports r JOIN test_catalog t ON t.id = r.test_id JOIN centers c ON c.id = r.center_id
                             WHERE r.patient_id = ? AND (t.name LIKE ? OR c.name LIKE ?) LIMIT 8`, req.user.id, like, like);
    }
    if (req.user.role === 'doctor') {
      out.patients = db.all(`SELECT DISTINCT u.id, u.full_name FROM appointments a JOIN users u ON u.id = a.patient_id WHERE a.doctor_id = ? AND u.full_name LIKE ? LIMIT 8`, req.user.id, like);
    }
  }
  res.render('shared/search', { title: 'Search', q, out });
});

// ---------- Live location (patients, doctors, ambulances) ----------
// The browser posts its GPS position while a map page is open (or a doctor/ambulance shares location).
router.post('/api/location', requireAuth, (req, res) => {
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return res.status(400).json({ ok: false });
  const now = db.now();
  const u = req.user;
  if (u.role === 'patient') db.run('UPDATE patient_profiles SET live_lat = ?, live_lng = ?, live_at = ? WHERE user_id = ?', lat, lng, now, u.id);
  else if (u.role === 'doctor') db.run('UPDATE doctor_profiles SET live_lat = ?, live_lng = ?, live_at = ? WHERE user_id = ?', lat, lng, now, u.id);
  else if (u.role === 'ambulance') db.run('UPDATE ambulances SET lat = ?, lng = ?, location_at = ? WHERE owner_user_id = ?', lat, lng, now, u.id);
  res.json({ ok: true, at: now });
});
router.get('/api/doctors/:id/location', requireAuth, (req, res) => {
  const d = db.get('SELECT lat, lng, live_lat, live_lng, live_at, share_location, address FROM doctor_profiles WHERE user_id = ? AND verified = 1', req.params.id);
  if (!d) return res.status(404).json({ ok: false });
  const live = d.share_location && d.live_lat != null && Date.now() - new Date(d.live_at || 0) < 30 * 60_000;
  res.json({ ok: true, live: !!live, lat: live ? d.live_lat : d.lat, lng: live ? d.live_lng : d.lng, at: live ? d.live_at : null, address: d.address });
});

// ---------- Health documents (patient's own uploads) ----------
router.get('/files/health-doc/:id', requireAuth, (req, res) => {
  const d = db.get('SELECT * FROM health_documents WHERE id = ?', req.params.id);
  const care = d && require('../services/caregivers').access(req.user, d.patient_id);
  if (!d || !d.file_path || !care.ok) return res.status(403).render('shared/error', { title: 'Access denied', message: 'You cannot view this document.' });
  if (!care.self) audit(req, 'caregiver.document_view', { entity: 'health_document', entityId: d.id, patientId: d.patient_id });
  sendStored(res, d.file_path, d.original_name || 'document', false);
});

module.exports = router;
