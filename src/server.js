const config = require('./config'); // loads .env and sets the time zone first
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const db = require('./db');
const helpers = require('./helpers');
const SqliteStore = require('./services/sessionStore');
const { consoleMode, verifyConnection } = require('./services/mailer');
const sms = require('./services/sms');
const { flash, csrf, loadUser } = require('./middleware/core');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(config.root, 'views'));
app.set('trust proxy', 1);
Object.assign(app.locals, helpers);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'https://server.arcgisonline.com', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
      'connect-src': ["'self'"],
      'media-src': ["'self'", 'data:'],
    },
  },
  // Map tile servers (OpenStreetMap) block requests that carry no Referer header, so send the site origin.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));
app.use('/vendor/leaflet', express.static(path.join(config.root, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isDev ? 0 : '1d' }));
app.use(session({
  name: 'mc.sid',
  store: new SqliteStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true, // idle timeout: each request extends the session
  cookie: { httpOnly: true, sameSite: 'lax', secure: !config.isDev, maxAge: config.sessionTimeoutMinutes * 60_000 },
}));
app.use(flash);
app.use(loadUser);
app.use(csrf);

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/common'));
app.use('/', require('./routes/blood'));
app.use('/patient', require('./routes/patient'));
app.use('/doctor', require('./routes/doctor'));
app.use('/center', require('./routes/center'));
app.use('/pharmacy', require('./routes/pharmacy'));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/ambulance'));
app.use('/', require('./routes/chat'));
app.use('/care', require('./routes/care'));

app.use((req, res) => res.status(404).render('shared/error', { title: 'Page not found', message: 'That page does not exist.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('shared/error', { title: 'Something went wrong', message: config.isDev ? err.message : 'An unexpected error occurred. Please try again.' });
});

// Seed demo data automatically the first time the app runs.
if (!db.get('SELECT COUNT(*) AS n FROM users').n) require('./seed').seed();
require('./services/reminders').start();

app.listen(config.port, () => {
  console.log(`\nMediConnect running at http://localhost:${config.port}`);
  if (consoleMode()) {
    console.log(config.smtp.user && !config.smtp.pass
      ? `Email: OFF. Put the 16-letter Google App Password for ${config.smtp.user} in .env as SMTP_PASS, then restart. Until then codes are printed here.`
      : 'Email: OFF. Put your email (SMTP_USER) and its App Password (SMTP_PASS) in .env, then restart. Until then codes are printed here.');
  } else {
    verifyConnection().then((r) => console.log(r.ok
      ? `Email: ON. Verification codes are emailed from ${config.smtp.user || config.smtp.host} (port ${r.port}).`
      : `Email: login FAILED (${r.error}).\n  Fix: ${r.advice}\n  Codes are printed here until it is fixed. Test with: npm run mailtest`));
  }
  console.log(`SMS: ${sms.consoleMode() ? 'console mode (codes printed here)' : config.sms.provider}`);
  console.log(`Health Assistant: ${config.anthropicKey ? 'Claude API' : 'built-in answers (set ANTHROPIC_API_KEY to use Claude)'}`);
  console.log('Demo logins are listed in README.md (password for all: Password123)\n');
});
