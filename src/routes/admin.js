// Platform administrator: provider verification, users, catalogs, audit log.
const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const stats = require('../stats');
const { SPECIALTIES } = require('../services/recommender');

const router = express.Router();
router.use(requireRole('admin'));

function details(u) {
  if (u.role === 'doctor') { const d = db.get('SELECT * FROM doctor_profiles WHERE user_id = ?', u.id); return d && { line: `${d.specialty} · ${d.experience_years} years`, license: d.license_no, kind: 'Doctor', extra: d }; }
  if (u.role === 'center') { const c = db.get('SELECT c.* FROM centers c JOIN center_members m ON m.center_id = c.id WHERE m.user_id = ?', u.id); return c && { line: `Diagnostic center · ${c.address || ''}`, license: c.license_no, kind: 'Center', name: c.name, extra: c }; }
  if (u.role === 'pharmacy') { const p = db.get('SELECT * FROM pharmacies WHERE admin_user_id = ?', u.id); return p && { line: `Medical shop · ${p.address || ''}`, license: p.license_no, kind: 'Medical shop', name: p.name, extra: p }; }
  if (u.role === 'ambulance') { const a = db.get('SELECT * FROM ambulances WHERE owner_user_id = ?', u.id); return a && { line: `${a.kind} ambulance · ${a.vehicle_no} · ${a.base_area || ''}`, license: a.license_no, kind: 'Ambulance', name: a.service_name, extra: { ...a, address: a.base_area } }; }
  return null;
}
const pendingList = () => db.all("SELECT * FROM users WHERE status = 'pending' AND (email_verified = 1 OR phone_verified = 1) ORDER BY created_at").map((u) => ({ ...u, d: details(u) || {} }));
const ACTION_TEXT = {
  'report.view': 'viewed', 'report.download': 'downloaded', 'report.uploaded': 'uploaded', 'report.shared': 'shared', 'access.requested': 'requested access to',
  'access.approved': 'approved access to', 'access.revoked': 'revoked access to', 'access.rejected': 'rejected access to', 'report.access_denied': 'was denied access to',
};
function accessLog(limit = 3) {
  return db.all(`SELECT l.*, u.full_name, u.role, c.name AS center_name, t.name AS test_name, p.full_name AS patient_name FROM audit_log l
                   LEFT JOIN users u ON u.id = l.actor_id LEFT JOIN center_members m ON m.user_id = l.actor_id LEFT JOIN centers c ON c.id = m.center_id
                   LEFT JOIN reports r ON l.entity = 'report' AND r.id = l.entity_id LEFT JOIN test_catalog t ON t.id = r.test_id LEFT JOIN users p ON p.id = l.patient_id
                  WHERE l.action IN (${Object.keys(ACTION_TEXT).map(() => '?').join(',')}) ORDER BY l.id DESC LIMIT ?`, ...Object.keys(ACTION_TEXT), limit)
    .map((l) => ({ ...l, who: l.role === 'center' ? l.center_name || l.full_name : l.full_name, text: ACTION_TEXT[l.action], what: l.test_name ? `${l.test_name} report` : 'records' }));
}

