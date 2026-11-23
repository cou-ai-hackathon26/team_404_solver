// First-run helper used by START.bat: makes sure email is set up before the app starts.
// It asks for the Gmail address and its 16-letter App Password once, saves them in .env,
// sends a test email, and asks again if Google refuses. Press Enter to skip (codes then show in the terminal).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
if (!fs.existsSync(ENV)) require('./setup-env');

const read = () => fs.readFileSync(ENV, 'utf8');
const get = (k) => { const m = read().match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
const set = (k, v) => {
  let s = read();
  const re = new RegExp('^' + k + '=.*$', 'm');
  s = re.test(s) ? s.replace(re, k + '=' + v) : k + '=' + v + '\n' + s;
  fs.writeFileSync(ENV, s);
};
const empty = (v) => !v || /^(PASTE_|your[-_ ])/i.test(v);
const test = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'mailtest.js')], { cwd: ROOT, stdio: 'inherit' }).status === 0;

// Answers are queued line by line, so typed and pasted input both work; a closed input counts as Enter.
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
let waiting = null, closed = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l.trim()); } else lines.push(l.trim()); });
rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
const ask = (q) => { process.stdout.write(q); return lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('') : new Promise((r) => { waiting = r; }); };

(async () => {
  console.log('\n=============== MediConnect email setup ===============');
  let user = get('SMTP_USER');
  if (!empty(user) && !empty(get('SMTP_PASS'))) {
    console.log('Email settings found. Checking them...');
    if (test()) { rl.close(); return; }
    console.log('The saved email settings did not work. Let\'s fix them.');
  }
  for (let i = 0; i < 3; i++) {
    const u = await ask(`Gmail address that sends the codes${empty(user) ? '' : ` [Enter = ${user}]`}: `);
    if (u) user = u;
    if (empty(user)) { console.log('No email given. Skipping: codes will be shown in this window.'); break; }
    const p = (await ask('16-letter Google App Password (Enter = skip): ')).replace(/\s+/g, '');
    if (!p) { console.log('Skipped. Codes will be shown in this window until you add the App Password.'); break; }
    if (p.length !== 16) console.log(`Note: that is ${p.length} characters; a Google App Password has 16.`);
    set('SMTP_USER', user);
    set('SMTP_PASS', p);
    if (test()) { console.log('Saved. Verification codes will now be emailed.'); break; }
    if (i < 2) console.log('\nThat did not work (see the reason above). Try again, or press Enter to skip.\n');
  }
  rl.close();
})();
