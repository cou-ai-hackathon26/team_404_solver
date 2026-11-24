// End-to-end smoke test: starts the server on a throwaway database, signs in as
// every role (password + email OTP), opens every screen and runs key actions.
// Run with: npm test
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediconnect-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT: String(PORT), DB_FILE: path.join(tmp, 'test.db'), UPLOAD_DIR: path.join(tmp, 'uploads'), NODE_ENV: 'development', ANTHROPIC_API_KEY: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', DEV_SHOW_OTP: 'true' };

let passed = 0; let failed = 0;
let sqlite = null;
async function db(sql, ...p) {
  if (!sqlite) { const { DatabaseSync } = require('node:sqlite'); sqlite = new DatabaseSync(env.DB_FILE); }
  return sqlite.prepare(sql).get(...p);
}
function check(name, ok, info = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else {
    failed++;
    const L = Client.lastResp || {};
    const alerts = (L.text || '').match(/class="alert [^"]*">[^<]*(<ul>.*?<\/ul>)?/g) || [];
    console.log(`  ✗ ${name}${info ? ' — ' + info : ''}${process.env.SMOKE_DEBUG ? `\n      last: ${L.status} ${L.url} ${alerts.join(' | ').replace(/<[^>]+>/g, ' ').slice(0, 300)}` : ''}`);
  }
}

class Client {
  constructor() { this.jar = {}; }
  cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar[kv.slice(0, i)] = kv.slice(i + 1); }
  }
  async req(method, url, body) {
    let target = url;
    for (let hop = 0; hop < 6; hop++) {
      const opts = { method, redirect: 'manual', headers: { cookie: this.cookie(), 'user-agent': 'smoke-test' } };
      if (body && method === 'POST') { opts.headers['content-type'] = 'application/x-www-form-urlencoded'; const sp = new URLSearchParams(); for (const [k, v] of Object.entries(body)) [].concat(v).forEach((x) => sp.append(k, x)); opts.body = sp.toString(); }
      const res = await fetch(BASE + target, opts);
      this.store(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { target = res.headers.get('location'); method = 'GET'; body = null; continue; }
      const text = await res.text();
      this.last = text;
      Client.lastResp = { status: res.status, url: target, text };
      return { status: res.status, url: target, text };
    }
    throw new Error('Too many redirects');
  }
  get(url) { return this.req('GET', url); }
  async csrf(url) { const r = await this.get(url); const m = r.text.match(/name="_csrf" value="([^"]+)"/) || r.text.match(/name="csrf" content="([^"]+)"/); return m && m[1]; }
  async post(url, data, from) { const token = await this.csrf(from || url.replace(/\/[^/]*$/, '') || '/'); return this.req('POST', url, { _csrf: token, ...data }); }
  async login(email, password = 'Password123') {
    const token = await this.csrf('/login');
    return this.req('POST', '/login', { _csrf: token, email, password });
  }
  async multipart(url, fields, files = {}) {
    const token = await this.csrf(url);
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) [].concat(v).forEach((x) => fd.append(k, x));
    for (const [k, [name, type, body]] of Object.entries(files)) fd.append(k, new Blob([body], { type }), name);
    let target = `${url}${url.includes('?') ? '&' : '?'}_csrf=${token}`;
    const res = await fetch(BASE + target, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: this.cookie() } });
    this.store(res);
    if (res.headers.get('location')) return this.get(res.headers.get('location'));
    const out = { status: res.status, url: target, text: await res.text() };
    Client.lastResp = out;
    return out;
  }
  async json(url) { const r = await fetch(BASE + url, { headers: { cookie: this.cookie(), accept: 'application/json' } }); return r.json(); }
}