router.get('/', (req, res) => {
  const n = (sql, ...a) => db.get(sql, ...a).n;
  const month = new Date(Date.now() - 30 * 86400000).toISOString();
  const pending = pendingList();
  const byRole = Object.fromEntries(db.all("SELECT role, COUNT(*) n FROM users WHERE status = 'active' GROUP BY role").map((r) => [r.role, r.n]));
  const cards = [
    { href: '/admin/users?role=patient', tile: 't-blue', icon: 'users', color: 'blue', label: 'Total patients', value: (byRole.patient || 0).toLocaleString(), sub: `+${n("SELECT COUNT(*) n FROM users WHERE role = 'patient' AND created_at >= ?", month)} this month`, trend: stats.daily("SELECT created_at AS t FROM users WHERE role = 'patient'") },
    { href: '/admin/users?role=doctor', tile: 't-teal', icon: 'heart', color: 'teal', label: 'Verified doctors', value: n('SELECT COUNT(*) n FROM doctor_profiles WHERE verified = 1'), sub: `${pending.filter((p) => p.role === 'doctor').length} awaiting review`, trend: stats.daily("SELECT created_at AS t FROM appointments") },
    { href: '/admin/users?role=center', tile: 't-orange', icon: 'flask', color: 'orange', label: 'Diagnostic centers', value: n('SELECT COUNT(*) n FROM centers WHERE verified = 1'), sub: `${pending.filter((p) => p.role === 'center').length} awaiting review`, trend: stats.daily('SELECT created_at AS t FROM reports') },
    { href: '/admin/users?role=pharmacy', tile: 't-purple', icon: 'pill', color: 'purple', label: 'Pharmacies', value: n('SELECT COUNT(*) n FROM pharmacies WHERE verified = 1'), sub: `${pending.filter((p) => p.role === 'pharmacy').length} awaiting review`, trend: stats.daily('SELECT created_at AS t FROM orders') },
  ];
  // Platform activity: appointments + test orders + medicine orders per month.
  const a = stats.monthly('SELECT created_at AS t FROM appointments');
  const b = stats.monthly('SELECT created_at AS t FROM test_orders');
  const c = stats.monthly('SELECT created_at AS t FROM orders');
  const activity = { values: a.values.map((v, i) => v + b.values[i] + c.values[i]), labels: a.labels };
  const ring = [
    { label: 'Patients', value: byRole.patient || 0, color: '#4f46e5' },
    { label: 'Doctors', value: byRole.doctor || 0, color: '#10b981' },
    { label: 'Centers', value: byRole.center || 0, color: '#f59e0b' },
    { label: 'Pharmacies', value: byRole.pharmacy || 0, color: '#a855f7' },
    { label: 'Ambulances', value: byRole.ambulance || 0, color: '#ef4444' },
  ];
  const counts = { doctor: pending.filter((p) => p.role === 'doctor').length, center: pending.filter((p) => p.role === 'center').length, pharmacy: pending.filter((p) => p.role === 'pharmacy').length, ambulance: pending.filter((p) => p.role === 'ambulance').length };
  res.render('admin/dashboard', { title: 'Platform overview', cards, activity, ring, total: ring.reduce((s, r) => s + r.value, 0), pending, counts, log: accessLog(3) });
});

// =============== Verification review ===============
router.get('/verifications', (req, res) => {
  const queue = pendingList();
  const sel = (req.query.id && queue.find((u) => u.id === Number(req.query.id))) || queue[0] || null;
  const docs = sel ? db.all('SELECT * FROM provider_documents WHERE user_id = ? ORDER BY id', sel.id) : [];
  const unverified = db.get("SELECT COUNT(*) n FROM users WHERE status = 'pending' AND email_verified = 0 AND phone_verified = 0").n;
  res.render('admin/verifications', { title: 'Verification review', queue, sel, docs, unverified, SPECIALTIES });
});
router.post('/verifications/:id/:action(approve|info|reject)', (req, res) => {
  const u = db.get("SELECT * FROM users WHERE id = ? AND status = 'pending'", req.params.id);
  if (!u) return res.redirect('/admin/verifications');
  const note = String(req.body.note || '').trim().slice(0, 500);
  const act = req.params.action;
  if (act === 'approve') {
    const checks = ['identity', 'license', 'details'].filter((k) => req.body[k]);
    if (checks.length < 3) { req.flash('error', 'Tick all three checks after reviewing the documents.'); return res.redirect(`/admin/verifications?id=${u.id}`); }
    db.tx(() => {
      db.run("UPDATE users SET status = 'active', review_note = NULL WHERE id = ?", u.id);
      if (u.role === 'doctor') db.run('UPDATE doctor_profiles SET verified = 1 WHERE user_id = ?', u.id);
      if (u.role === 'center') db.run('UPDATE centers SET verified = 1 WHERE id = (SELECT center_id FROM center_members WHERE user_id = ?)', u.id);
      if (u.role === 'pharmacy') db.run('UPDATE pharmacies SET verified = 1 WHERE admin_user_id = ?', u.id);
      if (u.role === 'ambulance') db.run('UPDATE ambulances SET verified = 1 WHERE owner_user_id = ?', u.id);
      if (u.role === 'doctor' && SPECIALTIES.includes(req.body.specialty)) db.run('UPDATE doctor_profiles SET specialty = ? WHERE user_id = ?', req.body.specialty, u.id);
    });
    audit(req, 'admin.provider_approved', { entity: 'user', entityId: u.id, details: { note } });
    notify(u.id, 'Your account is verified', `Your portal is active.${note ? ' ' + note : ''}`, '/', 'account');
    req.flash('success', `${u.full_name} verified. They now appear to patients.`);
  } else if (act === 'info') {
    if (!note) { req.flash('error', 'Write what information you need.'); return res.redirect(`/admin/verifications?id=${u.id}`); }
    db.run('UPDATE users SET review_note = ? WHERE id = ?', note, u.id);
    audit(req, 'admin.provider_info_requested', { entity: 'user', entityId: u.id, details: { note } });
    notify(u.id, 'More information needed', note, '/', 'account');
    req.flash('success', 'Request sent to the applicant.');
  } else {
    db.run("UPDATE users SET status = 'rejected', review_note = ? WHERE id = ?", note || 'Documents could not be verified.', u.id);
    db.run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?", u.id);
    audit(req, 'admin.provider_rejected', { entity: 'user', entityId: u.id, details: { note } });
    req.flash('success', `${u.full_name}'s registration was rejected.`);
  }
  res.redirect('/admin/verifications');
});

