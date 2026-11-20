// Diagnostic center portal: test requests, sample collection, report upload,
// test catalog and prices, staff and billing.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireRole, notFound, ah } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { uploader, handleUpload, relative } = require('../services/uploads');
const stats = require('../stats');
const H = require('../helpers');

const router = express.Router();
router.use(requireRole('center'));
router.use((req, res, next) => {
  if (!req.user.centerId) return res.status(403).render('shared/error', { title: 'No center', message: 'Your account is not linked to a diagnostic center.' });
  res.locals.center = db.get('SELECT * FROM centers WHERE id = ?', req.user.centerId);
  next();
});
const adminOnly = (req, res, next) => (req.user.isCenterAdmin ? next() : res.status(403).render('shared/error', { title: 'Administrators only', message: 'Only the center administrator can do this.' }));
const OPEN = "('requested','scheduled','sample_collected')";
const reqSql = `SELECT o.*, t.name AS test_name, t.category, u.full_name AS patient_name, u.phone AS patient_phone, d.full_name AS doctor_name
                  FROM test_orders o JOIN test_catalog t ON t.id = o.test_id JOIN users u ON u.id = o.patient_id LEFT JOIN users d ON d.id = o.doctor_id`;
function myRequest(req, id) {
  return db.get(`${reqSql} WHERE o.id = ? AND o.center_id = ?`, id, req.user.centerId);
}

// =============== Dashboard ===============
router.get('/', (req, res) => {
  const c = req.user.centerId;
  const t = new Date();
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString();
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).toISOString();
  const n = (sql, ...p) => db.get(sql, ...p).n;
  const s = {
    newReq: n("SELECT COUNT(*) n FROM test_orders WHERE center_id = ? AND status = 'requested'", c),
    sinceMorning: n("SELECT COUNT(*) n FROM test_orders WHERE center_id = ? AND status = 'requested' AND created_at >= ?", c, start),
    toCollect: n("SELECT COUNT(*) n FROM test_orders WHERE center_id = ? AND status = 'scheduled'", c),
    dueHour: n("SELECT COUNT(*) n FROM test_orders WHERE center_id = ? AND status = 'scheduled' AND scheduled_at <= ?", c, new Date(Date.now() + 3600000).toISOString()),
    toUpload: n("SELECT COUNT(*) n FROM test_orders WHERE center_id = ? AND status = 'sample_collected'", c),
    sentToday: n('SELECT COUNT(*) n FROM reports WHERE center_id = ? AND created_at >= ? AND created_at < ?', c, start, end),
  };
  const oldest = db.get("SELECT collected_at FROM test_orders WHERE center_id = ? AND status = 'sample_collected' ORDER BY collected_at", c);
  const cards = [
    { href: '/center/requests', tile: 't-blue', icon: 'flask', color: 'blue', label: 'New test requests', value: s.newReq, sub: `${s.sinceMorning} since morning`, trend: stats.daily('SELECT created_at AS t FROM test_orders WHERE center_id = ?', [c]) },
    { href: '/center/collection', tile: 't-orange', icon: 'calendar', color: 'orange', label: 'Samples to collect', value: s.toCollect, sub: `${s.dueHour} due this hour`, trend: stats.daily('SELECT scheduled_at AS t FROM test_orders WHERE center_id = ?', [c]) },
    { href: '/center/upload', tile: 't-red', icon: 'file', color: 'red', label: 'Reports to upload', value: s.toUpload, sub: oldest ? `Oldest from ${H.friendly(oldest.collected_at).split(',')[0].toLowerCase()}` : 'All uploaded', trend: stats.daily('SELECT collected_at AS t FROM test_orders WHERE center_id = ?', [c]) },
    { href: '/center/upload', tile: 't-teal', icon: 'shield', color: 'teal', label: 'Reports sent today', value: s.sentToday, sub: 'Patients notified', trend: stats.daily('SELECT created_at AS t FROM reports WHERE center_id = ?', [c]) },
  ];
  const week = [];
  for (let d = 5; d >= 0; d--) {
    const a = new Date(t.getFullYear(), t.getMonth(), t.getDate() - d);
    const b = new Date(t.getFullYear(), t.getMonth(), t.getDate() - d + 1);
    week.push({ label: a.toLocaleDateString('en-US', { weekday: 'short' }), n: n('SELECT COUNT(*) n FROM reports WHERE center_id = ? AND created_at >= ? AND created_at < ?', c, a.toISOString(), b.toISOString()) });
  }
  const ring = [
    { label: 'Scheduled', value: s.toCollect, color: '#4f46e5' },
    { label: 'Sample pending', value: s.newReq, color: '#f59e0b' },
    { label: 'Report ready', value: s.toUpload, color: '#10b981' },
  ];
  const list = db.all(`${reqSql} WHERE o.center_id = ? AND o.status IN ${OPEN} ORDER BY CASE o.status WHEN 'scheduled' THEN 0 WHEN 'requested' THEN 1 ELSE 2 END, COALESCE(o.scheduled_at, o.created_at) LIMIT 4`, c);
  const next = db.get(`${reqSql} WHERE o.center_id = ? AND o.status = 'scheduled' AND o.scheduled_at >= ? ORDER BY o.scheduled_at`, c, new Date(Date.now() - 3600000).toISOString())
    || db.get(`${reqSql} WHERE o.center_id = ? AND o.status = 'scheduled' ORDER BY o.scheduled_at`, c);
  const uploadable = db.all(`${reqSql} WHERE o.center_id = ? AND o.status IN ${OPEN} ORDER BY (o.status = 'sample_collected') DESC, o.updated_at LIMIT 20`, c);
  res.render('center/dashboard', { title: 'Dashboard', s, cards, week, ring, list, next, uploadable });
});

