const crypto = require('crypto');
const db = require('../db');
const { unreadCount } = require('../services/notify');

const DASHBOARD = { patient: '/patient', doctor: '/doctor', center: '/center', pharmacy: '/pharmacy', ambulance: '/ambulance', admin: '/admin', caregiver: '/care' };
const ROLE_TITLE = { patient: 'Patient', doctor: 'Doctor', center: 'Center Admin', pharmacy: 'Medical Shop', ambulance: 'Ambulance Service', admin: 'Platform Admin', caregiver: 'Caregiver' };

// Sidebar navigation per role: [section, [[href, label, icon], ...]]
const NAV = {
  patient: [
    ['Main', [['/patient', 'Dashboard', 'home'], ['/patient/find-doctor', 'Find a Doctor (AI)', 'stethoscope'], ['/patient/appointments', 'Appointments', 'calendar'], ['/messages', 'Doctor Chat', 'message'], ['/patient/assistant', 'Health AI Chatbot', 'bot']]],
    ['Emergency', [['/emergency', 'Ambulance', 'ambulance'], ['/blood', 'Blood Bank', 'drop']]],
    ['Health records', [['/patient/tests', 'Medical Tests', 'flask'], ['/patient/records', 'Medical Records', 'file'], ['/patient/access', 'Access Requests', 'shield'], ['/patient/health', 'Health Status', 'activity'], ['/patient/analysis', 'Health Analysis (AI)', 'trend'], ['/care', 'Caregivers & Timeline', 'users']]],
    ['Pharmacy', [['/patient/shop', 'Medicine Shop', 'cart'], ['/patient/order', 'Order by Prescription', 'pill'], ['/patient/orders', 'Order History', 'file'], ['/patient/reminders', 'Medicine Reminders', 'alarm']]],
    ['Account', [['/patient/profile', 'Profile & Settings', 'user']]],
  ],
  doctor: [
    ['Main', [['/doctor', 'Dashboard', 'home'], ['/doctor/requests', 'Appointment Requests', 'users'], ['/doctor/schedule', 'My Schedule', 'calendar']]],
    ['Clinical', [['/doctor/patients', 'Patients', 'users'], ['/messages', 'Patient Chats', 'message'], ['/doctor/prescriptions', 'Prescriptions', 'pen'], ['/doctor/test-orders', 'Test Orders', 'flask'], ['/doctor/access', 'Report Access', 'shield'], ['/doctor/messages', 'Appointment Messages', 'file']]],
    ['Community', [['/blood', 'Blood Bank', 'drop']]],
    ['Account', [['/doctor/profile', 'Profile & Settings', 'user']]],
  ],
  center: [
    ['Main', [['/center', 'Dashboard', 'home'], ['/center/requests', 'Test Requests', 'flask'], ['/center/collection', 'Sample Collection', 'calendar'], ['/center/upload', 'Upload Reports', 'file']]],
    ['Management', [['/center/catalog', 'Test Catalog and Prices', 'chart'], ['/center/staff', 'Staff', 'users'], ['/center/billing', 'Billing', 'shield']]],
    ['Account', [['/center/profile', 'Center Profile', 'building']]],
  ],
  pharmacy: [
    ['Main', [['/pharmacy', 'Dashboard', 'home'], ['/pharmacy/orders', 'Orders', 'pill'], ['/pharmacy/stock', 'Live Stock', 'flask']]],
    ['Management', [['/pharmacy/delivery', 'Delivery', 'truck'], ['/pharmacy/payments', 'Payments', 'card'], ['/pharmacy/reviews', 'Ratings & Reviews', 'star']]],
    ['Account', [['/pharmacy/profile', 'Shop Profile', 'building']]],
  ],
  ambulance: [
    ['Main', [['/ambulance', 'Dashboard', 'home'], ['/ambulance/trips', 'Trips', 'ambulance']]],
    ['Account', [['/ambulance/profile', 'Vehicle & Profile', 'truck']]],
  ],
  caregiver: [
    ['Care', [['/care', 'Care Dashboard', 'heart'], ['/care?view=people', 'People I Care For', 'users']]],
    ['Account', [['/notifications', 'Notifications', 'bell'], ['/account', 'Account & Security', 'user']]],
  ],
  admin: [
    ['Main', [['/admin', 'Dashboard', 'home'], ['/admin/users?role=patient', 'Patients', 'users'], ['/admin/users?role=doctor', 'Doctors', 'stethoscope']]],
    ['Partners', [['/admin/users?role=center', 'Diagnostic Centers', 'flask'], ['/admin/users?role=pharmacy', 'Medical Shops', 'pill'], ['/admin/users?role=ambulance', 'Ambulances', 'ambulance'], ['/admin/users?role=caregiver', 'Caregivers', 'heart'], ['/admin/verifications', 'Verifications', 'check']]],
    ['System', [['/admin/audit', 'Audit Logs', 'shield'], ['/admin/catalog', 'Catalog', 'chart']]],
  ],
};