// =============== Users ===============
router.get('/users', (req, res) => {
  const role = ['patient', 'doctor', 'center', 'pharmacy', 'ambulance', 'admin', 'caregiver'].includes(req.query.role) ? req.query.role : '';
  const q = String(req.query.q || '').trim();
  const users = db.all(`SELECT id, role, email, full_name, phone, status, email_verified, phone_verified, created_at FROM users
                         WHERE (? = '' OR role = ?) AND (? = '' OR full_name LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 300`, role, role, q, `%${q}%`, `%${q}%`)
    .map((u) => ({ ...u, d: details(u) }));
  res.render('admin/users', { title: { patient: 'Patients', doctor: 'Doctors', center: 'Diagnostic centers', pharmacy: 'Medical shops', ambulance: 'Ambulances', admin: 'Admins' }[role] || 'Users', users, role, q, SPECIALTIES });
});
router.post('/users/:id/:action(suspend|activate)', (req, res) => {
  const u = db.get("SELECT * FROM users WHERE id = ? AND role <> 'admin'", req.params.id);
  if (u) {
    const status = req.params.action === 'suspend' ? 'suspended' : 'active';
    db.run('UPDATE users SET status = ? WHERE id = ?', status, u.id);
    if (status === 'suspended') db.run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?", u.id);
    audit(req, `admin.user_${req.params.action}`, { entity: 'user', entityId: u.id });
    req.flash('success', `${u.full_name} ${status === 'suspended' ? 'suspended and signed out' : 'reactivated'}.`);
  }
  res.redirect(req.get('referer') || '/admin/users');
});

// Admin sets or corrects a doctor's specialty. Patients searching by symptoms then find this doctor.
router.post('/doctors/:id/specialty', (req, res) => {
  if (!SPECIALTIES.includes(req.body.specialty)) { req.flash('error', 'Choose a specialty from the list.'); return res.redirect(req.get('referer') || '/admin/users?role=doctor'); }
  const d = db.get('SELECT u.full_name FROM users u JOIN doctor_profiles p ON p.user_id = u.id WHERE u.id = ?', req.params.id);
  if (!d) return res.redirect('/admin/users?role=doctor');
  db.run('UPDATE doctor_profiles SET specialty = ? WHERE user_id = ?', req.body.specialty, req.params.id);
  audit(req, 'admin.specialty_changed', { entity: 'user', entityId: Number(req.params.id), details: { specialty: req.body.specialty } });
  notify(Number(req.params.id), 'Specialty updated', `Your specialty is now ${req.body.specialty}. Patients describing related symptoms will see you.`, '/doctor/profile', 'account');
  req.flash('success', `${d.full_name} is now listed under ${req.body.specialty}.`);
  res.redirect(req.get('referer') || '/admin/users?role=doctor');
});

// =============== Catalog ===============
router.get('/catalog', (req, res) => {
  res.render('admin/catalog', { title: 'Catalog', tests: db.all('SELECT * FROM test_catalog ORDER BY category, name'), medicines: db.all('SELECT * FROM medicines ORDER BY name') });
});
router.post('/catalog/test', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name && !db.get('SELECT 1 FROM test_catalog WHERE name = ?', name)) { db.run('INSERT INTO test_catalog (name, category) VALUES (?, ?)', name, String(req.body.category || '').trim() || null); req.flash('success', 'Test added.'); } else req.flash('error', 'Enter a new, unique test name.');
  res.redirect('/admin/catalog');
});
router.post('/catalog/medicine', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name && !db.get('SELECT 1 FROM medicines WHERE name = ?', name)) {
    db.run('INSERT INTO medicines (name, brand, form, strength, rx_required) VALUES (?, ?, ?, ?, ?)', name, req.body.brand || null, req.body.form || null, req.body.strength || null, req.body.rx_required ? 1 : 0);
    req.flash('success', 'Medicine added.');
  } else req.flash('error', 'Enter a new, unique generic name.');
  res.redirect('/admin/catalog');
});

// =============== Audit log ===============
router.get('/audit', (req, res) => {
  const action = String(req.query.action || '').trim();
  const rows = db.all(`SELECT l.*, u.full_name AS actor_name, p.full_name AS patient_name FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id LEFT JOIN users p ON p.id = l.patient_id
                        WHERE (? = '' OR l.action LIKE ?) ORDER BY l.id DESC LIMIT 300`, action, `${action}%`);
  res.render('admin/audit', { title: 'Audit log', rows, action });
});

module.exports = router;