// =============== Requests and sample collection ===============
router.get('/requests', (req, res) => {
  const f = ['requested', 'scheduled', 'sample_collected', 'completed'].includes(req.query.f) ? req.query.f : 'open';
  const where = f === 'open' ? `o.status IN ${OPEN}` : 'o.status = ?';
  const list = db.all(`${reqSql} WHERE o.center_id = ? AND ${where} ORDER BY o.updated_at DESC LIMIT 100`, req.user.centerId, ...(f === 'open' ? [] : [f]));
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM test_orders WHERE center_id = ? GROUP BY status', req.user.centerId).map((r) => [r.status, r.n]));
  res.render('center/requests', { title: 'Test requests', list, f, counts });
});
router.post('/requests/:id/schedule', (req, res) => {
  const o = myRequest(req, req.params.id);
  if (!o || !['requested', 'scheduled'].includes(o.status)) return notFound(res, 'Request');
  const when = new Date(req.body.scheduled_at);
  if (isNaN(when)) { req.flash('error', 'Choose a valid date and time.'); return res.redirect('back'); }
  db.run("UPDATE test_orders SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?", when.toISOString(), db.now(), o.id);
  notify(o.patient_id, 'Test scheduled', `${res.locals.center.name} booked your ${o.test_name} for ${H.friendly(when)}. Please visit the center.`, '/patient/tests', 'test');
  req.flash('success', `${o.patient_name} notified of the ${o.test_name} time.`);
  res.redirect(req.get('referer') || '/center/requests');
});
router.post('/requests/:id/collected', (req, res) => {
  const o = myRequest(req, req.params.id);
  if (!o || !['requested', 'scheduled'].includes(o.status)) return notFound(res, 'Request');
  db.run("UPDATE test_orders SET status = 'sample_collected', collected_at = ?, paid = ?, updated_at = ? WHERE id = ?", db.now(), req.body.paid ? 1 : o.paid, db.now(), o.id);
  notify(o.patient_id, 'Sample collected', `Your sample for ${o.test_name} was collected. We will notify you when the report is ready.`, '/patient/tests', 'test');
  req.flash('success', 'Sample marked as collected.');
  res.redirect(req.get('referer') || '/center/collection');
});
router.post('/requests/:id/reject', (req, res) => {
  const o = myRequest(req, req.params.id);
  if (!o || o.status !== 'requested') return notFound(res, 'Request');
  db.run("UPDATE test_orders SET status = 'prescribed', center_id = NULL, price = NULL, updated_at = ? WHERE id = ?", db.now(), o.id);
  notify(o.patient_id, 'Test request declined', `${res.locals.center.name} could not take your ${o.test_name} request${req.body.note ? ': ' + req.body.note : ''}. Please choose another center.`, '/patient/tests', 'test');
  res.redirect('/center/requests');
});
router.get('/collection', (req, res) => {
  const t = new Date();
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).toISOString();
  const today = db.all(`${reqSql} WHERE o.center_id = ? AND o.status = 'scheduled' AND o.scheduled_at < ? ORDER BY o.scheduled_at`, req.user.centerId, end);
  const later = db.all(`${reqSql} WHERE o.center_id = ? AND o.status = 'scheduled' AND o.scheduled_at >= ? ORDER BY o.scheduled_at LIMIT 30`, req.user.centerId, end);
  const collected = db.all(`${reqSql} WHERE o.center_id = ? AND o.status = 'sample_collected' ORDER BY o.collected_at DESC LIMIT 20`, req.user.centerId);
  res.render('center/collection', { title: 'Sample collection', today, later, collected });
});

