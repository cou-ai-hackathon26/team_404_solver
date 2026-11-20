// Email delivery. With SMTP settings in .env (for example a Gmail account and an
// App Password) codes are emailed for real; without them they are printed in the terminal.
const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
if (config.smtp.host && (!config.smtp.user || config.smtp.pass)) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure || config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass.replace(/\s+/g, '') } : undefined,
  });
}

const consoleMode = () => !transporter;

function printToConsole({ to, subject, text }, reason) {
  console.log(`\n================ EMAIL (${reason}) ================`);
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log('======================================================\n');
}

const htmlFor = (text) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e5e9f2;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(90deg,#2563eb,#6366f1);color:#fff;padding:18px 24px;font-size:20px;font-weight:700">MediConnect</div>
  <div style="padding:22px 24px;color:#1e293b;font-size:15px;line-height:1.6">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>').replace(/\b(\d{6})\b/, '<b style="font-size:28px;letter-spacing:6px;color:#4f46e5">$1</b>')}</div>
</div>`;

async function sendMail({ to, subject, text, html }) {
  if (!transporter) { printToConsole({ to, subject, text }, 'console mode'); return { console: true }; }
  try {
    return await transporter.sendMail({ from: config.smtp.from, to, subject, text, html: html || htmlFor(text) });
  } catch (e) {
    // Never block sign-up because the mail server failed: log the code so it can still be used.
    console.error(`Email to ${to} failed (${e.message}). Check SMTP settings in .env.`);
    printToConsole({ to, subject, text }, 'SMTP failed, printed instead');
    return { console: true, error: e.message };
  }
}

/** Check the SMTP login once at start-up and print a clear message. */
async function verifyConnection() {
  if (!transporter) return null;
  try { await transporter.verify(); return true; } catch (e) { console.error(`SMTP login failed: ${e.message}`); return false; }
}

module.exports = { sendMail, consoleMode, verifyConnection };
