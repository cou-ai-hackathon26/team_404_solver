const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
// All schedules and times are shown in Bangladesh time unless TZ is set.
process.env.TZ = process.env.TZ || 'Asia/Dhaka';

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
// A value still holding the template's placeholder counts as not set.
const val = (v) => {
  const s = String(v ?? '').trim().replace(/^["']|["']$/g, '').trim();
  return /^(PASTE_|YOUR[-_ ]|your[-_ ]|xxx)/i.test(s) || /@example\.com$/i.test(s) ? '' : s;
};
// Email: only the address and its App Password are required; Gmail settings are filled in by default.
const mailUser = val(process.env.SMTP_USER || process.env.EMAIL_USER);
const mailPass = val(process.env.SMTP_PASS || process.env.EMAIL_APP_PASSWORD).replace(/\s+/g, '');
const mailHost = val(process.env.SMTP_HOST) || (mailUser ? 'smtp.gmail.com' : '');
const mailPort = int(val(process.env.SMTP_PORT), mailHost === 'smtp.gmail.com' ? 465 : 587);
const ROOT = path.join(__dirname, '..');

const config = {
  root: ROOT,
  port: int(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  sessionTimeoutMinutes: int(process.env.SESSION_TIMEOUT_MINUTES, 30),
  smtp: {
    host: mailHost,
    port: mailPort,
    secure: val(process.env.SMTP_SECURE) ? val(process.env.SMTP_SECURE).toLowerCase() === 'true' : mailPort === 465,
    user: mailUser,
    pass: mailPass,
    from: val(process.env.MAIL_FROM) || (mailUser ? `MediConnect <${mailUser}>` : 'MediConnect <no-reply@mediconnect.local>'),
  },
  // While SMS is not set up, pharmacy and ambulance codes are emailed as well, so every code reaches an inbox.
  smsEmailCopy: String(process.env.SMS_EMAIL_COPY ?? 'true').toLowerCase() === 'true',
  sms: {
    provider: (process.env.SMS_PROVIDER || 'console').toLowerCase(), // console | bulksmsbd | twilio
    apiKey: process.env.SMS_API_KEY || '',
    senderId: process.env.SMS_SENDER_ID || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_FROM || '',
  },
  // Show the OTP on the page only for automated tests. Off by default: the code goes to email (or the terminal).
  devShowOtp: String(process.env.SHOW_OTP_ON_PAGE ?? 'false').toLowerCase() === 'true',
  otp: {
    expiryMinutes: int(process.env.OTP_EXPIRY_MINUTES, 5),
    maxAttempts: int(process.env.OTP_MAX_ATTEMPTS, 5),
    resendCooldownSeconds: int(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60),
  },
  maxFailedLogins: int(process.env.MAX_FAILED_LOGINS, 5),
  lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),
  accessGrantHours: int(process.env.ACCESS_GRANT_HOURS, 48),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  dbFile: path.resolve(ROOT, process.env.DB_FILE || 'data/mediconnect.db'),
  uploadDir: path.resolve(ROOT, process.env.UPLOAD_DIR || 'uploads'),
};

if (!config.isDev && config.sessionSecret === 'dev-only-insecure-secret') {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}

module.exports = config;