// =============== Upload reports ===============
const reportUpload = uploader('reports');
router.get('/upload', (req, res) => {
  const pending = db.all(`${reqSql} WHERE o.center_id = ? AND o.status IN ${OPEN} ORDER BY (o.status = 'sample_collected') DESC, o.updated_at`, req.user.centerId);
  const sel = (req.query.id && myRequest(req, req.query.id)) || pending[0] || null;
  const recent = db.all(`SELECT r.*, t.name AS test_name, u.full_name AS patient_name FROM reports r JOIN test_catalog t ON t.id = r.test_id JOIN users u ON u.id = r.patient_id WHERE r.center_id = ? ORDER BY r.id DESC LIMIT 8`, req.user.centerId);
  const tests = db.all('SELECT t.* FROM center_tests ct JOIN test_catalog t ON t.id = ct.test_id WHERE ct.center_id = ? ORDER BY t.name', req.user.centerId);
  const staff = db.all('SELECT u.full_name FROM center_members m JOIN users u ON u.id = m.user_id WHERE m.center_id = ?', req.user.centerId);
  res.render('center/upload', { title: 'Upload diagnostic report', pending, sel, recent, tests, staff });
});
function saveReport(req, res, { orderId, patientId, doctorId, testId, testName }) {
  const { id } = db.run(
    `INSERT INTO reports (test_order_id, patient_id, center_id, doctor_id, test_id, test_date, technician, summary, file_path, original_name, mime_type, size, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orderId, patientId, req.user.centerId, doctorId, testId, req.body.test_date || db.now().slice(0, 10), String(req.body.technician || '').slice(0, 80) || null,
    String(req.body.summary || '').slice(0, 2000) || null, relative(req.file.path), req.file.originalname, req.file.mimetype, req.file.size, req.user.id);
  audit(req, 'report.uploaded', { entity: 'report', entityId: id, patientId });
  notify(patientId, `${testName} report uploaded`, `${res.locals.center.name} added your report.`, '/patient/records', 'report');
  if (doctorId) notify(doctorId, 'Report available', `A ${testName} report you ordered is ready. Ask the patient for access to view it.`, `/doctor/patients?id=${patientId}`, 'report');
  return id;
}
router.post('/upload/:id', handleUpload(reportUpload.single('file'), (req) => `/center/upload?id=${req.params.id}`), (req, res) => {
  const o = myRequest(req, req.params.id);
  if (!o || !['requested', 'scheduled', 'sample_collected'].includes(o.status)) return notFound(res, 'Open request');
  if (!req.file) { req.flash('error', 'Attach the report file (PDF or image).'); return res.redirect(`/center/upload?id=${o.id}`); }
  db.tx(() => {
    saveReport(req, res, { orderId: o.id, patientId: o.patient_id, doctorId: o.doctor_id, testId: o.test_id, testName: o.test_name });
    db.run("UPDATE test_orders SET status = 'completed', collected_at = COALESCE(collected_at, ?), updated_at = ? WHERE id = ?", db.now(), db.now(), o.id);
  });
  req.flash('success', `Report uploaded. ${o.patient_name} has been notified.`);
  res.redirect('/center/upload');
});
// Walk-in patient: report for a registered patient identified by email. The center never sees earlier reports.
router.post('/walk-in', handleUpload(reportUpload.single('file'), '/center/upload'), (req, res) => {
  const patient = db.get("SELECT id, full_name FROM users WHERE email = ? AND role = 'patient'", String(req.body.email || '').trim());
  const test = db.get('SELECT t.* FROM center_tests ct JOIN test_catalog t ON t.id = ct.test_id WHERE ct.center_id = ? AND t.id = ?', req.user.centerId, req.body.test_id);
  if (!patient || !test || !req.file) { req.flash('error', 'Enter a registered patient email, choose a test your center offers, and attach the report.'); return res.redirect('/center/upload'); }
  db.tx(() => {
    const { id } = db.run("INSERT INTO test_orders (patient_id, test_id, status, center_id, notes, collected_at) VALUES (?, ?, 'completed', ?, 'Walk-in', ?)", patient.id, test.id, req.user.centerId, db.now());
    saveReport(req, res, { orderId: id, patientId: patient.id, doctorId: null, testId: test.id, testName: test.name });
  });
  req.flash('success', `Report uploaded to ${patient.full_name}'s portal.`);
  res.redirect('/center/upload');
});

