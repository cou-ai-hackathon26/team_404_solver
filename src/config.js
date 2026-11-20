const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
// All schedules and times are shown in Bangladesh time unless TZ is set.
process.env.TZ = process.env.TZ || 'Asia/Dhaka';

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
const ROOT = path.join(__dirname, '..');

const config = {
  root: ROOT,
  port: int(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  sessionTimeoutMinutes: int(process.env.SESSION_TIMEOUT_MINUTES, 30),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || (process.env.SMTP_USER ? `MediConnect <${process.env.SMTP_USER}>` : 'MediConnect <no-reply@mediconnect.local>'),
  },
  sms: {
    provider: (process.env.SMS_PROVIDER || 'console').toLowerCase(), // console | bulksmsbd | twilio
    apiKey: process.env.SMS_API_KEY || '',
    senderId: process.env.SMS_SENDER_ID || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_FROM || '',
  },
  devShowOtp: String(process.env.DEV_SHOW_OTP ?? 'true').toLowerCase() === 'true',
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
