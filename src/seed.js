// Demo data matching the MediConnect designs. Runs automatically on first start;
// `npm run reset` wipes everything and seeds again. All demo passwords: Password123
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PASSWORD = 'Password123';

function minimalPdf(lines) {
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 16 : 12} Tf 60 ${770 - i * 22} Td (${String(l).replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
}

function seed() {
  const bcrypt = require('bcryptjs');
  const db = require('./db');
  const { dateStr } = require('./services/schedule');
  const hash = bcrypt.hashSync(PASSWORD, 10);
  console.log('Seeding demo data…');

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  /** ISO time `days` from today at hh:mm local time (negative = past). */
  const at = (days, hm = '10:00') => {
    const [h, m] = hm.split(':').map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m).toISOString();
  };
  const day = (days) => dateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  const writeFile = (dir, name, lines) => {
    const d = path.join(config.uploadDir, dir);
    fs.mkdirSync(d, { recursive: true });
    const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
    const body = minimalPdf(lines);
    fs.writeFileSync(path.join(d, file), body);
    return { rel: path.join(dir, file), size: Buffer.byteLength(body) };
  };

  db.tx(() => {
    const user = (role, email, name, phone, extra = {}) =>
      db.run(
        'INSERT INTO users (role, email, password_hash, full_name, phone, status, email_verified, phone_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        role, email, hash, name, phone, extra.status || 'active', extra.created || at(-200)
      ).id;

    // ---------- catalogs ----------
    const tests = [
      ['ECG', 'Cardiology'], ['Echocardiogram', 'Cardiology'], ['Lipid profile', 'Blood'], ['Complete blood count', 'Blood'],
      ['Blood sugar (fasting)', 'Blood'], ['HbA1c', 'Blood'], ['Serum creatinine', 'Blood'], ['Liver function test', 'Blood'],
      ['Thyroid profile', 'Blood'], ['Urine routine', 'Pathology'], ['Dengue NS1', 'Blood'], ['Chest X-ray', 'Imaging'],
      ['Ultrasound (abdomen)', 'Imaging'], ['MRI brain', 'Imaging'], ['CT scan head', 'Imaging'],
      ['Vitamin D', 'Blood'], ['Uric acid', 'Blood'], ['Urine culture', 'Pathology'], ['Eye checkup', 'Eye'], ['Dental X-ray', 'Imaging'],
    ];
    const T = {};
    for (const [n, c] of tests) T[n] = db.run('INSERT INTO test_catalog (name, category) VALUES (?, ?)', n, c).id;

    const meds = [
      ['Paracetamol', 'Napa', 'Tablet', '500 mg', 0], ['Omeprazole', 'Seclo', 'Capsule', '20 mg', 0], ['Cetirizine', 'Alatrol', 'Tablet', '10 mg', 0],
      ['Amoxicillin', 'Moxacil', 'Capsule', '500 mg', 1], ['Azithromycin', 'Zimax', 'Tablet', '500 mg', 1], ['Amlodipine', 'Camlodin', 'Tablet', '5 mg', 1],
      ['Losartan', 'Angilock', 'Tablet', '50 mg', 1], ['Metformin', 'Comet', 'Tablet', '500 mg', 1], ['Atorvastatin', 'Atova', 'Tablet', '10 mg', 1],
      ['Montelukast', 'Monas', 'Tablet', '10 mg', 1], ['Esomeprazole', 'Sergel', 'Capsule', '20 mg', 0], ['Fexofenadine', 'Fexo', 'Tablet', '120 mg', 0],
      ['Ciprofloxacin', 'Ciprocin', 'Tablet', '500 mg', 1], ['Levothyroxine', 'Thyrox', 'Tablet', '50 mcg', 1], ['Salbutamol', 'Sultolin', 'Inhaler', '100 mcg', 1],
      ['Oral rehydration salts', 'Orsaline-N', 'Sachet', '10.25 g', 0],
      ['Aspirin', 'Ecosprin', 'Tablet', '75 mg', 0], ['Clopidogrel', 'Clopid', 'Tablet', '75 mg', 1], ['Ibuprofen', 'Profen', 'Tablet', '400 mg', 0],
    ];
    const M = {};
    for (const m of meds) M[m[0]] = db.run('INSERT INTO medicines (name, brand, form, strength, rx_required) VALUES (?, ?, ?, ?, ?)', ...m).id;

    // ---------- admin ----------
    user('admin', 'admin@mediconnect.local', 'Super Admin', '01700000000');

    // ---------- patients ----------
    const patient = (email, name, phone, dob, gender, blood, addr, lat, lng, created, extra = {}) => {
      const id = user('patient', email, name, phone, { created });
      db.run(
        `INSERT INTO patient_profiles (user_id, patient_code, date_of_birth, gender, blood_group, address, emergency_contact, height_cm, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, `PT-2026-${String(100 + id).padStart(4, '0')}`, dob, gender, blood, addr, extra.emergency || null, extra.height || null, lat, lng);
      return id;
    };
    const rahim = patient('patient@mediconnect.local', 'Rahim Uddin', '01712345678', '1992-03-05', 'Male', 'B+', 'House 12, Road 5, Dhanmondi, Dhaka', 23.7465, 90.376, at(-40), { emergency: '01811223344', height: 170 });
    db.run("UPDATE patient_profiles SET patient_code = 'PT-2026-0148' WHERE user_id = ?", rahim);
    const sadia = patient('sadia@mediconnect.local', 'Sadia Akter', '01712000002', '1997-06-11', 'Female', 'O+', 'Kalabagan, Dhaka', 23.749, 90.379, at(-120));
    const kamal = patient('kamal@mediconnect.local', 'Kamal Hasan', '01712000003', '1974-02-20', 'Male', 'A+', 'Green Road, Dhaka', 23.753, 90.383, at(-150));
    const nasrin = patient('nasrin@mediconnect.local', 'Nasrin Sultana', '01712000004', '1979-09-01', 'Female', 'AB+', 'Mohammadpur, Dhaka', 23.759, 90.36, at(-160));
    // Background patients for charts and the blood donor registry.
    const extraNames = ['Arif Khan', 'Mitu Das', 'Shuvo Roy', 'Farzana Yasmin', 'Tanim Hasan', 'Jannatul Ferdous', 'Rakib Hossain', 'Nadia Islam', 'Sabbir Ahmed', 'Tania Sultana', 'Mahfuz Alam', 'Rumana Akter'];
    const groups = ['O+', 'A+', 'B+', 'O-', 'AB+', 'A-', 'B+', 'O+', 'A+', 'B-', 'O+', 'AB-'];
    const extra = extraNames.map((n, i) => patient(`patient${i + 2}@mediconnect.local`, n, `0171300${String(1000 + i)}`, `19${80 + (i % 18)}-0${(i % 9) + 1}-1${i % 9}`,
      i % 2 ? 'Female' : 'Male', groups[i], 'Dhaka', 23.73 + (i % 6) * 0.012, 90.36 + (i % 5) * 0.013, at(-170 + i * 13)));

    // ---------- doctors ----------
    const HOURS = {
      farhana: { 6: ['09:00', '13:00'], 0: ['15:00', '20:00'], 1: ['09:00', '13:00'], 2: ['15:00', '20:00'], 3: ['09:00', '13:00'], 4: ['15:00', '18:00'] },
      evening: { 6: ['17:00', '21:00'], 0: ['17:00', '21:00'], 1: ['17:00', '21:00'], 2: ['17:00', '21:00'], 3: ['17:00', '21:00'], 4: ['17:00', '21:00'] },
      morning: { 6: ['10:00', '14:00'], 0: ['10:00', '14:00'], 1: ['10:00', '14:00'], 2: ['10:00', '14:00'], 3: ['10:00', '14:00'], 4: ['10:00', '14:00'] },
      full: { 6: ['09:00', '20:00'], 0: ['09:00', '20:00'], 1: ['09:00', '20:00'], 2: ['09:00', '20:00'], 3: ['09:00', '20:00'], 4: ['09:00', '20:00'], 5: ['16:00', '20:00'] },
    };
    const doctor = (email, name, spec, qual, exp, fee, addr, lat, lng, hours, extra = {}) => {
      const id = user('doctor', email, name, extra.phone || `0171500${String(Math.floor(Math.random() * 9000) + 1000)}`, { status: extra.status, created: extra.created });
      db.run(
        `INSERT INTO doctor_profiles (user_id, specialty, qualifications, experience_years, license_no, fee, bio, address, lat, lng, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, spec, qual, exp, `BMDC-A${40000 + id * 7}`, fee, `${spec} consultant with ${exp} years of experience in Dhaka.`, addr, lat, lng, extra.status === 'pending' ? 0 : 1);
      for (let wd = 0; wd < 7; wd++) {
        const h = HOURS[hours][wd];
        db.run('INSERT INTO doctor_hours (doctor_id, weekday, enabled, start_time, end_time) VALUES (?, ?, ?, ?, ?)', id, wd, h ? 1 : 0, h ? h[0] : '09:00', h ? h[1] : '13:00');
      }
      return id;
    };
    const farhana = doctor('dr.farhana@mediconnect.local', 'Dr. Farhana Rahman', 'Cardiology', 'MBBS, FCPS (Cardiology)', 12, 1000, 'Dhanmondi, Dhaka', 23.74, 90.373, 'farhana');
    const imran = doctor('dr.imran@mediconnect.local', 'Dr. Imran Hossain', 'Cardiology', 'MBBS, MD (Cardiology)', 9, 800, 'Panthapath, Dhaka', 23.7516, 90.388, 'full');
    const nusrat = doctor('dr.nusrat@mediconnect.local', 'Dr. Nusrat Jahan', 'General Medicine', 'MBBS, FCPS (Medicine)', 7, 600, 'Mohammadpur, Dhaka', 23.759, 90.36, 'full');
    db.run('UPDATE doctor_profiles SET max_per_day = 16 WHERE user_id = ?', farhana);
    db.run("INSERT INTO doctor_time_off (doctor_id, start_date, end_date, reason) VALUES (?, ?, ?, 'Medical conference'), (?, ?, ?, 'Victory Day')",
      farhana, day(8), day(10), farhana, `${now.getFullYear()}-12-16`, `${now.getFullYear()}-12-16`);
    const others = [
      ['dr.kamal@mediconnect.local', 'Dr. Kamal Uddin', 'Neurology', 'MBBS, MD (Neurology)', 18, 1500, 'Panthapath, Dhaka', 23.7516, 90.388, 'evening'],
      ['dr.arif@mediconnect.local', 'Dr. Arif Rahman', 'Gastroenterology', 'MBBS, MD (Gastro)', 11, 1000, 'Green Road, Dhaka', 23.753, 90.383, 'evening'],
      ['dr.tahmina@mediconnect.local', 'Dr. Tahmina Akter', 'Pulmonology', 'MBBS, FCPS (Chest)', 12, 1000, 'Mirpur 10, Dhaka', 23.807, 90.368, 'morning'],
      ['dr.sabrina@mediconnect.local', 'Dr. Sabrina Karim', 'Dermatology', 'MBBS, DDV', 7, 800, 'Gulshan 2, Dhaka', 23.7925, 90.415, 'evening'],
      ['dr.mahmud@mediconnect.local', 'Dr. Mahmudul Hasan', 'Orthopedics', 'MBBS, MS (Ortho)', 16, 1200, 'Banani, Dhaka', 23.794, 90.404, 'evening'],
      ['dr.chowdhury@mediconnect.local', 'Dr. Imtiaz Chowdhury', 'Endocrinology', 'MBBS, MD (Endocrinology)', 10, 1100, 'Dhanmondi 27, Dhaka', 23.755, 90.374, 'morning'],
      ['dr.rezaul@mediconnect.local', 'Dr. Rezaul Karim', 'ENT', 'MBBS, MS (ENT)', 8, 800, 'Farmgate, Dhaka', 23.758, 90.39, 'morning'],
      ['dr.laila@mediconnect.local', 'Dr. Laila Sultana', 'Psychiatry', 'MBBS, MD (Psychiatry)', 13, 1300, 'Uttara, Dhaka', 23.874, 90.398, 'evening'],
      ['dr.shirin@mediconnect.local', 'Dr. Shirin Akhter', 'Gynecology & Obstetrics', 'MBBS, FCPS (Gynae)', 15, 1000, 'Dhanmondi, Dhaka', 23.744, 90.379, 'morning'],
      ['dr.hasan@mediconnect.local', 'Dr. Mehedi Hasan', 'Pediatrics', 'MBBS, DCH', 9, 700, 'Mohammadpur, Dhaka', 23.76, 90.362, 'evening'],
    ];
    others.push(
      ['dr.nabila@mediconnect.local', 'Dr. Nabila Hossain', 'Ophthalmology', 'MBBS, DO, FCPS (Eye)', 10, 900, 'Farmgate, Dhaka', 23.757, 90.389, 'evening'],
      ['dr.rafi@mediconnect.local', 'Dr. Rafiul Islam', 'Dentistry', 'BDS, MS (Conservative Dentistry)', 8, 600, 'Dhanmondi 15, Dhaka', 23.746, 90.371, 'full'],
      ['dr.zaman@mediconnect.local', 'Dr. Asaduzzaman', 'Urology', 'MBBS, MS (Urology)', 14, 1200, 'Shyamoli, Dhaka', 23.771, 90.365, 'evening'],
      ['dr.mitu@mediconnect.local', 'Dr. Mithila Rahman', 'Nephrology', 'MBBS, MD (Nephrology)', 11, 1100, 'Panthapath, Dhaka', 23.751, 90.389, 'morning'],
      ['dr.saif@mediconnect.local', 'Dr. Saiful Karim', 'Orthopedics', 'MBBS, D-Ortho', 6, 800, 'Kalabagan, Dhaka', 23.7495, 90.38, 'full'],
    );
    for (const d of others) doctor(...d);
    // A doctor approved by the admin this week: shows that newly added specialists appear in AI search.
    doctor('dr.sharmin@mediconnect.local', 'Dr. Sharmin Sultana', 'Dermatology', 'MBBS, DDV (BSMMU)', 5, 700, 'Green Road, Dhaka', 23.752, 90.384, 'full', { created: at(-3) });
    // Dr. Farhana shares her live location (demo position near her chamber).
    db.run('UPDATE doctor_profiles SET share_location = 1, live_lat = 23.7412, live_lng = 90.3745, live_at = ? WHERE user_id = ?', new Date().toISOString(), farhana);
    const tanvir = doctor('dr.tanvir@mediconnect.local', 'Dr. Tanvir Ahmed', 'Cardiology', 'MBBS, MD (Cardiology)', 8, 900, 'Dhaka', 23.75, 90.39, 'evening', { status: 'pending', created: at(-2) });
    const salma = doctor('dr.salma@mediconnect.local', 'Dr. Salma Khatun', 'Pediatrics', 'MBBS, DCH', 6, 700, 'Dhaka', 23.76, 90.37, 'morning', { status: 'pending', created: at(-1) });

    // ---------- diagnostic centers ----------
    const center = (email, staff, name, addr, lat, lng, phone, hours, services, priced, extra = {}) => {
      const cid = db.run('INSERT INTO centers (name, address, lat, lng, phone, email, opening_hours, services, license_no, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        name, addr, lat, lng, phone, email, hours, services, `TL-${Math.floor(Math.random() * 90000) + 10000}`, extra.status === 'pending' ? 0 : 1).id;
      const uid = user('center', email, staff, phone, { status: extra.status, created: extra.created });
      db.run('INSERT INTO center_members (user_id, center_id, is_admin, title) VALUES (?, ?, 1, ?)', uid, cid, 'Center Admin');
      for (const [t, price, rt, avail] of priced) db.run('INSERT INTO center_tests (center_id, test_id, price, report_time, available, updated_at) VALUES (?, ?, ?, ?, ?, ?)', cid, T[t], price, rt, avail ?? 1, at(-Math.floor(Math.random() * 40)));
      return { cid, uid };
    };
    const city = center('center@mediconnect.local', 'City Diagnostic Center', 'City Diagnostic Center', 'Road 2, Dhanmondi, Dhaka', 23.7385, 90.382, '01960000001', 'Open 8 AM to 9 PM', 'Lipid profile, ECG, blood tests, home sample collection', [
      ['ECG', 600, 'Same day'], ['Echocardiogram', 2500, 'Same day'], ['Lipid profile', 900, 'Next day'], ['Complete blood count', 450, 'Same day'],
      ['Blood sugar (fasting)', 200, 'Same day'], ['HbA1c', 1000, 'Next day'], ['Serum creatinine', 350, 'Same day'], ['Liver function test', 1200, 'Next day'],
      ['Thyroid profile', 1800, 'Next day'], ['Urine routine', 300, 'Same day'], ['Dengue NS1', 500, 'Same day'], ['Chest X-ray', 700, 'Same day'], ['Ultrasound (abdomen)', 1200, 'Next day', 0],
    ]);
    const lifeline = center('center2@mediconnect.local', 'Lifeline Imaging', 'Lifeline Imaging', 'Kalabagan, Dhaka', 23.7495, 90.3795, '01960000002', 'Open 9 AM to 8 PM', 'X-ray, ultrasound, MRI, CT', [
      ['Chest X-ray', 700, 'Same day'], ['Ultrasound (abdomen)', 1100, 'Same day'], ['MRI brain', 9000, 'Next day'], ['CT scan head', 5000, 'Same day'], ['ECG', 650, 'Same day'], ['Lipid profile', 950, 'Next day'],
    ]);
    db.run("UPDATE center_tests SET discount_pct = 10 WHERE center_id = ? AND test_id IN (?, ?)", city.cid, T['Lipid profile'], T['HbA1c']);
    db.run('INSERT INTO center_tests (center_id, test_id, price, report_time, discount_pct) VALUES (?, ?, 520, ?, 15), (?, ?, 220, ?, 15), (?, ?, 1050, ?, 15), (?, ?, 1700, ?, 15), (?, ?, 380, ?, 0), (?, ?, 1600, ?, 0)',
      lifeline.cid, T['Complete blood count'], 'Same day', lifeline.cid, T['Blood sugar (fasting)'], 'Same day', lifeline.cid, T.HbA1c, 'Next day', lifeline.cid, T['Thyroid profile'], 'Next day', lifeline.cid, T['Serum creatinine'], 'Same day', lifeline.cid, T['Vitamin D'], '2 days');
    db.run('UPDATE center_tests SET discount_pct = 15 WHERE center_id = ? AND test_id IN (?, ?)', lifeline.cid, T['Lipid profile'], T.ECG);
    const medinova = center('center4@mediconnect.local', 'Medinova Diagnostic', 'Medinova Diagnostic', 'Mirpur 10, Dhaka', 23.8069, 90.3687, '01960000004', 'Open 24 hours', 'All pathology tests, imaging, home collection', [
      ['ECG', 500, 'Same day'], ['Lipid profile', 800, 'Same day'], ['Complete blood count', 400, 'Same day'], ['Blood sugar (fasting)', 150, 'Same day'], ['HbA1c', 900, 'Same day'],
      ['Serum creatinine', 300, 'Same day'], ['Liver function test', 1000, 'Same day'], ['Thyroid profile', 1500, 'Next day'], ['Urine routine', 250, 'Same day'], ['Chest X-ray', 600, 'Same day'],
      ['Vitamin D', 2200, '2 days'], ['Uric acid', 400, 'Same day'], ['Dengue NS1', 450, 'Same day'],
    ]);
    db.run('UPDATE center_tests SET discount_pct = 25 WHERE center_id = ?', medinova.cid);
    const prime = center('center3@mediconnect.local', 'Prime Imaging', 'Prime Imaging', 'Uttara, Dhaka', 23.87, 90.4, '01960000003', 'Open 8 AM to 10 PM', 'Imaging', [['Chest X-ray', 650, 'Same day']], { status: 'pending', created: at(-1) });
    const rafiq = user('center', 'tech@mediconnect.local', 'Md. Rafiq Islam', '01960000011');
    db.run('INSERT INTO center_members (user_id, center_id, is_admin, title) VALUES (?, ?, 0, ?)', rafiq, city.cid, 'Lab Technician');

    // ---------- pharmacies ----------
    const pharmacy = (email, name, addr, lat, lng, mins, fee, online, stock, extra = {}) => {
      const uid = user('pharmacy', email, name, `0181100${String(Math.floor(Math.random() * 9000) + 1000)}`, { status: extra.status, created: extra.created });
      const pid = db.run(
        'INSERT INTO pharmacies (admin_user_id, name, address, lat, lng, phone, license_no, delivery_minutes, delivery_fee, accepts_cod, accepts_online, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        uid, name, addr, lat, lng, `0181100${uid}`, `DL-${2000 + uid}`, mins, fee, online, extra.status === 'pending' ? 0 : 1).id;
      for (const [m, price, qty, exp] of stock) db.run('INSERT INTO pharmacy_stock (pharmacy_id, medicine_id, price, quantity, expiry) VALUES (?, ?, ?, ?, ?)', pid, M[m], price, qty, exp || '2027-03');
      return { pid, uid };
    };
    const base = [['Amoxicillin', 12, 35], ['Azithromycin', 40, 60], ['Amlodipine', 5, 200], ['Losartan', 8, 180], ['Metformin', 4, 300], ['Atorvastatin', 10, 150],
      ['Montelukast', 16, 90], ['Esomeprazole', 7, 120], ['Fexofenadine', 9, 80], ['Ciprofloxacin', 15, 70], ['Levothyroxine', 3, 100], ['Salbutamol', 250, 12], ['Oral rehydration salts', 6, 200]];
    const green = pharmacy('pharmacy@mediconnect.local', 'Green Cross Pharmacy', 'Mirpur Road, Dhanmondi, Dhaka', 23.744, 90.379, 35, 30, 1,
      [['Paracetamol', 4, 140], ['Omeprazole', 6, 24], ['Cetirizine', 4, 0, '2026-12'], ...base.map(([m, p, q], i) => [m, p, i === 0 ? 18 : q, i === 1 ? '2026-12' : undefined])]);
    const plus = pharmacy('pharmacy2@mediconnect.local', 'Health Plus Pharmacy', 'Kalabagan, Dhaka', 23.748, 90.377, 50, 30, 1,
      [['Paracetamol', 3.5, 200], ['Omeprazole', 5.5, 90], ...base.slice(0, 8).map(([m, p, q]) => [m, p * 0.95, q])]);
    const care = pharmacy('pharmacy3@mediconnect.local', 'Care Medico', 'Gulshan 1, Dhaka', 23.78, 90.416, 60, 40, 1,
      [['Paracetamol', 4.5, 300], ['Omeprazole', 6.5, 150], ['Cetirizine', 4, 120], ...base.map(([m, p, q]) => [m, p * 1.08, q])]);
    const medeasy = pharmacy('pharmacy4@mediconnect.local', 'MedEasy Pharmacy', 'Mirpur 2, Dhaka', 23.805, 90.36, 45, 30, 1, [['Paracetamol', 4, 100]], { status: 'pending', created: at(0, '08:00') });

    db.run('UPDATE pharmacies SET discount_pct = 10, emergency_fee = 100, emergency_minutes = 20 WHERE id = ?', green.pid);
    db.run('UPDATE pharmacies SET discount_pct = 5, emergency_fee = 90, emergency_minutes = 25 WHERE id = ?', plus.pid);
    db.run('UPDATE pharmacies SET discount_pct = 12, emergency_fee = 150, emergency_minutes = 30 WHERE id = ?', care.pid);
    for (const st of db.all('SELECT id FROM pharmacy_stock')) db.run('UPDATE pharmacy_stock SET sold = ?, updated_at = ? WHERE id = ?', 20 + ((st.id * 37) % 180), at(-((st.id * 3) % 9)), st.id);
    db.run("UPDATE pharmacy_stock SET discount_pct = 15 WHERE medicine_id IN (?, ?) AND pharmacy_id = ?", M.Paracetamol, M.Omeprazole, care.pid);

    // ---------- ambulances ----------
    const amb = (email, owner, phone, service, vehicle, kind, area, lat, lng, base, perKm, online, extra = {}) => {
      const uid = user('ambulance', email, owner, phone, { status: extra.status, created: extra.created });
      db.run(`INSERT INTO ambulances (owner_user_id, service_name, vehicle_no, kind, driver_name, driver_phone, base_area, license_no, base_fare, per_km, lat, lng, location_at, online, verified)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, uid, service, vehicle, kind, extra.driver || owner, phone, area, `VR-${70000 + uid}`, base, perKm, lat, lng,
      new Date().toISOString(), online, extra.status === 'pending' ? 0 : 1);
      return uid;
    };
    amb('ambulance@mediconnect.local', 'Md. Jamal Uddin', '01811000101', 'Dhanmondi Rescue Ambulance', 'Dhaka Metro-Cha 11-2233', 'AC', 'Dhanmondi', 23.7442, 90.3721, 900, 60, 1, { driver: 'Md. Selim' });
    amb('ambulance2@mediconnect.local', 'Abdul Karim', '01811000102', 'LifeLine ICU Ambulance', 'Dhaka Metro-Cha 15-4410', 'ICU / Life support', 'Panthapath', 23.7525, 90.3901, 2500, 120, 1, { driver: 'Rubel Mia' });
    amb('ambulance3@mediconnect.local', 'Nurul Islam', '01811000103', 'Quick Care Ambulance', 'Dhaka Metro-Cha 12-0987', 'Non-AC', 'Mohammadpur', 23.7605, 90.3602, 600, 45, 1, { driver: 'Hasan Ali' });
    amb('ambulance4@mediconnect.local', 'Shahidul Haque', '01811000104', 'Gulshan Emergency Service', 'Dhaka Metro-Cha 19-5521', 'AC', 'Gulshan', 23.7808, 90.4161, 1000, 70, 0);
    const ambPending = amb('ambulance5@mediconnect.local', 'Kamrul Hasan', '01811000105', 'Mirpur Ambulance Service', 'Dhaka Metro-Cha 14-7781', 'Non-AC', 'Mirpur', 23.806, 90.368, 700, 50, 0, { status: 'pending', created: at(0, '07:30') });

    // ---------- provider documents for the admin review ----------
    const doc = (uid, kind, name, lines) => {
      const f = writeFile('documents', name, lines);
      db.run('INSERT INTO provider_documents (user_id, kind, file_path, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', uid, kind, f.rel, name, 'application/pdf', f.size, at(-1));
    };
    doc(tanvir, 'Medical license', 'medical-license.pdf', ['BMDC registration (DEMO)', 'Dr. Tanvir Ahmed', 'Registration: valid']);
    doc(tanvir, 'Degree certificate', 'degree-certificate.pdf', ['MBBS, MD (Cardiology) (DEMO)', 'Dr. Tanvir Ahmed']);
    doc(tanvir, 'National ID', 'national-id.pdf', ['National ID (DEMO)', 'Dr. Tanvir Ahmed']);
    doc(salma, 'Medical license', 'medical-license.pdf', ['BMDC registration (DEMO)', 'Dr. Salma Khatun']);
    doc(prime.uid, 'Trade license', 'trade-license.pdf', ['Trade license (DEMO)', 'Prime Imaging']);
    doc(medeasy.uid, 'Drug license', 'drug-license.pdf', ['DGDA drug license (DEMO)', 'MedEasy Pharmacy']);
    doc(ambPending, 'Vehicle registration', 'vehicle-registration.pdf', ['BRTA vehicle registration (DEMO)', 'Dhaka Metro-Cha 14-7781', 'Ambulance']);

    // ---------- appointments ----------
    const appt = (p, d, o) => {
      const id = db.run(
        `INSERT INTO appointments (patient_id, doctor_id, reason, preferred_time, proposed_time, alt_times, mode, duration, doctor_note, status, consultation_notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 30, ?, ?, ?, ?, ?)`,
        p, d, o.reason, o.pref || null, o.time || null, o.alts ? JSON.stringify(o.alts) : null, o.mode || 'in_person', o.note || null, o.status, o.notes || null, o.created || at(-1, '09:12'), o.updated || o.created || at(-1, '09:12')).id;
      for (const [who, kind, body, when] of o.log || []) db.run('INSERT INTO appointment_messages (appointment_id, sender_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)', id, who, kind, body, when);
      return id;
    };
    const first = appt(rahim, farhana, {
      reason: 'Chest tightness when climbing stairs and shortness of breath for 3 days. Previously treated for high blood pressure.',
      time: at(-5, '17:00'), status: 'completed', created: at(-6, '09:12'), updated: at(-5, '17:40'),
      notes: 'Suspected angina. Avoid heavy exertion until test results are reviewed. Follow up after reports.',
      log: [[rahim, 'event', 'Appointment requested by patient.', at(-6, '09:12')], [farhana, 'event', 'Doctor proposed a time.', at(-6, '10:05')],
        [rahim, 'event', 'Patient confirmed the appointment.', at(-6, '10:30')], [farhana, 'message', 'Please bring your previous prescriptions and any recent reports.', at(-6, '10:31')],
        [farhana, 'event', 'Consultation completed. Prescription and tests sent.', at(-5, '17:40')]],
    });
    appt(rahim, farhana, { reason: 'Follow-up after tests', time: at(1, '17:00'), status: 'confirmed', created: at(-5, '17:45'),
      log: [[farhana, 'event', 'Doctor proposed a follow-up time.', at(-5, '17:45')], [rahim, 'event', 'Patient confirmed the appointment.', at(-4, '08:00')]] });
    appt(rahim, imran, {
      reason: 'Second opinion on chest tightness', time: at(2, '11:00'), status: 'proposed', note: 'Please bring your previous prescriptions and recent reports.',
      created: at(0, '09:12'), updated: at(0, '10:05'),
      log: [[rahim, 'event', 'You sent a request to Dr. Imran Hossain.', at(0, '09:12')], [imran, 'event', 'Doctor proposed a time.', at(0, '10:05')]],
    });
    appt(sadia, farhana, { reason: 'Recurring migraine with palpitations', pref: 'Any weekday after 4 PM', status: 'requested', created: at(0, '08:40') });
    appt(kamal, farhana, { reason: 'Follow-up: ECG review', pref: 'Tuesday or Thursday', status: 'requested', created: at(-1, '18:20') });
    appt(extra[0], farhana, { reason: 'Chest tightness for 3 days', pref: 'Evenings', status: 'requested', created: at(0, '07:55') });
    appt(nasrin, farhana, { reason: 'Blood pressure check', time: at(0, '10:00'), status: 'completed', notes: 'BP stable on current dose.', created: at(-3) });
    appt(kamal, farhana, { reason: 'ECG report discussion', time: at(0, '14:00'), status: 'confirmed', created: at(-2) });
    appt(nasrin, farhana, { reason: 'Hypertension follow-up', time: at(3, '10:30'), status: 'proposed', created: at(-1) });
    // History for the consultations chart (last 6 months, rising).
    const histPatients = [sadia, kamal, nasrin, ...extra];
    let k = 0;
    for (let mo = 5; mo >= 0; mo--) {
      const n = [6, 8, 11, 10, 13, 15][5 - mo];
      for (let i = 0; i < n; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - mo, 2 + ((i * 3) % 25), 17, 0);
        if (d > now) continue;
        appt(histPatients[k++ % histPatients.length], farhana, { reason: 'Consultation', time: d.toISOString(), status: 'completed', created: d.toISOString() });
      }
    }
    for (let i = 0; i < 20; i++) appt(histPatients[i % histPatients.length], [imran, nusrat][i % 2], { reason: 'Consultation', time: at(-10 - i * 6), status: 'completed', created: at(-10 - i * 6) });

    // ---------- prescription from the first consultation ----------
    const rx = db.run(
      "INSERT INTO prescriptions (patient_id, doctor_id, appointment_id, source, diagnosis, notes, verified, created_at) VALUES (?, ?, ?, 'doctor', ?, 'Review after reports', 1, ?)",
      rahim, farhana, first, 'Suspected angina. Avoid heavy exertion until test results are reviewed. Follow up after reports.', at(-5, '17:35')).id;
    for (const [m, dose, freq, days, qty] of [['Paracetamol', '1 tablet', '3 times a day', 5, 10], ['Omeprazole', '1 capsule', 'Before breakfast', 14, 14], ['Cetirizine', '1 tablet', 'At night', 7, 7]]) {
      db.run('INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, frequency, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', rx, M[m], m, dose, freq, days, qty);
    }
    // A second cardiologist later adds blood thinners: the records now hold clopidogrel AND omeprazole,
    // which a drug-interaction rule says should not be combined without review (the chatbot abstains on this).
    const rx2 = db.run(
      "INSERT INTO prescriptions (patient_id, doctor_id, source, diagnosis, notes, verified, created_at) VALUES (?, ?, 'doctor', ?, 'Continue until review', 1, ?)",
      rahim, imran, 'Suspected angina: antiplatelet therapy started.', at(-2, '18:10')).id;
    for (const [m, dose, freq, days, qty] of [['Clopidogrel', '1 tablet', 'Once a day', 30, 30], ['Aspirin', '1 tablet', 'After lunch', 30, 30]]) {
      db.run('INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, frequency, duration_days, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', rx2, M[m], m, dose, freq, days, qty);
    }
    // ---------- Caregiver proxy (hackathon challenge 1) ----------
    // Tania has a Caregiver account and looks after her husband Rahim and her father Kamal, with their consent.
    const tania = user('caregiver', 'caregiver@mediconnect.local', 'Tania Rahman', '01712000099', { created: at(-30) });
    const link = (patientId, caregiverId, rel, canAct, sh, consent, viewed) => db.run(
      `INSERT INTO caregiver_links (patient_id, caregiver_id, relationship, can_act, share_reminders, share_vitals, share_reports, status, invited_by, consent_at, responded_at, last_viewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`, patientId, caregiverId, rel, canAct, sh[0], sh[1], sh[2], patientId, consent, consent, viewed, consent);
    link(rahim, tania, 'Spouse', 1, [1, 1, 1], at(-6, '21:00'), at(-1, '21:00'));
    link(kamal, tania, 'Daughter', 1, [1, 1, 1], at(-10, '19:00'), at(-2, '20:00'));
    // Sadia (Rahim's sister) may only view his reminders and vitals: a second caregiver with narrower consent.
    link(rahim, sadia, 'Sibling', 0, [1, 1, 0], at(-3, '20:00'), null);
    db.run('INSERT INTO care_notes (patient_id, author_id, body, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      rahim, tania, 'Reminded Rahim to take the evening Paracetamol after dinner. He said the headache is better.', at(-1, '21:40'),
      rahim, rahim, 'I will be at the office late today; please check my 2 PM dose.', at(0, '08:30'));
    for (const [action, pid, when] of [['caregiver.accepted', rahim, at(-6, '21:05')], ['caregiver.timeline_view', rahim, at(-1, '21:00')], ['caregiver.note', rahim, at(-1, '21:40')],
      ['caregiver.timeline_view', kamal, at(-2, '20:00')], ['caregiver.reading_logged', kamal, at(-2, '08:16')]]) {
      db.run("INSERT INTO audit_log (actor_id, actor_role, action, entity, patient_id, created_at) VALUES (?, 'caregiver', ?, 'patient', ?, ?)", tania, action, pid, when);
    }
    // Kamal (age 52): diabetes and blood pressure medicines, a high BP reading and a kidney test that conflicts with metformin.
    const kRx = db.run("INSERT INTO prescriptions (patient_id, doctor_id, source, diagnosis, verified, created_at) VALUES (?, ?, 'doctor', 'Type 2 diabetes, hypertension', 1, ?)", kamal, imran, at(-12)).id;
    db.run("INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, frequency, duration_days, quantity) VALUES (?, ?, 'Metformin', '1 tablet', 'Twice a day', 30, 60), (?, ?, 'Amlodipine', '1 tablet', 'Once a day', 30, 30)",
      kRx, M.Metformin, kRx, M.Amlodipine);
    [[150, 94, -6], [146, 92, -4], [152, 96, -2], [158, 98, 0]].forEach(([sy, di, d]) =>
      db.run("INSERT INTO health_readings (patient_id, kind, value1, value2, measured_at, recorded_by) VALUES (?, 'bp', ?, ?, ?, ?)", kamal, sy, di, at(d, '08:15'), d === -2 ? tania : null));
    db.run("INSERT INTO health_readings (patient_id, kind, value1, context, measured_at) VALUES (?, 'sugar', 8.4, 'fasting', ?)", kamal, at(-1, '07:30'));
    const kDoc = db.run("INSERT INTO health_documents (patient_id, title, doc_date, extracted_text, created_at) VALUES (?, 'Kidney function test', ?, 'Serum creatinine: 1.8 mg/dL', ?)", kamal, day(-3), at(-3, '12:00')).id;
    db.run("INSERT INTO health_markers (patient_id, document_id, marker, value, measured_on) VALUES (?, ?, 'creatinine', 1.8, ?)", kamal, kDoc, day(-3));
    const oldRx = db.run("INSERT INTO prescriptions (patient_id, doctor_id, source, diagnosis, verified, created_at) VALUES (?, ?, 'doctor', 'Seasonal allergy', 1, ?)", rahim, nusrat, at(-15)).id;
    db.run("INSERT INTO prescription_items (prescription_id, medicine_id, raw_name, dose, frequency, duration_days, quantity) VALUES (?, ?, 'Fexofenadine', '1 tablet', 'Once a day', 10, 10), (?, ?, 'Montelukast', '1 tablet', 'At night', 10, 10)", oldRx, M.Fexofenadine, oldRx, M.Montelukast);

    // ---------- tests and reports ----------
    const order = (p, d, a, t, o) => db.run(
      `INSERT INTO test_orders (patient_id, doctor_id, appointment_id, prescription_id, test_id, notes, status, center_id, preferred_date, scheduled_at, collected_at, price, paid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p, d, a, o.rx || null, T[t], o.notes || null, o.status, o.center || null, o.pref || null, o.sched || null, o.collected || null, o.price || null, o.paid || 0, o.created || at(-5, '17:36'), o.updated || at(-5, '17:36')).id;
    const ecg = order(rahim, farhana, first, 'ECG', { rx, status: 'completed', center: city.cid, sched: at(-3, '10:00'), collected: at(-3, '10:20'), price: 600, paid: 1, updated: at(-3, '17:05') });
    order(rahim, farhana, first, 'Lipid profile', { rx, status: 'scheduled', center: city.cid, sched: at(0, '11:15'), price: 900, notes: 'Fasting 10 to 12 hours', updated: at(-1) });
    order(rahim, farhana, first, 'Chest X-ray', { rx, status: 'prescribed' });
    order(sadia, nusrat, null, 'Chest X-ray', { status: 'scheduled', center: city.cid, sched: at(0, '15:00'), price: 700 });
    order(kamal, imran, null, 'ECG', { status: 'sample_collected', center: city.cid, sched: at(-1, '12:00'), collected: at(-1, '12:15'), price: 600 });
    for (const [p, t, d] of [[nasrin, 'Complete blood count', farhana], [extra[1], 'Thyroid profile', nusrat], [extra[2], 'HbA1c', nusrat], [extra[3], 'Lipid profile', farhana]]) {
      order(p, d, null, t, { status: 'requested', center: city.cid, pref: day(1), price: 900, created: at(0, '08:30'), updated: at(0, '08:30') });
    }
    // Completed tests this week (bar chart) with reports.
    const rep = (o, p, c, d, t, when, summary) => {
      const f = writeFile('reports', `${t.toLowerCase().replace(/\W+/g, '-')}.pdf`, [db.get('SELECT name FROM centers WHERE id = ?', c).name, `${t.toUpperCase()} REPORT (DEMO)`, '', `Patient: ${db.get('SELECT full_name FROM users WHERE id = ?', p).full_name}`, '', summary || 'Within normal limits.', '', 'Sample data generated by the demo seed.']);
      return db.run(
        `INSERT INTO reports (test_order_id, patient_id, center_id, doctor_id, test_id, test_date, technician, summary, file_path, original_name, mime_type, size, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Md. Rafiq Islam', ?, ?, ?, 'application/pdf', ?, ?, ?)`,
        o, p, c, d, T[t], when.slice(0, 10), summary || 'Within normal limits.', f.rel, `${t.toLowerCase().replace(/\W+/g, '-')}-report.pdf`, f.size, city.uid, when).id;
    };
    const ecgReport = rep(ecg, rahim, city.cid, farhana, 'ECG', at(-3, '17:05'), 'Normal sinus rhythm. See attached report for details.');
    const sugarOrder = order(rahim, nusrat, null, 'Blood sugar (fasting)', { status: 'completed', center: city.cid, price: 200, paid: 1, created: at(-75), updated: at(-75) });
    rep(sugarOrder, rahim, city.cid, nusrat, 'Blood sugar (fasting)', at(-75, '12:00'), 'Fasting glucose 6.1 mmol/L.');
    for (let dd = 6; dd >= 0; dd--) {
      const n = [3, 5, 4, 7, 6, 8, 2][6 - dd];
      for (let i = 0; i < n; i++) {
        const p = histPatients[(dd * 3 + i) % histPatients.length];
        const t = ['Complete blood count', 'Lipid profile', 'ECG', 'Urine routine', 'Blood sugar (fasting)'][i % 5];
        const when = at(-dd, `${String(10 + (i % 8)).padStart(2, '0')}:30`);
        if (new Date(when) > now) continue;
        const o = order(p, nusrat, null, t, { status: 'completed', center: city.cid, price: 450, paid: i % 3 ? 1 : 0, created: when, updated: when });
        rep(o, p, city.cid, nusrat, t, when);
      }
    }

    // ---------- record access ----------
    db.run("INSERT INTO access_grants (doctor_id, patient_id, report_id, source, expires_at, created_at) VALUES (?, ?, ?, 'share', ?, ?)", farhana, rahim, ecgReport, at(6, '17:00'), at(-1, '17:00'));
    db.run("INSERT INTO access_requests (doctor_id, patient_id, report_id, reason, duration_hours, created_at) VALUES (?, ?, ?, 'To review your ECG before our consultation on Wednesday', 168, ?)", imran, rahim, ecgReport, at(0, '08:10'));
    db.run("INSERT INTO access_requests (doctor_id, patient_id, report_id, reason, duration_hours, created_at) VALUES (?, ?, NULL, 'Review previous ECG before follow-up', 72, ?)", farhana, kamal, at(-1));
    const log = (actor, role, action, entity, id, p, when) => db.run('INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, patient_id, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', actor, role, action, entity, id, p, '127.0.0.1', when);
    log(city.uid, 'center', 'report.uploaded', 'report', ecgReport, rahim, at(-3, '17:05'));
    log(rahim, 'patient', 'report.shared', 'report', ecgReport, rahim, at(-1, '17:00'));
    log(farhana, 'doctor', 'report.view', 'report', ecgReport, rahim, at(-1, '10:20'));
    log(imran, 'doctor', 'access.requested', 'access_request', 1, rahim, at(0, '08:10'));

    // ---------- medicine orders ----------
    db.run("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('orders', 1300)");
    const mkOrder = (p, ph, rxId, status, items, o = {}) => {
      const sub = items.reduce((s, [m, q, pr, f]) => s + (f ?? q) * pr, 0);
      const fee = o.fee ?? 30;
      const id = db.run(
        `INSERT INTO orders (patient_id, pharmacy_id, prescription_id, status, payment_method, payment_status, delivery_address, accepted, partial, prescription_checked, rider_name, rider_phone, out_at, delivery_fee, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        p, ph, rxId, status, o.method || 'cod', o.paid ? 'paid' : 'unpaid', o.addr || 'Dhanmondi, Dhaka', status === 'received' ? 0 : 1, o.partial ? 1 : 0,
        o.rider || null, o.rider ? '01712 998877' : null, o.out || null, fee, sub + fee, o.created || at(-1), o.created || at(-1)).id;
      for (const [m, q, pr, f] of items) db.run('INSERT INTO order_items (order_id, medicine_id, quantity, fulfilled_quantity, unit_price) VALUES (?, ?, ?, ?, ?)', id, M[m], q, status === 'received' ? null : f ?? q, pr);
      for (const [s, when, note] of o.history || [['received', o.created || at(-1), 'Order placed by patient']]) db.run('INSERT INTO order_status_history (order_id, status, note, created_at) VALUES (?, ?, ?, ?)', id, s, note || null, when);
      return id;
    };
    const t0 = new Date(Date.now() - 32 * 60000);
    const mins = (n) => new Date(t0.getTime() + n * 60000).toISOString();
    mkOrder(rahim, green.pid, rx, 'out_for_delivery', [['Paracetamol', 10, 4], ['Omeprazole', 14, 6], ['Cetirizine', 7, 4]], {
      created: mins(0), addr: 'House 12, Road 5, Dhanmondi, Dhaka', rider: 'Md. Kabir', out: mins(32),
      history: [['received', mins(0), 'Order placed by patient'], ['preparing', mins(8), 'Accepted'], ['ready', mins(25)], ['out_for_delivery', mins(32), 'Rider: Md. Kabir']],
    });
    const del1 = mkOrder(rahim, green.pid, oldRx, 'delivered', [['Fexofenadine', 10, 9], ['Paracetamol', 2, 3]], { created: at(-15), paid: 1, history: [['received', at(-15)], ['delivered', at(-15, '13:00')]] });
    const del2 = mkOrder(rahim, care.pid, oldRx, 'delivered', [['Montelukast', 10, 17]], { created: at(-29), paid: 1, fee: 40, history: [['received', at(-29)], ['delivered', at(-29, '14:00')]] });
    mkOrder(rahim, plus.pid, oldRx, 'delivered', [['Fexofenadine', 10, 8.5, 0], ['Paracetamol', 3, 3.5]], { created: at(-43), paid: 1, partial: true, history: [['received', at(-43)], ['delivered', at(-43, '15:00')]] });
    mkOrder(kamal, green.pid, null, 'received', [['Amlodipine', 30, 5], ['Atorvastatin', 30, 10], ['Losartan', 30, 8], ['Cetirizine', 10, 4]], { created: at(0, '09:00') });
    mkOrder(nasrin, green.pid, null, 'received', [['Losartan', 30, 8], ['Amlodipine', 30, 5], ['Paracetamol', 10, 4]], { created: new Date(Date.now() - 12 * 60000).toISOString() });
    mkOrder(sadia, green.pid, null, 'preparing', [['Montelukast', 10, 16], ['Fexofenadine', 10, 9]], { method: 'online', paid: true, created: at(0, '08:15') });
    // Older orders for charts and reviews.
    const reviewers = [];
    for (let i = 0; i < 34; i++) {
      const mo = 5 - Math.floor(i / 6.5);
      const d = new Date(now.getFullYear(), now.getMonth() - Math.max(0, mo), 3 + (i * 5) % 24, 11, 0);
      if (d > now) continue;
      const p = histPatients[i % histPatients.length];
      const ph = [green.pid, green.pid, plus.pid, care.pid][i % 4];
      const id = mkOrder(p, ph, null, 'delivered', [['Paracetamol', 10, 4], ['Omeprazole', 10, 6]], { created: d.toISOString(), paid: 1, history: [['received', d.toISOString()], ['delivered', d.toISOString()]] });
      if (i % 3 === 0) reviewers.push([id, p, ph]);
    }
    const comments = ['Fast delivery and the medicines were well packed.', 'Good prices, but one item was out of stock.', 'Rider called before arriving. Very helpful.', 'Took longer than the estimate.', 'Pharmacist checked my prescription carefully.', 'Always has what I need.'];
    reviewers.forEach(([id, p, ph], i) => {
      const r = [5, 4, 5, 3, 5, 4][i % 6], s = [4, 4, 5, 3, 5, 5][i % 6];
      db.run('INSERT INTO pharmacy_reviews (order_id, pharmacy_id, patient_id, availability, price, delivery, service, overall, comment, reply, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, ph, p, r, s, [5, 4, 5, 2, 4, 5][i % 6], 5, (r + s + [5, 4, 5, 2, 4, 5][i % 6] + 5) / 4, comments[i % 6], i === 3 ? 'Sorry for the delay. We have added a second rider for evening orders.' : null, at(-i * 9));
    });
    db.run("INSERT INTO pharmacy_reviews (order_id, pharmacy_id, patient_id, availability, price, delivery, service, overall, comment, created_at) VALUES (?, ?, ?, 5, 4, 5, 5, 4.75, 'Quick delivery, rider was polite.', ?)", del1, green.pid, rahim, at(-14));
    db.run("INSERT INTO pharmacy_reviews (order_id, pharmacy_id, patient_id, availability, price, delivery, service, overall, comment, created_at) VALUES (?, ?, ?, 4, 3, 4, 4, 3.75, 'Good service but a bit pricey.', ?)", del2, care.pid, rahim, at(-28));

    // ---------- notifications ----------
    const note = (u, kind, title, body, link, when, read = 0) => db.run('INSERT INTO notifications (user_id, kind, title, body, link, created_at, is_read) VALUES (?, ?, ?, ?, ?, ?, ?)', u, kind, title, body, link, when, read);
    note(rahim, 'test', 'New test prescribed', 'Lipid profile added to Medical Tests.', '/patient/tests', at(-5, '17:36'), 1);
    note(rahim, 'order', 'Order out for delivery', 'Green Cross Pharmacy order is on the way.', '/patient/orders', at(-1, '18:00'), 1);
    note(rahim, 'access', 'Access request', 'Dr. Imran Hossain wants to view your ECG.', '/patient/access', new Date(Date.now() - 2 * 3600000).toISOString());
    note(rahim, 'appointment', 'New time proposed', `Dr. Imran Hossain proposed ${new Date(at(2, '11:00')).toLocaleDateString('en-US', { weekday: 'short' })}, 11:00 AM.`, '/patient/appointments', new Date(Date.now() - 3600000).toISOString());
    note(rahim, 'report', 'ECG report uploaded', 'City Diagnostic Center added your report.', '/patient/records', new Date(Date.now() - 10 * 60000).toISOString());
    note(farhana, 'appointment', 'New appointment request', 'Sadia Akter requested an appointment.', '/doctor/requests', at(0, '08:40'));
    note(green.uid, 'order', 'New medicine order', 'Nasrin Sultana placed an order.', '/pharmacy/orders', new Date(Date.now() - 12 * 60000).toISOString());
    note(city.uid, 'test', 'New test request', 'Nasrin Sultana requested Complete blood count.', '/center/requests', at(0, '08:30'));

    // ---------- health readings (last 14 days) ----------
    for (let i = 13; i >= 0; i--) {
      const when = at(-i, '08:00');
      const sys = Math.round(148 - (13 - i) * 0.9 + ((i * 7) % 5) - 2);
      const dia = Math.round(95 - (13 - i) * 0.5 + ((i * 3) % 4) - 1);
      db.run("INSERT INTO health_readings (patient_id, kind, value1, value2, measured_at) VALUES (?, 'bp', ?, ?, ?)", rahim, sys, dia, when);
      if (i % 2 === 0) db.run("INSERT INTO health_readings (patient_id, kind, value1, context, measured_at) VALUES (?, 'sugar', ?, 'fasting', ?)", rahim, 5.6 + ((i * 5) % 7) / 10, when);
      if (i % 3 === 0) db.run("INSERT INTO health_readings (patient_id, kind, value1, measured_at) VALUES (?, 'pulse', ?, ?)", rahim, 78 + (i % 6), when);
      if (i % 4 === 0) db.run("INSERT INTO health_readings (patient_id, kind, value1, measured_at) VALUES (?, 'weight', ?, ?)", rahim, 79 - (13 - i) * 0.1, when);
      if (i % 4 === 1) db.run("INSERT INTO health_readings (patient_id, kind, value1, measured_at) VALUES (?, 'spo2', ?, ?)", rahim, 97 + (i % 2), when);
    }

    // ---------- blood bank ----------
    db.run("INSERT INTO blood_donors (user_id, blood_group, lat, lng, area, last_donation, donations) VALUES (?, 'B+', 23.7465, 90.376, 'Dhanmondi', ?, 3)", rahim, day(-130));
    extra.forEach((id, i) => db.run('INSERT INTO blood_donors (user_id, blood_group, lat, lng, area, last_donation, available, donations) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, groups[i], 23.73 + (i % 6) * 0.012, 90.36 + (i % 5) * 0.013, ['Dhanmondi', 'Kalabagan', 'Mohammadpur', 'Green Road', 'Farmgate', 'Panthapath'][i % 6], i % 4 === 0 ? day(-30) : day(-150 - i * 10), i % 7 === 6 ? 0 : 1, i % 5));
    const breq = db.run(
      "INSERT INTO blood_requests (requester_id, patient_name, blood_group, units, hospital, lat, lng, needed_by, urgency, contact_phone, note, created_at) VALUES (?, 'Sadia Akter (mother)', 'O+', 2, 'Dhaka Medical College Hospital', 23.7258, 90.3976, ?, 'urgent', '01712000002', 'Surgery tomorrow morning', ?)",
      sadia, day(1), at(0, '07:30')).id;
    extra.forEach((id, i) => { if (['O+', 'O-'].includes(groups[i]) && i % 4 !== 0) db.run('INSERT INTO blood_responses (request_id, donor_id, status, distance, responded_at) VALUES (?, ?, ?, ?, ?)', breq, id, i === 1 ? 'accepted' : 'notified', 2 + i * 0.4, i === 1 ? at(0, '08:05') : null); });
    db.run('UPDATE blood_donors SET phone = (SELECT phone FROM users WHERE users.id = blood_donors.user_id), show_phone = 1');
    for (const d of db.all('SELECT user_id, last_donation FROM blood_donors WHERE last_donation IS NOT NULL')) db.run("INSERT INTO blood_donations (donor_id, donated_on, place) VALUES (?, ?, 'Sandhani, DMC')", d.user_id, d.last_donation);
    db.run("INSERT INTO blood_donations (donor_id, donated_on, place) VALUES (?, ?, 'Quantum Blood Lab'), (?, ?, 'Red Crescent Blood Centre')", rahim, day(-260), rahim, day(-400));

    // ---------- doctor chat ----------
    const thread = db.run("INSERT INTO chat_threads (patient_id, doctor_id, topic, status, created_at, updated_at) VALUES (?, ?, 'Question about my ECG report', 'accepted', ?, ?)", rahim, farhana, at(-2, '19:00'), at(-1, '20:10')).id;
    for (const [who, body, when] of [[rahim, 'Assalamu alaikum doctor. My ECG report is uploaded. Should I continue the same medicines until the follow-up?', at(-2, '19:00')],
      [farhana, 'Walaikum assalam. Yes, continue as prescribed. Avoid heavy exertion and bring the lipid profile report on your follow-up.', at(-2, '19:25')],
      [rahim, 'Thank you. I will do the lipid test tomorrow morning.', at(-1, '20:10')]]) db.run('INSERT INTO chat_posts (thread_id, sender_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?)', thread, who, body, when, when);
    db.run("INSERT INTO chat_threads (patient_id, doctor_id, topic, status, created_at, updated_at) VALUES (?, ?, 'Palpitations at night, can I ask a quick question?', 'pending', ?, ?)", sadia, farhana, at(0, '09:20'), at(0, '09:20'));

    // ---------- health documents for the analysis (Rahim, last 6 months) ----------
    const series = [
      { hemoglobin: 12.6, glucose: 6.8, hba1c: 6.3, cholesterol: 242, ldl: 162, hdl: 37, triglycerides: 196, creatinine: 1.0 },
      { hemoglobin: 12.9, glucose: 6.6, hba1c: 6.2, cholesterol: 236, ldl: 158, hdl: 38, triglycerides: 188 },
      { hemoglobin: 13.1, glucose: 6.5, hba1c: 6.1, cholesterol: 228, ldl: 150, hdl: 39, triglycerides: 180, creatinine: 1.1 },
      { hemoglobin: 13.2, glucose: 6.3, hba1c: 6.0, cholesterol: 219, ldl: 144, hdl: 40, triglycerides: 172 },
      { hemoglobin: 13.4, glucose: 6.2, hba1c: 5.9, cholesterol: 211, ldl: 139, hdl: 41, triglycerides: 166, creatinine: 1.0 },
      { hemoglobin: 13.6, glucose: 6.0, hba1c: 5.8, cholesterol: 204, ldl: 132, hdl: 42, triglycerides: 158 },
    ];
    const NAMES = { hemoglobin: 'Hemoglobin', glucose: 'Fasting blood sugar', hba1c: 'HbA1c', cholesterol: 'Total cholesterol', ldl: 'LDL', hdl: 'HDL', triglycerides: 'Triglycerides', creatinine: 'Serum creatinine' };
    const UNITS = { hemoglobin: 'g/dL', glucose: 'mmol/L', hba1c: '%', cholesterol: 'mg/dL', ldl: 'mg/dL', hdl: 'mg/dL', triglycerides: 'mg/dL', creatinine: 'mg/dL' };
    series.forEach((vals, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), Math.min(12 + i, 27), 10, 0);
      if (d > now) d.setDate(Math.max(1, now.getDate() - 1));
      const date = dateStr(d);
      const title = i % 2 ? 'Lipid & diabetes check-up' : 'Routine blood test';
      const f = writeFile('health-docs', `checkup-${date}.pdf`, ['City Diagnostic Center', `${title.toUpperCase()} (DEMO)`, `Date: ${date}`, 'Patient: Rahim Uddin', '',
        ...Object.entries(vals).map(([k, v]) => `${NAMES[k]}: ${v} ${UNITS[k]}`)]);
      const docId = db.run('INSERT INTO health_documents (patient_id, title, doc_date, file_path, original_name, mime_type, size, extracted_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        rahim, title, date, f.rel, `checkup-${date}.pdf`, 'application/pdf', f.size, Object.entries(vals).map(([k, v]) => `${NAMES[k]}: ${v}`).join('\n'), d.toISOString()).id;
      for (const [k, v] of Object.entries(vals)) db.run('INSERT INTO health_markers (patient_id, document_id, marker, value, measured_on) VALUES (?, ?, ?, ?, ?)', rahim, docId, k, v, date);
    });

    // ---------- notifications for the new features ----------
    note(farhana, 'chat', 'New chat request', 'Sadia Akter wants to message you.', '/messages?list=1', at(0, '09:20'));
  });

  // Reminders from the latest prescription, with a few days of history.
  const reminders = require('./services/reminders');
  const rahimId = db.get("SELECT id FROM users WHERE email = 'patient@mediconnect.local'").id;
  // Reminders from the two latest doctor prescriptions (Dr. Farhana's and Dr. Imran's).
  for (const p of db.all("SELECT id FROM prescriptions WHERE patient_id = ? AND source = 'doctor' ORDER BY created_at DESC LIMIT 2", rahimId)) reminders.createFromPrescription(rahimId, p.id);
  const now2 = new Date();
  const start = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate() - 4);
  db.run('UPDATE reminders SET start_date = ? WHERE patient_id = ?', dateStr(start), rahimId);
  for (const r of db.all('SELECT * FROM reminders WHERE patient_id = ?', rahimId)) {
    for (let d = 4; d >= 1; d--) {
      for (const t of r.times.split(',')) {
        const due = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate() - d, ...t.split(':').map(Number)).toISOString();
        const status = (d + t.length + r.id) % 7 === 0 ? 'skipped' : 'taken';
        db.run('INSERT OR IGNORE INTO dose_logs (reminder_id, due_at, status, notified, acted_at) VALUES (?, ?, ?, 1, ?)', r.id, due, status, due);
      }
    }
    db.run('UPDATE reminders SET pills_left = MAX(4, pills_left - 6) WHERE id = ?', r.id);
  }
  // Kamal's reminders (for the caregiver demo).
  const kamalId = db.get("SELECT id FROM users WHERE email = 'kamal@mediconnect.local'").id;
  for (const p of db.all("SELECT id FROM prescriptions WHERE patient_id = ? AND source = 'doctor'", kamalId)) reminders.createFromPrescription(kamalId, p.id);
  // Past doses today count as taken, so the demo starts tidy.
  db.run(`UPDATE dose_logs SET status = 'taken', notified = 1, acted_at = due_at WHERE status = 'due' AND due_at < ?`, new Date(Date.now() - 3600000).toISOString());
  // ...except one of Kamal's doses today, which he missed: his caregiver's dashboard shows it in red.
  const missed = db.get(`SELECT d.id FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id WHERE r.patient_id = ? AND d.due_at < ? AND d.due_at >= ? ORDER BY d.due_at LIMIT 1`,
    kamalId, new Date(Date.now() - 3600000).toISOString(), new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
  if (missed) db.run("UPDATE dose_logs SET status = 'due', acted_at = NULL WHERE id = ?", missed.id);
  else {
    const y = db.get(`SELECT d.id FROM dose_logs d JOIN reminders r ON r.id = d.reminder_id WHERE r.patient_id = ? AND d.due_at < ? ORDER BY d.due_at DESC LIMIT 1`, kamalId, new Date().toISOString());
    if (y) db.run("UPDATE dose_logs SET status = 'skipped' WHERE id = ?", y.id);
  }

  console.log(`Demo data ready. All demo accounts use the password: ${PASSWORD}`);
}

module.exports = { seed, minimalPdf };

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
    for (const d of ['reports', 'prescriptions', 'documents', 'health-docs']) fs.rmSync(path.join(config.uploadDir, d), { recursive: true, force: true });
    console.log('Database and uploads wiped.');
  }
  const db = require('./db');
  if (db.get('SELECT COUNT(*) AS n FROM users').n) console.log('Database already has data. Use `npm run reset` to wipe and re-seed.');
  else seed();
}