// =============== Test catalog and prices ===============
router.get('/catalog', (req, res) => {
  const cat = String(req.query.cat || '');
  const q = String(req.query.q || '').trim().toLowerCase();
  let tests = db.all('SELECT ct.*, t.name, t.category FROM center_tests ct JOIN test_catalog t ON t.id = ct.test_id WHERE ct.center_id = ? ORDER BY t.category, t.name', req.user.centerId);
  const all = tests;
  if (cat) tests = tests.filter((t) => t.category === cat);
  if (q) tests = tests.filter((t) => t.name.toLowerCase().includes(q));
  const edit = req.query.edit ? all.find((t) => t.id === Number(req.query.edit)) : null;
  const catalog = db.all('SELECT * FROM test_catalog WHERE id NOT IN (SELECT test_id FROM center_tests WHERE center_id = ?) ORDER BY name', req.user.centerId);
  const cats = [...new Set(all.map((t) => t.category))];
  const month = new Date(Date.now() - 30 * 86400000).toISOString();
  const cards = [
    { tile: 't-blue', icon: 'flask', color: 'blue', label: 'Tests offered', value: all.length, sub: `${cats.length} categories`, trend: stats.daily('SELECT updated_at AS t FROM center_tests WHERE center_id = ?', [req.user.centerId]) },
    { tile: 't-teal', icon: 'shield', color: 'teal', label: 'Available now', value: all.filter((t) => t.available).length, sub: `${all.filter((t) => !t.available).length} paused`, trend: stats.daily('SELECT created_at AS t FROM reports WHERE center_id = ?', [req.user.centerId]) },
    { tile: 't-orange', icon: 'chart', color: 'orange', label: 'Price updated', value: all.filter((t) => t.updated_at >= month).length, sub: 'This month', trend: stats.daily('SELECT updated_at AS t FROM center_tests WHERE center_id = ?', [req.user.centerId]) },
    { tile: 't-purple', icon: 'calendar', color: 'purple', label: 'Online booking', value: res.locals.center.online_booking ? 'On' : 'Off', sub: 'Patients can book', trend: stats.daily('SELECT created_at AS t FROM test_orders WHERE center_id = ?', [req.user.centerId]) },
  ];
  res.render('center/catalog', { title: 'Test catalog and prices', tests, edit, catalog, cats, cat, q, cards });
});
router.post('/catalog', adminOnly, (req, res) => {
  const price = parseInt(req.body.price, 10);
  const test = db.get('SELECT id FROM test_catalog WHERE id = ?', req.body.test_id);
  if (!test || !(price >= 0)) { req.flash('error', 'Choose a test and enter a valid price.'); return res.redirect('/center/catalog'); }
  const discount = Math.min(90, Math.max(0, parseInt(req.body.discount_pct, 10) || 0));
  db.run(`INSERT INTO center_tests (center_id, test_id, price, report_time, available, online_booking, discount_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(center_id, test_id) DO UPDATE SET price = excluded.price, report_time = excluded.report_time, available = excluded.available, online_booking = excluded.online_booking, discount_pct = excluded.discount_pct, updated_at = excluded.updated_at`,
    req.user.centerId, test.id, price, ['Same day', 'Next day', '2 days', '3 to 5 days'].includes(req.body.report_time) ? req.body.report_time : 'Same day', req.body.available ? 1 : 0, req.body.online_booking ? 1 : 0, discount, db.now());
  req.flash('success', 'Saved. Patients see the new price when they search.');
  res.redirect('/center/catalog');
});
router.post('/catalog/:id/toggle', adminOnly, (req, res) => {
  db.run('UPDATE center_tests SET available = 1 - available, updated_at = ? WHERE id = ? AND center_id = ?', db.now(), req.params.id, req.user.centerId);
  res.redirect(req.get('referer') || '/center/catalog');
});
router.post('/catalog/:id/delete', adminOnly, (req, res) => {
  db.run('DELETE FROM center_tests WHERE id = ? AND center_id = ?', req.params.id, req.user.centerId);
  res.redirect('/center/catalog');
});
router.post('/settings/booking', adminOnly, (req, res) => {
  db.run('UPDATE centers SET online_booking = 1 - online_booking WHERE id = ?', req.user.centerId);
  res.redirect('/center/catalog');
});

