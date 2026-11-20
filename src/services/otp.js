// One-Time Password service: 6-digit codes, stored hashed, with expiry,
// attempt limits and a resend cooldown.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mailer');
const { sendSms } = require('./sms');

const PURPOSE_TEXT = {
  register: 'verify your email address',
  login: 'complete your sign-in',
  reset: 'reset your password',
};

function hash(code, userId, purpose) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${userId}:${purpose}:${code}`)
    .digest('hex');
}

function latest(userId, purpose) {
  return db.get(
    'SELECT * FROM otps WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    userId,
    purpose
  );
}

/** Seconds the user must wait before another code can be sent (0 = can send now). */
function cooldownRemaining(userId, purpose) {
  const last = latest(userId, purpose);
  if (!last) return 0;
  const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
  return Math.max(0, Math.ceil(config.otp.resendCooldownSeconds - elapsed));
}

/**
 * Create and email a new OTP. Invalidates earlier unused codes for the same purpose.
 * Returns { code } (code is returned only so dev mode can display it).
 */
async function issue(user, purpose, channel = 'email') {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expires = new Date(Date.now() + config.otp.expiryMinutes * 60_000).toISOString();
  db.run('UPDATE otps SET consumed = 1 WHERE user_id = ? AND purpose = ? AND consumed = 0', user.id, purpose);
  db.run(
    'INSERT INTO otps (user_id, purpose, code_hash, expires_at, channel) VALUES (?, ?, ?, ?, ?)',
    user.id,
    purpose,
    hash(code, user.id, purpose),
    expires,
    channel
  );
  if (channel === 'sms') {
    await sendSms(user.phone, `MediConnect code: ${code}. Use it to ${PURPOSE_TEXT[purpose]}. Expires in ${config.otp.expiryMinutes} min. Do not share it.`);
    return { code };
  }
  await sendMail({
    to: user.email,
    subject: `Your MediConnect verification code: ${code}`,
    text:
      `Hello ${user.full_name},\n\n` +
      `Use this code to ${PURPOSE_TEXT[purpose]}: ${code}\n\n` +
      `It expires in ${config.otp.expiryMinutes} minutes. If you did not request it, ignore this email ` +
      `and consider changing your password.\n\nMediConnect`,
  });
  return { code };
}

/** Verify a code. Returns { ok: true } or { ok: false, error }. */
function verify(userId, purpose, code) {
  const row = latest(userId, purpose);
  if (!row || row.consumed) return { ok: false, error: 'No active code. Please request a new one.' };
  if (new Date(row.expires_at) < new Date()) {
    db.run('UPDATE otps SET consumed = 1 WHERE id = ?', row.id);
    return { ok: false, error: 'This code has expired. Please request a new one.' };
  }
  if (row.attempts >= config.otp.maxAttempts) {
    db.run('UPDATE otps SET consumed = 1 WHERE id = ?', row.id);
    return { ok: false, error: 'Too many wrong attempts. Please request a new code.' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(hash(String(code || '').trim(), userId, purpose), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    db.run('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', row.id);
    const left = config.otp.maxAttempts - row.attempts - 1;
    return { ok: false, error: `Incorrect code. ${left} attempt(s) left.` };
  }
  db.run('UPDATE otps SET consumed = 1 WHERE id = ?', row.id);
  return { ok: true };
}

module.exports = { issue, verify, cooldownRemaining };
