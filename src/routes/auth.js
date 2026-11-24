// Authentication: role-based registration verified once by OTP (email, or SMS for medical shops and ambulances),
// login with email + password,
// forgot password by OTP, provider registration with documents, sessions.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const otp = require('../services/otp');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');
const { SPECIALTIES } = require('../services/recommender');
const { uploader, handleUpload, relative } = require('../services/uploads');
const { ah, DASHBOARD } = require('../middleware/core');

const router = express.Router();
const limiter = rateLimit({
  windowMs: 15 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('shared/error', { title: 'Too many attempts', message: 'Too many attempts from your network. Please wait 15 minutes and try again.' }),
});
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 -]{7,20}$/;

function passwordProblem(pw, confirm) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain at least one letter and one number.';
  if (confirm !== undefined && pw !== confirm) return 'Password and confirm password do not match.';
  return null;
}
const maskPhone = (p) => String(p || '').replace(/^(.*)(\d{3})$/, (_, a, b) => a.replace(/\d/g, '*') + b);
const mask = (e) => String(e).replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '***' + c);
const clean = (body) => Object.fromEntries(Object.entries(body).map(([k, v]) => {
  if (Array.isArray(v)) v = v.find((x) => String(x).trim()) || '';
  return [k, typeof v === 'string' ? v.trim() : v];
}));

const channelOf = (user) => (['pharmacy', 'ambulance'].includes(user.role) ? 'sms' : 'email');
async function startOtp(req, user, purpose, channel = 'email') {
  const { code, delivered, emailed } = await otp.issue(user, purpose, channel);
  req.session.pendingOtp = { userId: user.id, purpose, email: user.email, phone: user.phone, channel, emailed: Boolean(emailed) };
  // The code is shown on the page only while it could not be delivered (email/SMS not set up or failing).
  req.session.devOtp = config.isDev && config.devShowOtp && !delivered ? code : null;
}
const logoutEverywhere = (userId) => db.run("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?", userId);
const otpView = (req, extra = {}) => ({
  title: 'Verify code', email: mask(req.session.pendingOtp.email), purpose: req.session.pendingOtp.purpose,
  channel: req.session.pendingOtp.channel || 'email', phone: maskPhone(req.session.pendingOtp.phone), emailed: req.session.pendingOtp.emailed,
  devOtp: req.session.devOtp, expiry: config.otp.expiryMinutes,
  wait: req.session.pendingOtp.userId ? otp.cooldownRemaining(req.session.pendingOtp.userId, req.session.pendingOtp.purpose) : 0, ...extra,
});

router.get('/', (req, res) => (req.user ? res.redirect(DASHBOARD[req.user.role]) : res.redirect('/login')));

// ---------- Registration: step 1 picks the account type, step 2 shows that type's form ----------
const ROLES = {
  patient: { title: 'Patient', channel: 'email', status: 'active' },
  doctor: { title: 'Doctor', channel: 'email', status: 'pending' },
  center: { title: 'Diagnostic Center', channel: 'email', status: 'pending' },
  pharmacy: { title: 'Medical Shop (Pharmacy)', channel: 'sms', status: 'pending' },
  ambulance: { title: 'Ambulance Service', channel: 'sms', status: 'pending' },
  caregiver: { title: 'Caregiver', channel: 'email', status: 'active' },
};
const AMBULANCE_KINDS = ['Non-AC', 'AC', 'ICU / Life support', 'Freezer van'];
const docUpload = uploader('documents');
const formLocals = (role, form = {}, errors) => ({ title: `Register as ${ROLES[role].title}`, role, R: ROLES[role], form, errors, specialties: SPECIALTIES, AMBULANCE_KINDS, wide: true,
  artTitle: 'Join MediConnect in two quick steps.', artText: 'Choose your account type, fill in your details and verify once. After that you log in with just your email and password.' });

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(DASHBOARD[req.user.role]);
  res.render('auth/register-choose', { title: 'Create account', ROLES, wide: true, artTitle: 'Who are you joining as?', artText: 'Patients, doctors, diagnostic centers, medical shops and ambulance services each get their own portal.' });
});
router.get('/register/provider', (req, res) => res.redirect(req.query.role && ROLES[req.query.role] ? `/register/${req.query.role}` : '/register'));
router.get('/register/:role(patient|doctor|center|pharmacy|ambulance|caregiver)', (req, res) => {
  if (req.user) return res.redirect(DASHBOARD[req.user.role]);
  res.render('auth/register-form', formLocals(req.params.role));
});