/** Simple flash messages stored in the session. */
function flash(req, res, next) {
  req.flash = (type, msg) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, msg });
  };
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

/** CSRF protection: one token per session, required on every non-GET request. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Multipart forms put the token in the query string because the body is parsed later by multer.
  const token = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(req.session.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('shared/error', {
      title: 'Session expired',
      message: 'Your form expired or was submitted from another page. Please go back, refresh and try again.',
    });
  }
  next();
}

/** Load the signed-in user (if any) and expose it, the sidebar and notifications to views. */
function loadUser(req, res, next) {
  Object.assign(res.locals, { user: null, unread: 0, path: req.path, url: req.originalUrl, nav: [], latest: [] });
  const id = req.session.userId;
  if (!id) return next();
  const user = db.get('SELECT id, role, email, full_name, phone, status, email_verified, phone_verified FROM users WHERE id = ?', id);
  if (!user || ['suspended', 'rejected'].includes(user.status)) {
    return req.session.regenerate(() => res.redirect('/login'));
  }
  user.subtitle = ROLE_TITLE[user.role];
  if (user.role === 'center') {
    const m = db.get('SELECT m.center_id, m.is_admin, c.name FROM center_members m JOIN centers c ON c.id = m.center_id WHERE m.user_id = ?', user.id);
    user.centerId = m ? m.center_id : null;
    user.isCenterAdmin = m ? !!m.is_admin : false;
    if (m) Object.assign(user, { displayName: m.name, subtitle: m.is_admin ? 'Center Admin' : 'Center Staff' });
  }
  if (user.role === 'pharmacy') {
    const p = db.get('SELECT id, name FROM pharmacies WHERE admin_user_id = ?', user.id);
    user.pharmacyId = p ? p.id : null;
    if (p) user.displayName = p.name;
  }
  if (user.role === 'ambulance') {
    const a = db.get('SELECT id, service_name, online FROM ambulances WHERE owner_user_id = ?', user.id);
    user.ambulanceId = a ? a.id : null;
    if (a) user.displayName = a.service_name;
  }
  if (user.role === 'doctor') {
    const d = db.get('SELECT specialty FROM doctor_profiles WHERE user_id = ?', user.id);
    if (d) user.subtitle = d.specialty === 'Cardiology' ? 'Cardiologist' : d.specialty;
  }
  if (user.role === 'admin') user.subtitle = 'Platform Admin';
  user.displayName = user.displayName || user.full_name;
  req.user = user;
  res.locals.user = user;
  res.locals.unread = unreadCount(user.id);
  res.locals.latest = db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 6', user.id);
  res.locals.dashboard = DASHBOARD[user.role];
  res.locals.nav = user.status === 'active' ? NAV[user.role] : [];
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  next();
}

/** Role-based authorization. Pending (unverified) provider accounts see a waiting page. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/login');
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('shared/error', { title: 'Access denied', message: 'Your account does not have permission to open this page.' });
    }
    if (req.user.status === 'pending') return res.render('shared/pending', { title: 'Awaiting verification' });
    next();
  };
}

/** Wrap async handlers so thrown errors reach the error handler. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const notFound = (res, what = 'Item') => res.status(404).render('shared/error', { title: 'Not found', message: `${what} not found.` });

module.exports = { flash, csrf, loadUser, requireAuth, requireRole, ah, notFound, DASHBOARD, NAV };