const PAGES = {
  'patient@mediconnect.local': ['/patient', '/patient/find-doctor', '/patient/appointments', '/patient/tests', '/patient/tests/compare?t=3&t=4', '/patient/records', '/patient/access', '/patient/order',
    '/patient/shop', '/patient/shop/cart', '/patient/orders', '/patient/profile', '/patient/profile?tab=security', '/patient/health', '/patient/analysis', '/patient/reminders', '/patient/assistant',
    '/emergency', '/blood', '/blood?group=O%2B', '/messages?list=1', '/notifications', '/search?q=lipid'],
  'dr.farhana@mediconnect.local': ['/doctor', '/doctor/requests', '/doctor/schedule', '/doctor/patients', '/doctor/prescriptions', '/doctor/test-orders', '/doctor/access', '/doctor/messages', '/messages?list=1', '/doctor/profile', '/blood', '/account'],
  'ambulance@mediconnect.local': ['/ambulance', '/ambulance/trips', '/ambulance/profile'],
  'center@mediconnect.local': ['/center', '/center/requests', '/center/collection', '/center/upload', '/center/catalog', '/center/staff', '/center/billing', '/center/profile'],
  'pharmacy@mediconnect.local': ['/pharmacy', '/pharmacy/orders', '/pharmacy/stock', '/pharmacy/delivery', '/pharmacy/payments', '/pharmacy/reviews', '/pharmacy/profile'],
  'admin@mediconnect.local': ['/admin', '/admin/verifications', '/admin/users', '/admin/users?role=doctor', '/admin/catalog', '/admin/audit'],
};
const bad = (r) => r.status !== 200 || /Something went wrong|ReferenceError|TypeError|is not defined/.test(r.text);

