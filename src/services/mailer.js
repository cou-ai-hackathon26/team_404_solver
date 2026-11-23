// Email delivery (OTP codes and notices).
// Put your email address and its 16-letter Google App Password in .env (SMTP_USER and SMTP_PASS) and codes are
// emailed for real. Without them, codes are printed in the terminal so sign-up still works.
// If the network blocks port 465, the mailer retries on port 587 (STARTTLS) by itself and keeps using what works.
const nodemailer = require('nodemailer');
const config = require('../config');

const CONNECTION_ERRORS = ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'EHOSTUNREACH'];

const make = (port) => nodemailer.createTransport({
  host: config.smtp.host,
  port,
  secure: port === 465 ? true : port === 587 ? false : config.smtp.secure,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
});

let transporter = null;
let activePort = config.smtp.port;
if (config.smtp.host && (!config.smtp.user || config.smtp.pass)) transporter = make(activePort);

const consoleMode = () => !transporter;
let lastError = null;

function printToConsole({ to, subject, text }, reason) {
  console.log(`\n================ EMAIL (${reason}) ================`);
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log('======================================================\n');
}

/** A plain explanation of an SMTP error and how to fix it. */
function advice(e) {
  const code = (e && (e.code || e.responseCode)) || '';
  const msg = String((e && e.message) || '');
  if (code === 'EAUTH' || /535|534|Invalid login|Username and Password not accepted|Application-specific password/i.test(msg)) {
    return 'Login refused. SMTP_PASS must be the 16-letter Google App Password (not your normal password), and 2-Step Verification must be on. ' +
      'A university or office Google account may block this: try a personal Gmail address instead.';
  }
  if (CONNECTION_ERRORS.includes(code) || /timeout|ECONN/i.test(msg)) {
    return 'Could not reach the mail server. Your network or antivirus may block ports 465/587: try a mobile hotspot, or turn off the antivirus "mail shield".';
  }
  if (/self.signed|certificate/i.test(msg)) return 'An antivirus or proxy is intercepting the secure connection. Turn off its email scanning and try again.';
  return 'Check SMTP_USER and SMTP_PASS in .env.';
}

/** Try the configured port; on a connection failure switch once to the other standard port. */
async function withFallback(fn) {
  try {
    return await fn(transporter);
  } catch (e) {
    if (!CONNECTION_ERRORS.includes(e.code) || !config.smtp.host) throw e;
    const other = activePort === 587 ? 465 : 587;
    const alt = make(other);
    const r = await fn(alt);
    transporter = alt;
    activePort = other;
    console.log(`Email: port ${config.smtp.port} was blocked, now using port ${other}.`);
    return r;
  }
}

const htmlFor = (text) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e5e9f2;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(90deg,#2563eb,#6366f1);color:#fff;padding:18px 24px;font-size:20px;font-weight:700">MediConnect</div>
  <div style="padding:22px 24px;color:#1e293b;font-size:15px;line-height:1.6">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>').replace(/\b(\d{6})\b/, '<b style="font-size:28px;letter-spacing:6px;color:#4f46e5">$1</b>')}</div>
</div>`;

async function sendMail({ to, subject, text, html }) {
  if (!transporter) { printToConsole({ to, subject, text }, 'console mode'); return { console: true }; }
  try {
    const r = await withFallback((t) => t.sendMail({ from: config.smtp.from, to, subject, text, html: html || htmlFor(text) }));
    lastError = null;
    console.log(`Email sent to ${to}: ${subject}`);
    return r;
  } catch (e) {
    // Never block sign-up because the mail server failed: print the code so it can still be used.
    lastError = e;
    console.error(`Email to ${to} failed (${e.code || ''} ${e.message}).\n  Fix: ${advice(e)}`);
    printToConsole({ to, subject, text }, 'email failed, printed instead');
    return { console: true, error: e.message };
  }
}

/** Check the SMTP login once at start-up. Returns { ok, error, advice }. */
async function verifyConnection() {
  if (!transporter) return { ok: false, error: 'not configured' };
  try {
    await withFallback((t) => t.verify());
    return { ok: true, port: activePort };
  } catch (e) {
    lastError = e;
    return { ok: false, error: `${e.code || ''} ${e.message}`.trim(), advice: advice(e) };
  }
}

const failedRecently = () => Boolean(lastError);

module.exports = { sendMail, consoleMode, verifyConnection, failedRecently, advice };