const UPLOADS = docUpload.fields([{ name: 'license', maxCount: 1 }, { name: 'degree', maxCount: 1 }, { name: 'nid', maxCount: 1 }]);
router.post('/register/:role(patient|doctor|center|pharmacy|ambulance|caregiver)', limiter, (req, res, next) => handleUpload(UPLOADS, `/register/${req.params.role}`)(req, res, next), ah(async (req, res) => {
  const role = req.params.role;
  const R = ROLES[role];
  const f = clean(req.body);
  const files = req.files || {};
  const errors = [];
  if (!f.full_name) errors.push(['patient', 'doctor', 'caregiver'].includes(role) ? 'Full name is required.' : 'Owner or contact person name is required.');
  if (!EMAIL_RE.test(f.email || '')) errors.push('A valid email address is required.');
  if (!PHONE_RE.test(f.phone || '')) errors.push('A valid phone number is required.');
  const pw = passwordProblem(req.body.password, req.body.confirm_password);
  if (pw) errors.push(pw);
  if (role === 'patient' && !f.date_of_birth) errors.push('Date of birth is required.');
  if (!['patient', 'caregiver'].includes(role)) {
    if (!f.license_no) errors.push(role === 'ambulance' ? 'Vehicle registration number is required.' : 'License or registration number is required.');
    if (!files.license) errors.push('Upload your license document (PDF or image).');
  }
  if (role === 'doctor' && !SPECIALTIES.includes(f.specialty)) errors.push('Choose your specialty.');
  if (['center', 'pharmacy', 'ambulance'].includes(role) && (!f.org_name || !f.org_address)) errors.push('Name and address of your organization are required.');
  if (role === 'ambulance' && !f.vehicle_no) errors.push('Vehicle number is required.');
  if (!f.accept_terms) errors.push('Please accept the Terms and Privacy Policy.');
  const existing = f.email ? db.get('SELECT * FROM users WHERE email = ?', f.email) : null;
  if (existing && (existing.email_verified || existing.phone_verified)) errors.push('An account with this email already exists. Please log in.');
  if (errors.length) return res.status(400).render('auth/register-form', formLocals(role, f, errors));
  if (existing) db.run('DELETE FROM users WHERE id = ?', existing.id);

  const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
  const coord = (v) => (v === '' || v === undefined || isNaN(Number(v)) ? null : Number(v));
  const hash = await bcrypt.hash(req.body.password, 12);
  const user = db.tx(() => {
    const { id } = db.run('INSERT INTO users (role, email, password_hash, full_name, phone, status) VALUES (?, ?, ?, ?, ?, ?)', role, f.email, hash, f.full_name, f.phone, R.status);
    if (role === 'patient') {
      db.run('INSERT INTO patient_profiles (user_id, patient_code, date_of_birth, gender, blood_group, address, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, `PT-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`, f.date_of_birth, f.gender || null, f.blood_group || null, f.address || null, coord(f.lat), coord(f.lng));
    } else if (role === 'doctor') {
      db.run('INSERT INTO doctor_profiles (user_id, specialty, license_no, experience_years, fee, qualifications, address, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, f.specialty, f.license_no, parseInt(f.experience_years, 10) || 0, parseInt(f.fee, 10) || 500, f.qualifications || null, f.org_address || null, coord(f.lat), coord(f.lng));
      for (let wd = 0; wd < 7; wd++) db.run('INSERT INTO doctor_hours (doctor_id, weekday, enabled, start_time, end_time) VALUES (?, ?, ?, ?, ?)', id, wd, wd === 5 ? 0 : 1, '17:00', '21:00');
    } else if (role === 'center') {
      const c = db.run('INSERT INTO centers (name, address, phone, email, license_no, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)', f.org_name, f.org_address, f.phone, f.email, f.license_no, coord(f.lat), coord(f.lng));
      db.run("INSERT INTO center_members (user_id, center_id, is_admin, title) VALUES (?, ?, 1, 'Center Admin')", id, c.id);
    } else if (role === 'caregiver') {
      // A caregiver has no clinical profile of their own; patients invite them to their shared timeline.
    } else if (role === 'pharmacy') {
      db.run('INSERT INTO pharmacies (admin_user_id, name, address, phone, license_no, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)', id, f.org_name, f.org_address, f.phone, f.license_no, coord(f.lat), coord(f.lng));
    } else {
      db.run(`INSERT INTO ambulances (owner_user_id, service_name, vehicle_no, kind, driver_name, driver_phone, base_area, license_no, base_fare, per_km, lat, lng)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, f.org_name, f.vehicle_no, AMBULANCE_KINDS.includes(f.kind) ? f.kind : 'Non-AC',
      f.driver_name || f.full_name, f.driver_phone || f.phone, f.org_address, f.license_no, num(f.base_fare, 800), num(f.per_km, 60), coord(f.lat), coord(f.lng));
    }
    const KIND = { license: { doctor: 'Medical license (BMDC)', center: 'Trade license', pharmacy: 'Drug license', ambulance: 'Vehicle registration' }[role], degree: role === 'doctor' ? 'Degree certificate' : 'Supporting document', nid: 'National ID' };
    for (const [field, list] of Object.entries(files)) {
      const file = list[0];
      db.run('INSERT INTO provider_documents (user_id, kind, file_path, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)', id, KIND[field], relative(file.path), file.originalname, file.mimetype, file.size);
    }
    return db.get('SELECT * FROM users WHERE id = ?', id);
  });
  audit(req, 'account.registered', { entity: 'user', entityId: user.id, details: { role }, actor: user });
  await startOtp(req, user, 'register', R.channel);
  req.flash('success', R.channel === 'sms' ? `We sent a 6-digit code by SMS to ${maskPhone(user.phone)}${req.session.pendingOtp.emailed ? ` and to ${mask(user.email)}` : ''}.` : `We sent a 6-digit code to ${mask(user.email)}.`);
  res.redirect('/verify-otp');
}));

// ---------- OTP verification (register, login, reset) ----------
router.get('/verify-otp', (req, res) => {
  if (!req.session.pendingOtp) return res.redirect('/login');
  res.render('auth/verify-otp', otpView(req));
});

router.post('/verify-otp', limiter, ah(async (req, res) => {
  const p = req.session.pendingOtp;
  if (!p) return res.redirect('/login');
  const result = p.userId ? otp.verify(p.userId, p.purpose, req.body.code) : { ok: false, error: 'Incorrect code.' };
  if (!result.ok) {
    if (p.purpose === 'reset') { req.flash('error', result.error); return res.redirect('/forgot-password?step=2'); }
    return res.status(400).render('auth/verify-otp', otpView(req, { errors: [result.error] }));
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', p.userId);
  delete req.session.pendingOtp;
  delete req.session.devOtp;

  if (p.purpose === 'register') {
    if (p.channel === 'sms') db.run('UPDATE users SET phone_verified = 1, email_verified = 1 WHERE id = ?', user.id);
    else db.run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
    audit(req, p.channel === 'sms' ? 'account.phone_verified' : 'account.email_verified', { entity: 'user', entityId: user.id, actor: user });
    if (user.status === 'pending') {
      for (const a of db.all("SELECT id FROM users WHERE role = 'admin'")) notify(a.id, 'New account to verify', `${user.full_name} registered as ${{ center: 'a diagnostic center', pharmacy: 'a medical shop', ambulance: 'an ambulance service', doctor: 'a doctor' }[user.role] || user.role}.`, `/admin/verifications?id=${user.id}`, 'account');
      req.flash('success', `${p.channel === 'sms' ? 'Phone number' : 'Email'} verified. An administrator will check your documents; you can log in to see the status.`);
    } else req.flash('success', 'Email verified. From now on just log in with your email and password.');
    return res.redirect('/login');
  }
  if (p.purpose === 'login') {
    return req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      req.session.ua = String(req.get('user-agent') || '').slice(0, 200);
      req.session.ip = req.ip;
      req.session.loginAt = db.now();
      audit(req, 'auth.login', { entity: 'user', entityId: user.id, actor: user });
      res.redirect(DASHBOARD[user.role]);
    });
  }
  req.session.resetUserId = user.id;
  req.session.resetUntil = Date.now() + 10 * 60_000;
  res.redirect('/forgot-password?step=3');
}));

router.post('/resend-otp', limiter, ah(async (req, res) => {
  const p = req.session.pendingOtp;
  if (!p) return res.redirect('/login');
  const back = p.purpose === 'reset' ? '/forgot-password?step=2' : '/verify-otp';
  if (!p.userId) { req.flash('success', 'If the account exists, a new code has been sent.'); return res.redirect(back); }
  const wait = otp.cooldownRemaining(p.userId, p.purpose);
  if (wait > 0) { req.flash('error', `Please wait ${wait} seconds before requesting another code.`); return res.redirect(back); }
  await startOtp(req, db.get('SELECT * FROM users WHERE id = ?', p.userId), p.purpose, p.channel || 'email');
  req.flash('success', 'A new code has been sent.');
  res.redirect(back);
}));

// ---------- Login ----------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(DASHBOARD[req.user.role]);
  res.render('auth/login', { title: 'Log in', email: '' });
});

router.post('/login', limiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const fail = (msg = 'Invalid email or password.') => res.status(401).render('auth/login', { title: 'Log in', email, errors: [msg] });
  const user = db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user) { await bcrypt.compare(password, DUMMY_HASH); return fail(); }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return fail(`Account temporarily locked after too many failed attempts. Try again in ${Math.ceil((new Date(user.locked_until) - new Date()) / 60_000)} minute(s) or reset your password.`);
  }
  if (user.status === 'suspended') return fail('This account is suspended. Contact support.');
  if (user.status === 'rejected') return fail(`This registration was not approved${user.review_note ? ': ' + user.review_note : '.'}`);
  if (!(await bcrypt.compare(password, user.password_hash))) {
    const failed = user.failed_logins + 1;
    if (failed >= config.maxFailedLogins) {
      db.run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', new Date(Date.now() + config.lockoutMinutes * 60_000).toISOString(), user.id);
      audit(req, 'auth.locked', { entity: 'user', entityId: user.id, actor: user });
      return fail(`Too many failed attempts. Your account is locked for ${config.lockoutMinutes} minutes.`);
    }
    db.run('UPDATE users SET failed_logins = ? WHERE id = ?', failed, user.id);
    return fail();
  }
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
  const verified = channelOf(user) === 'sms' ? user.phone_verified || user.email_verified : user.email_verified;
  if (!verified) {
    // Verification happens once, at registration. Finish it now if it was skipped.
    await startOtp(req, user, 'register', channelOf(user));
    req.flash('error', `Please verify your ${channelOf(user) === 'sms' ? 'phone number' : 'email'} first. We sent you a new code.`);
    return res.redirect('/verify-otp');
  }
  // Password is correct and the account was verified at registration: sign in directly.
  return req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    req.session.ua = String(req.get('user-agent') || '').slice(0, 200);
    req.session.ip = req.ip;
    req.session.loginAt = db.now();
    audit(req, 'auth.login', { entity: 'user', entityId: user.id, actor: user });
    res.redirect(DASHBOARD[user.role]);
  });
}));

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'auth.logout', { entity: 'user', entityId: req.user.id });
  req.session.destroy(() => res.redirect('/login'));
});
router.post('/logout-all', (req, res) => {
  if (!req.user) return res.redirect('/login');
  audit(req, 'auth.logout_all', { entity: 'user', entityId: req.user.id });
  logoutEverywhere(req.user.id);
  res.redirect('/login');
});

// ---------- Forgot password (3 steps) ----------
router.get('/forgot-password', (req, res) => {
  let step = Number(req.query.step) || 1;
  if (step === 2 && !req.session.pendingOtp) step = 1;
  if (step === 3 && (!req.session.resetUserId || Date.now() > req.session.resetUntil)) step = 1;
  const p = req.session.pendingOtp;
  res.render('auth/forgot', {
    title: 'Reset password', step, email: p ? mask(p.email) : '', devOtp: step === 2 ? req.session.devOtp : null,
    wait: p && p.userId ? otp.cooldownRemaining(p.userId, 'reset') : 0,
    artTitle: 'Reset your password securely.', artText: 'We verify it is you with a one-time code sent to your email.',
    artFeatures: [['shield', 'Email verification', 'A 6-digit code confirms your identity'], ['file', 'Your data stays protected', 'Sessions and credentials are secured']],
  });
});

router.post('/forgot-password', limiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const user = db.get('SELECT * FROM users WHERE email = ? AND email_verified = 1', email);
  if (user && otp.cooldownRemaining(user.id, 'reset') === 0) await startOtp(req, user, 'reset');
  else if (!user) { req.session.pendingOtp = { userId: null, purpose: 'reset', email }; req.session.devOtp = null; }
  else req.session.pendingOtp = { userId: user.id, purpose: 'reset', email };
  req.flash('success', 'If an account exists for that email, we sent a 6-digit code.');
  res.redirect('/forgot-password?step=2');
}));

router.post('/reset-password', ah(async (req, res) => {
  const id = req.session.resetUserId;
  if (!id || Date.now() > req.session.resetUntil) return res.redirect('/forgot-password');
  const problem = passwordProblem(req.body.password, req.body.confirm_password);
  if (problem) { req.flash('error', problem); return res.redirect('/forgot-password?step=3'); }
  db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', await bcrypt.hash(req.body.password, 12), id);
  logoutEverywhere(id);
  audit(req, 'auth.password_reset', { entity: 'user', entityId: id, actor: db.get('SELECT * FROM users WHERE id = ?', id) });
  req.session.regenerate(() => {
    req.flash('success', 'Password updated. Log in with your new password.');
    res.redirect('/login');
  });
}));

module.exports = router;