// =============== Staff ===============
router.get('/staff', (req, res) => {
  const staff = db.all(`SELECT u.id, u.full_name, u.email, u.phone, u.email_verified, u.status, m.is_admin, m.title,
                          (SELECT COUNT(*) FROM reports r WHERE r.uploaded_by = u.id) AS uploads FROM center_members m JOIN users u ON u.id = m.user_id WHERE m.center_id = ? ORDER BY m.is_admin DESC, u.full_name`, req.user.centerId);
  res.render('center/staff', { title: 'Staff', staff });
});
router.post('/staff', adminOnly, ah(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const name = String(req.body.full_name || '').trim();
  const pw = String(req.body.password || '');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    req.flash('error', 'Enter a name, a valid email and a temporary password (8+ characters with letters and numbers).');
    return res.redirect('/center/staff');
  }
  if (db.get('SELECT 1 FROM users WHERE email = ?', email)) { req.flash('error', 'That email is already registered.'); return res.redirect('/center/staff'); }
  const hash = await bcrypt.hash(pw, 12);
  db.tx(() => {
    const { id } = db.run("INSERT INTO users (role, email, password_hash, full_name, phone, status, email_verified) VALUES ('center', ?, ?, ?, ?, 'active', 0)", email, hash, name, req.body.phone || null);
    db.run('INSERT INTO center_members (user_id, center_id, is_admin, title) VALUES (?, ?, 0, ?)', id, req.user.centerId, String(req.body.title || 'Staff').slice(0, 40));
    audit(req, 'center.staff_added', { entity: 'user', entityId: id });
  });
  req.flash('success', `Staff account created. ${name} verifies their email with a code at first login.`);
  res.redirect('/center/staff');
}));
router.post('/staff/:id/remove', adminOnly, (req, res) => {
  const m = db.get('SELECT * FROM center_members WHERE user_id = ? AND center_id = ? AND is_admin = 0', req.params.id, req.user.centerId);
  if (m) {
    db.run("UPDATE users SET status = 'suspended' WHERE id = ?", m.user_id);
    db.run('DELETE FROM center_members WHERE user_id = ?', m.user_id);
    db.run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?", m.user_id);
    audit(req, 'center.staff_removed', { entity: 'user', entityId: m.user_id });
  }
  res.redirect('/center/staff');
});

// =============== Billing ===============
router.get('/billing', (req, res) => {
  const c = req.user.centerId;
  const rows = db.all(`${reqSql} WHERE o.center_id = ? AND o.status IN ('sample_collected','completed') ORDER BY o.updated_at DESC LIMIT 60`, c);
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const sum = db.get("SELECT COALESCE(SUM(price),0) total, COALESCE(SUM(CASE WHEN paid = 1 THEN price ELSE 0 END),0) paid FROM test_orders WHERE center_id = ? AND status IN ('sample_collected','completed') AND updated_at >= ?", c, month);
  const chart = stats.monthly("SELECT updated_at AS t FROM test_orders WHERE center_id = ? AND status = 'completed'", [c]);
  res.render('center/billing', { title: 'Billing', rows, sum, chart });
});
router.post('/billing/:id/paid', (req, res) => {
  db.run('UPDATE test_orders SET paid = 1 WHERE id = ? AND center_id = ?', req.params.id, req.user.centerId);
  res.redirect('/center/billing');
});

// =============== Center profile ===============
router.get('/profile', (req, res) => res.render('center/profile', { title: 'Center profile' }));
router.post('/profile', adminOnly, (req, res) => {
  const b = req.body;
  db.run('UPDATE centers SET name = ?, address = ?, phone = ?, email = ?, opening_hours = ?, services = ?, lat = ?, lng = ?, online_booking = ? WHERE id = ?',
    String(b.name || '').trim() || res.locals.center.name, b.address, b.phone, b.email, b.opening_hours, b.services,
    b.lat === '' || isNaN(Number(b.lat)) ? null : Number(b.lat), b.lng === '' || isNaN(Number(b.lng)) ? null : Number(b.lng), b.online_booking ? 1 : 0, req.user.centerId);
  req.flash('success', 'Center details saved.');
  res.redirect('/center/profile');
});

module.exports = router;
