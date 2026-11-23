// Sends one test email using the settings in .env, and says plainly what is wrong if it fails.
// Usage: npm run mailtest            (sends to your own SMTP_USER address)
//        npm run mailtest -- someone@example.com
const config = require('../src/config');
const { sendMail, consoleMode, verifyConnection } = require('../src/services/mailer');

(async () => {
  const to = process.argv[2] || config.smtp.user;
  console.log('\nMediConnect email test');
  console.log('  .env file  :', require('path').join(config.root, '.env'), require('fs').existsSync(require('path').join(config.root, '.env')) ? '(found)' : '(NOT FOUND)');
  console.log('  Email      :', config.smtp.user || '(empty: set SMTP_USER in .env)');
  console.log('  Password   :', config.smtp.pass ? `${config.smtp.pass.length} characters${config.smtp.pass.length === 16 ? '' : ' (a Google App Password has 16)'}` : '(empty: set SMTP_PASS in .env)');
  console.log('  Server     :', `${config.smtp.host || '(none)'}:${config.smtp.port}`);
  if (consoleMode()) { console.log('\nRESULT: email is OFF. Fill SMTP_USER and SMTP_PASS in .env and run this again.\n'); process.exit(1); }
  const v = await verifyConnection();
  if (!v.ok) { console.log(`\nRESULT: FAILED (${v.error})\nFix: ${v.advice}\n`); process.exit(1); }
  const r = await sendMail({ to, subject: 'MediConnect test email', text: 'Email is working. Your verification code would look like this: 123456\n\nMediConnect' });
  console.log(r.console ? '\nRESULT: FAILED, see the message above.\n' : `\nRESULT: SENT OK to ${to}. Check the inbox (and the Spam folder).\n`);
  process.exit(r.console ? 1 : 0);
})();