async function main() {
  console.log(`Starting test server on port ${PORT}…`);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/login'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }

    console.log('\nPublic pages');
    const anon = new Client();
    for (const u of ['/login', '/register', '/register/patient', '/register/doctor', '/register/center', '/register/pharmacy', '/register/ambulance', '/forgot-password']) { const r = await anon.get(u); check(`GET ${u}`, !bad(r), String(r.status)); }
    const p = await anon.get('/patient'); check('Protected page redirects to login', p.url.startsWith('/login'));
    const wrong = await anon.req('POST', '/login', { _csrf: await anon.csrf('/login'), email: 'patient@mediconnect.local', password: 'nope' });
    check('Wrong password is rejected', /incorrect|invalid/i.test(wrong.text));
    const nocsrf = await anon.req('POST', '/login', { email: 'x@y.z', password: 'x' });
    check('POST without CSRF token is refused', nocsrf.status === 403);

    const clients = {};
    for (const [email, pages] of Object.entries(PAGES)) {
      console.log(`\n${email}`);
      const c = new Client(); clients[email] = c;
      const r = await c.login(email);
      check('Login with email + password (no OTP)', r.status === 200 && !r.url.startsWith('/login') && !r.url.startsWith('/verify'), r.url);
      for (const u of pages) { const x = await c.get(u); check(`GET ${u}`, !bad(x), `${x.status} ${x.url}`); }
    }

    console.log('\nRole isolation');
    const pat = clients['patient@mediconnect.local'];
    for (const u of ['/admin', '/doctor', '/pharmacy', '/center', '/ambulance']) { const r = await pat.get(u); check(`Patient blocked from ${u}`, r.status === 403 || r.url !== u); }

    console.log('\nPatient features');
    const fd = await pat.post('/patient/find-doctor', { description: 'Chest pain and palpitations when climbing stairs' }, '/patient/find-doctor');
    check('Symptom checker recommends Cardiology', /Cardiology/.test(fd.text));
    const docId = (fd.text.match(/href="\/patient\/doctors\/(\d+)/) || [])[1];
    const dp = docId ? await pat.get(`/patient/doctors/${docId}`) : { status: 0, text: '' };
    check('Doctor page shows fee, map and slots', Boolean(docId) && !bad(dp) && /Consultation fee/.test(dp.text) && /data-map/.test(dp.text), String(docId));
    for (const [text, spec] of [['আমার হাতের হাড় ভেঙে গেছে', 'Orthopedics'], ['চামড়ায় চুলকানি আর ফুসকুড়ি', 'Dermatology'], ['skin problem', 'Dermatology'], ['broken arm', 'Orthopedics'], ['দাঁতে ব্যথা', 'Dentistry']]) {
      const r = await pat.post('/patient/find-doctor', { description: text }, '/patient/find-doctor');
      check(`“${text}” → ${spec}`, new RegExp(`<b class="grow"[^>]*>${spec}</b>`).test(r.text) && /Best match/.test(r.text));
      if (text === 'skin problem') check('Newly approved Dermatology doctor appears', /Dr\. Sharmin Sultana/.test(r.text) && /New on MediConnect/.test(r.text));
    }

    console.log('\nSlot booking → doctor approval');
    const slotPage = await pat.get(`/patient/doctors/${docId}`);
    const slot = (slotPage.text.match(/name="slot" value="([^"]+)"(?! disabled)/) || [])[1];
    check('Doctor has an open slot', Boolean(slot));
    let b = await pat.post(`/patient/doctors/${docId}/request`, { slot, reason: 'Chest tightness', mode: 'in_person' }, `/patient/doctors/${docId}`);
    check('Patient books the slot', /sent to .* for approval/.test(b.text));
    const apptId = (b.url.match(/id=(\d+)/) || [])[1];
    const docEmail = (await db('SELECT email FROM users WHERE id = ?', docId)).email;
    const dc = new Client(); await dc.login(docEmail);
    const rq = await dc.get(`/doctor/requests?id=${apptId}`);
    check('Doctor sees Approve / Delete for the booked slot', /accept-preferred/.test(rq.text) && /Delete/.test(rq.text));
    await dc.post(`/doctor/appointments/${apptId}/accept-preferred`, {}, `/doctor/requests?id=${apptId}`);
    const pn = await pat.get('/notifications');
    check('Patient notified that the slot is confirmed', /Appointment confirmed/.test(pn.text));
    let r = await pat.post('/patient/health', { kind: 'bp', value1: '150', value2: '95' }, '/patient/health');
    check('High BP reading flagged for doctor review', /Book a doctor/.test(r.text));
    r = await pat.post('/patient/health', { kind: 'sugar', value1: '5.4', context: 'fasting' }, '/patient/health');
    check('Normal sugar reading saved', /Saved\./.test(r.text));
    r = await pat.post('/patient/reminders/custom', { medicine_name: 'Vitamin D', per_day: '1', times: '09:00', days: '10', dose: '1 tablet', notify_push: '1' }, '/patient/reminders');
    check('Custom medicine reminder added', /Reminder added for Vitamin D/.test(r.text));
    r = await pat.post('/patient/assistant', { message: 'I have chest pain and cannot breathe' }, '/patient/assistant');
    check('Chatbot escalates emergency symptoms', /999|emergency/i.test(r.text));
    r = await pat.post('/patient/assistant', { message: 'How do I book a test?' }, '/patient/assistant');
    check('Chatbot answers a platform question', r.status === 200 && !bad(r));
    r = await pat.get('/blood');
    check('Blood bank page lists blood groups', /O\+|A\+|B\+/.test(r.text));

    console.log('\nDoctor chat');
    const nus = await db("SELECT id, email FROM users WHERE email = 'dr.nusrat@mediconnect.local'");
    r = await pat.post(`/messages/request/${nus.id}`, { topic: 'Quick question' }, `/patient/doctors/${nus.id}`);
    const tid = (await db('SELECT id FROM chat_threads WHERE doctor_id = ? ORDER BY id DESC LIMIT 1', nus.id)).id;
    const nc = new Client(); await nc.login(nus.email);
    r = await pat.post(`/messages/${tid}`, { body: 'hello' }, '/messages?list=1');
    check('Patient cannot message before the doctor accepts', /not open/.test(r.text));
    await nc.post(`/messages/${tid}/accept`, {}, '/messages?list=1');
    await pat.post(`/messages/${tid}`, { body: 'Hello doctor' }, `/messages/${tid}`);
    const poll = await nc.json(`/messages/${tid}/poll?after=0`);
    check('Doctor receives the message after accepting', poll.posts.some((p) => p.body === 'Hello doctor'));

    console.log('\nAmbulance');
    const nearby = await pat.json('/emergency/nearby');
    check('Online ambulances shown on the map', nearby.points.length >= 2);
    r = await pat.post('/emergency/request', { ambulance_id: 'nearest', lat: '23.7465', lng: '90.376', pickup_address: 'Dhanmondi', phone: '01712345678' }, '/emergency');
    check('Patient requests the nearest ambulance', /Ambulance tracking/.test(r.text));
    const trip = await db("SELECT r.id, u.email FROM ambulance_requests r JOIN ambulances a ON a.id = r.ambulance_id JOIN users u ON u.id = a.owner_user_id ORDER BY r.id DESC LIMIT 1");
    const ac = new Client(); await ac.login(trip.email);
    const ad = await ac.get('/ambulance');
    check('Ambulance sees the incoming request', /Incoming requests/.test(ad.text) && new RegExp(`/ambulance/requests/${trip.id}/accept`).test(ad.text));
    await ac.post(`/ambulance/requests/${trip.id}/accept`, {}, '/ambulance');
    await ac.post(`/ambulance/requests/${trip.id}/on_the_way`, {}, '/ambulance');
    const tp = await pat.json(`/emergency/trips/${trip.id}/poll`);
    check('Patient tracks the ambulance on the way', /On the way/.test(tp.status) && tp.points.length === 2);

    console.log('\nMedicine shop');
    const para = (await db("SELECT id FROM medicines WHERE name = 'Paracetamol'")).id;
    const omep = (await db("SELECT id FROM medicines WHERE name = 'Omeprazole'")).id;
    await pat.post('/patient/shop/cart', { medicine_id: para, qty: '10' }, '/patient/shop');
    await pat.post('/patient/shop/cart', { medicine_id: omep, qty: '14' }, '/patient/shop');
    const cart = await pat.get('/patient/shop/cart');
    const ids = [...cart.text.matchAll(/\/patient\/shop\/checkout\?pharmacy=(\d+)/g)].map((m) => m[1]);
    let ph = null;
    for (const id of ids) if ((await db('SELECT accepts_online FROM pharmacies WHERE id = ?', id)).accepts_online) { ph = id; break; }
    check('Cart ranks pharmacies that have every medicine', Boolean(ph) && /Has all 2 medicines/.test(cart.text));
    const before = await db('SELECT quantity FROM pharmacy_stock WHERE pharmacy_id = ? AND medicine_id = ?', ph, para);
    r = await pat.multipart('/patient/shop/checkout?pharmacy=' + ph, { pharmacy_id: ph, delivery_address: 'Road 5, Dhanmondi', lat: '23.7465', lng: '90.376', order_type: 'emergency', payment: 'mobile', wallet: 'bKash', wallet_number: '01712345678' });
    check('Emergency order paid with bKash', /paid by bKash/.test(r.text) && /Emergency delivery/.test(r.text));
    const ord = await db('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
    check('Payment recorded (sandbox transaction)', ord.payment_status === 'paid' && ord.order_type === 'emergency' && Boolean(await db('SELECT 1 x FROM payments WHERE order_id = ?', ord.id)));
    const pc = new Client(); await pc.login((await db('SELECT u.email FROM pharmacies p JOIN users u ON u.id = p.admin_user_id WHERE p.id = ?', ph)).email);
    await pc.post(`/pharmacy/orders/${ord.id}/accept`, { mode: 'full' }, `/pharmacy/orders/${ord.id}`);
    const after = await db('SELECT quantity, sold FROM pharmacy_stock WHERE pharmacy_id = ? AND medicine_id = ?', ph, para);
    check('Accepting the order updates live stock and sold count', after.quantity === before.quantity - 10);

    console.log('\nTests, blood bank, analysis, reminders, Health AI');
    const cmp = await pat.get('/patient/tests/compare?t=3&t=4&t=6&sort=cheapest');
    check('Test compare shows lowest total and discounts', /Lowest total price/.test(cmp.text) && /% off/.test(cmp.text));
    const cid = (cmp.text.match(/name="center_id" value="(\d+)"/) || [])[1];
    r = await pat.post('/patient/tests/book-multi', { center_id: cid, t: ['3', '4', '6'] }, '/patient/tests/compare?t=3');
    check('Several tests booked in one go', /3 tests booked/.test(r.text));
    const bs = await pat.get('/blood?group=A%2B');
    check('Blood search lists eligible donors with phone numbers', /eligible donor/.test(bs.text) && /href="tel:/.test(bs.text));
    r = await pat.post('/blood/donated', { donated_on: new Date().toISOString().slice(0, 10) }, '/blood');
    check('Donation date saved; next donation in 4 months', /4 months/.test(r.text));
    r = await pat.multipart('/patient/analysis/upload', { title: 'Test report', doc_date: new Date().toISOString().slice(0, 10), text: 'Hemoglobin 13.9 g/dL\nHbA1c 5.6 %\nTotal cholesterol 198 mg/dL' });
    check('Health document analysed (3 values found)', /Found 3 values/.test(r.text) && /Predicted/.test(r.text));
    r = await pat.post('/patient/reminders/custom', { medicine_name: 'Napa', dose: '1 tablet', per_day: '2', times: ['08:00', '20:00'], days: '5', notify_voice: '1' }, '/patient/reminders');
    check('Manual reminder with voice alert saved', /Reminder added for Napa/.test(r.text));
    const due = await pat.json('/patient/reminders/due');
    check('Due-dose API answers for voice/notification alerts', Array.isArray(due.doses));
    r = await pat.post('/patient/assistant', { message: 'আমার মাথা ব্যথা, কী করব?' }, '/patient/assistant');
    check('Health AI gives first-aid advice in Bangla', /পানি পান করুন/.test(r.text));

    console.log('\nChallenge 2: chatbot abstains when records and a drug-interaction rule disagree');
    r = await pat.post('/patient/assistant', { message: 'Can I take my omeprazole with clopidogrel?' }, '/patient/assistant');
    check('Abstains: records (omeprazole + clopidogrel prescribed) vs interaction rule', /answer this one safely/.test(r.text) && /Omeprazole can make clopidogrel work less well/.test(r.text));
    r = await pat.post('/patient/assistant', { message: 'Can I take ibuprofen for my headache?' }, '/patient/assistant');
    check('Abstains: asks for ibuprofen while records show aspirin', /answer this one safely/.test(r.text) && /Ibuprofen with aspirin/.test(r.text));
    r = await pat.post('/patient/assistant', { message: 'আমি কি আজ আমার ওষুধগুলো একসাথে খাব?' }, '/patient/assistant');
    check('Abstains in Bangla for a general medicine question', /উত্তর আমি দিতে পারছি না/.test(r.text));
    r = await pat.post('/patient/assistant', { message: 'Can I take paracetamol for fever?' }, '/patient/assistant');
    check('Still answers when no rule conflicts with the records', r.status === 200 && !/answer this one safely/.test(r.text.split('Can I take paracetamol for fever?').pop()));
    r = await pat.post('/patient/assistant', { message: 'I have chest pain, can I take ibuprofen?' }, '/patient/assistant');
    check('Emergency guard still comes first', /Call 999 now/.test(r.text.split('I have chest pain, can I take ibuprofen?').pop()));
    r = await clients['admin@mediconnect.local'].get('/admin/audit?action=assistant.');
    check('Abstention written to audit log', /assistant\.abstained/.test(r.text));
    const sad = new Client(); await sad.login('sadia@mediconnect.local');
    r = await sad.post('/patient/assistant', { message: 'Can I take ibuprofen?' }, '/patient/assistant');
    check('Patient with no conflicting records gets an answer', !/answer this one safely/.test(r.text));

    console.log('\nChallenge 1: caregiver proxy on a shared timeline');
    const rahimId = (await db("SELECT id FROM users WHERE email = 'patient@mediconnect.local'")).id;
    const kamalId = (await db("SELECT id FROM users WHERE email = 'kamal@mediconnect.local'")).id;
    const taniaId = (await db("SELECT id FROM users WHERE email = 'caregiver@mediconnect.local'")).id;
    const cg = new Client(); r = await cg.login('caregiver@mediconnect.local');
    check('Caregiver account logs in to its own portal', r.url.startsWith('/care') && /Care dashboard/.test(r.text));
    check('Care dashboard lists everyone she looks after', /Rahim Uddin/.test(r.text) && /Kamal Hasan/.test(r.text));
    check('Dashboard flags who needs attention', /Needs attention now|Keep an eye on/.test(r.text) && /Medicine safety/.test(r.text));
    r = await cg.get('/patient');
    check('Caregiver cannot open the patient portal', r.status === 403 || !r.url.startsWith('/patient'));
    const kamal = new Client(); await kamal.login('kamal@mediconnect.local');
    r = await kamal.get(`/care/timeline/${rahimId}`);
    check('A stranger cannot open the timeline', r.status === 403);
    r = await cg.get(`/care/timeline/${rahimId}`);
    check('Shared timeline shows reminders, vitals and reports together', /Today.s doses/.test(r.text) && /Latest vitals/.test(r.text) && /ECG report/.test(r.text) && /Blood pressure/.test(r.text));
    check('Timeline shows what is new since the last visit', /since your last visit/.test(r.text));
    check('Timeline shows the medicine safety alert', /Medicine safety alert/.test(r.text));
    const rep = (r.text.match(/href="(\/files\/report\/\d+)"/) || [])[1];
    if (rep) { const f = await cg.get(rep); check('Caregiver with report consent can open a report', f.status === 200); }
    const dose = await db(`SELECT d.id FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id WHERE r.patient_id = ? AND d.status = 'due' ORDER BY d.due_at LIMIT 1`, rahimId);
    if (dose) {
      r = await cg.post(`/care/timeline/${rahimId}/dose/${dose.id}/taken`, {}, `/care/timeline/${rahimId}`);
      check('Caregiver marks a dose taken for the patient', /marked as taken/.test(r.text));
      check('Dose records who acted', (await db('SELECT acted_by FROM dose_logs WHERE id = ?', dose.id)).acted_by === taniaId);
    }
    r = await cg.post(`/care/timeline/${rahimId}/reading`, { kind: 'bp', value1: '128', value2: '82' }, `/care/timeline/${rahimId}`);
    check('Caregiver logs a vital reading, shown as by the caregiver', /Saved Blood pressure 128\/82/.test(r.text) && /by Tania Rahman \(caregiver\)/.test(r.text));
    r = await cg.post(`/care/timeline/${rahimId}/note`, { body: 'Evening dose given after dinner.' }, `/care/timeline/${rahimId}`);
    check('Caregiver adds a care note to the timeline', /Note added/.test(r.text) && /Evening dose given after dinner/.test(r.text));
    r = await pat.get('/notifications');
    check('Patient is notified of caregiver actions', /Reading logged by your caregiver/.test(r.text) && /Care note from Tania Rahman/.test(r.text));
    r = await pat.post('/patient/health', { kind: 'bp', value1: '185', value2: '121' }, '/patient/health');
    r = await cg.get('/notifications');
    check('Caregiver is alerted about a dangerous reading', /Urgent reading: Rahim Uddin/.test(r.text));
    r = await sad.get(`/care/timeline/${rahimId}`);
    check('View-only caregiver sees only what was shared', /view only/.test(r.text) && !/ECG report/.test(r.text));
    if (rep) { const f = await sad.get(rep); check('Caregiver without report consent cannot open the report', f.status === 403); }
    r = await sad.post(`/care/timeline/${rahimId}/reading`, { kind: 'pulse', value1: '80' }, `/care/timeline/${rahimId}`);
    check('View-only caregiver cannot act', /view only, not to act/.test(r.text));
    r = await pat.post('/care/invite', { email: 'kamal@mediconnect.local', relationship: 'Friend', can_act: '1', share_vitals: '1' }, '/care');
    check('Invite without consent is refused', /Tick the consent box/.test(r.text));
    r = await pat.post('/care/invite', { email: 'kamal@mediconnect.local', relationship: 'Friend', consent: 'yes' }, '/care');
    check('Invite that shares nothing is refused', /Choose at least one thing to share/.test(r.text));
    r = await pat.post('/care/invite', { email: 'kamal@mediconnect.local', relationship: 'Friend', share_vitals: '1', consent: 'yes' }, '/care');
    check('Patient invites a caregiver with consent and chosen scope', /Invitation sent to Kamal Hasan/.test(r.text) && /Consent receipt/.test(r.text));
    r = await kamal.get(`/care/timeline/${rahimId}`);
    check('Nothing is shared before the caregiver accepts', r.status === 403);
    const inv = await db("SELECT id FROM caregiver_links WHERE patient_id = ? AND caregiver_id = ? AND status = 'pending'", rahimId, kamalId);
    r = await kamal.post(`/care/links/${inv.id}/accept`, {}, '/care');
    r = await kamal.get(`/care/timeline/${rahimId}`);
    check('Accepted caregiver sees only the vitals that were shared', r.status === 200 && /Medicine reminders are not shared/.test(r.text) && /Latest vitals/.test(r.text));
    r = await pat.post(`/care/links/${inv.id}/revoke`, {}, '/care');
    r = await kamal.get(`/care/timeline/${rahimId}`);
    check('Revoked caregiver loses access at once', r.status === 403);
    const reg2 = new Client();
    r = await reg2.get('/register');
    check('Registration offers a Caregiver account', /\/register\/caregiver/.test(r.text));
    r = await clients['admin@mediconnect.local'].get('/admin/audit?action=caregiver.');
    check('Caregiver views and actions are audit-logged', /caregiver\.timeline_view/.test(r.text) && /caregiver\.reading_logged/.test(r.text));
    const missedDose = await db(`SELECT d.id FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id WHERE r.patient_id = ? AND d.status = 'due' AND d.due_at < ?`, kamalId, new Date(Date.now() - 3600000).toISOString());
    if (missedDose) check('Caregiver is alerted automatically about a missed dose', (await db("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title LIKE 'Missed dose%'", taniaId)).n > 0);

    console.log('\nRegistration: role picker, OTP once, then direct login');
    const reg = new Client();
    r = await reg.multipart('/register/patient', { full_name: 'Test Patient', email: 'newpatient@example.com', phone: '01799999999', date_of_birth: '1995-01-01', password: 'Secret123', confirm_password: 'Secret123', accept_terms: '1' });
    let code = (r.text.match(/<code>(\d{6})<\/code>/) || [])[1];
    check('Patient registration sends an email code', Boolean(code) && /to n\*\*\*@example\.com/.test(r.text));
    r = await reg.req('POST', '/verify-otp', { _csrf: await reg.csrf('/verify-otp'), code });
    check('Email verified once', /From now on just log in/.test(r.text));
    r = await reg.login('newpatient@example.com', 'Secret123');
    check('Next login goes straight to the dashboard', r.url === '/patient');
    const pReg = new Client();
    r = await pReg.multipart('/register/pharmacy', { org_name: 'Test Shop', full_name: 'Owner', email: 'shop@example.com', phone: '01788888888', license_no: 'DL-1', org_address: 'Dhaka', password: 'Secret123', confirm_password: 'Secret123', accept_terms: '1' },
      { license: ['license.pdf', 'application/pdf', '%PDF-1.4 test'] });
    check('Medical shop is verified by SMS to the phone', /by SMS to \*+888/.test(r.text));
    code = (r.text.match(/<code>(\d{6})<\/code>/) || [])[1];
    r = await pReg.req('POST', '/verify-otp', { _csrf: await pReg.csrf('/verify-otp'), code });
    check('Phone verified; waiting for admin review', /Phone number verified/.test(r.text));

    console.log('\nAdmin verification flow');
    const admin = clients['admin@mediconnect.local'];
    const q = await admin.get('/admin/verifications');
    check('Pending ambulance is in the verification queue', /Mirpur Ambulance Service/.test(q.text));
    const id = (q.text.match(/action="\/admin\/verifications\/(\d+)\/approve"/) || [])[1];
    check('Verification queue has an applicant', Boolean(id));
    r = await admin.post(`/admin/verifications/${id}/approve`, { note: 'x' }, '/admin/verifications');
    check('Approval without checklist is refused', /Tick all three checks/.test(r.text));
    r = await admin.post(`/admin/verifications/${id}/approve`, { identity: '1', license: '1', details: '1' }, '/admin/verifications');
    check('Provider approved after checklist', /verified\. They now appear/.test(r.text));
    r = await admin.get('/admin/audit?action=admin.');
    check('Approval written to audit log', /admin\.provider_approved/.test(r.text));

    console.log('\nSign out');
    r = await pat.post('/logout', {}, '/patient');
    r = await pat.get('/patient');
    check('Logout ends the session', r.url.startsWith('/login'));
  } catch (e) {
    failed++; console.error(e);
  } finally {
    server.kill();
    if (sqlite) sqlite.close();
    if (failed) console.log('\nServer log (tail):\n' + log.split('\n').slice(-25).join('\n'));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}
main();
