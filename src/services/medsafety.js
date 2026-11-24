// Personal medicine safety for the Health AI chatbot.
// Before the chatbot suggests any medicine, it reads the patient's own records:
//   allergies and long-term conditions (profile), diagnoses on recent prescriptions, medicines they take now
//   (prescriptions + reminders) and their latest lab results.
// Each over-the-counter option for the complaint is then checked against fixed rules:
//   allergy (incl. drug-family cross-reactions), condition, lab value, interaction with current medicines,
//   and "you already take this" (to stop double dosing).
// The chatbot only suggests options that pass, lists the ones to avoid with the reason from the patient's records,
// and never suggests prescription-only medicines (antibiotics etc.); those always go to a doctor.
const db = require('../db');
const { adviceFor, allAdviceFor } = require('./firstaid');
const health = require('./health');
const ix = require('./interactions');

const NSAIDS = ['ibuprofen', 'aspirin', 'diclofenac', 'naproxen', 'mefenamic'];
const NAME = (g) => (OTC[g] ? OTC[g].name : g.charAt(0).toUpperCase() + g.slice(1));

// Over-the-counter options the chatbot may suggest. bn = Bangla label.
const OTC = {
  paracetamol: { name: 'Paracetamol (e.g. Napa 500 mg)', bn: 'প্যারাসিটামল (যেমন নাপা ৫০০ মি.গ্রা.)', how: 'as per the pack; adults no more than 8 × 500 mg tablets in 24 hours', howBn: 'প্যাকেটের নিয়মে; প্রাপ্তবয়স্কদের ২৪ ঘণ্টায় ৮টির (৫০০ মি.গ্রা.) বেশি নয়' },
  ibuprofen: { name: 'Ibuprofen (e.g. 400 mg)', bn: 'আইবুপ্রোফেন (৪০০ মি.গ্রা.)', how: 'after food, as per the pack', howBn: 'খাবারের পরে, প্যাকেটের নিয়মে' },
  diclofenac_gel: { name: 'Diclofenac gel (on the skin)', bn: 'ডাইক্লোফেনাক জেল (চামড়ায় লাগানোর)', how: 'rub gently on the sore area 3 times a day', howBn: 'ব্যথার জায়গায় দিনে ৩ বার হালকা করে লাগান', family: 'diclofenac' },
  mefenamic: { name: 'Mefenamic acid', bn: 'মেফেনামিক অ্যাসিড', how: 'after food, as per the pack', howBn: 'খাবারের পরে, প্যাকেটের নিয়মে' },
  cetirizine: { name: 'Cetirizine (e.g. Alatrol 10 mg)', bn: 'সেটিরিজিন (যেমন অ্যালাট্রল ১০ মি.গ্রা.)', how: 'once at night; can make you sleepy', howBn: 'রাতে একবার; ঘুম ঘুম লাগতে পারে' },
  fexofenadine: { name: 'Fexofenadine (e.g. Fexo 120 mg)', bn: 'ফেক্সোফেনাডিন (যেমন ফেক্সো ১২০ মি.গ্রা.)', how: 'once a day; less sleepy than cetirizine', howBn: 'দিনে একবার; সেটিরিজিনের চেয়ে কম ঘুম পায়' },
  loratadine: { name: 'Loratadine (10 mg)', bn: 'লোরাটাডিন (১০ মি.গ্রা.)', how: 'once a day', howBn: 'দিনে একবার' },
  antacid: { name: 'Antacid suspension/tablet', bn: 'অ্যান্টাসিড', how: 'after meals and at bedtime, as per the pack', howBn: 'খাবারের পরে ও ঘুমানোর আগে, প্যাকেটের নিয়মে' },
  omeprazole: { name: 'Omeprazole (e.g. Seclo 20 mg)', bn: 'ওমিপ্রাজল (যেমন সেকলো ২০ মি.গ্রা.)', how: 'once before breakfast for up to 14 days', howBn: 'নাশতার আগে দিনে একবার, সর্বোচ্চ ১৪ দিন' },
  esomeprazole: { name: 'Esomeprazole (e.g. Sergel 20 mg)', bn: 'ইসোমিপ্রাজল (যেমন সারজেল ২০ মি.গ্রা.)', how: 'once before breakfast for up to 14 days', howBn: 'নাশতার আগে দিনে একবার, সর্বোচ্চ ১৪ দিন' },
  ors: { name: 'ORS (oral saline)', bn: 'ওরস্যালাইন', how: 'one sachet in 500 ml clean water; sip after every loose stool', howBn: '৫০০ মিলি পানিতে এক প্যাকেট; প্রতিবার পাতলা পায়খানার পর পান করুন' },
  zinc: { name: 'Zinc tablet/syrup', bn: 'জিংক', how: 'once a day for 10 days with diarrhoea', howBn: 'ডায়রিয়ায় ১০ দিন দিনে একবার' },
  saline_drops: { name: 'Saline nose drops', bn: 'স্যালাইন নাকের ড্রপ', how: '2 drops in each nostril, 3–4 times a day', howBn: 'প্রতি নাকে ২ ফোঁটা, দিনে ৩–৪ বার' },
  honey: { name: 'Warm water with honey and lemon', bn: 'কুসুম গরম পানিতে মধু ও লেবু', how: 'for cough and sore throat (not for babies under 1 year)', howBn: 'কাশি ও গলাব্যথায় (১ বছরের কম শিশুকে নয়)' },
};
// Which options fit which complaint (index = first keyword of a first-aid topic).
const FOR_TOPIC = {
  headache: ['paracetamol', 'ibuprofen'], fever: ['paracetamol', 'ibuprofen'], cold: ['paracetamol', 'cetirizine', 'saline_drops', 'honey'],
  'stomach pain': ['antacid', 'omeprazole', 'esomeprazole'], diarrhea: ['ors', 'zinc'], burn: ['paracetamol'], cut: ['paracetamol'],
  sprain: ['paracetamol', 'diclofenac_gel', 'ibuprofen'], toothache: ['paracetamol', 'ibuprofen'], rash: ['cetirizine', 'fexofenadine', 'loratadine'],
  'back pain': ['paracetamol', 'diclofenac_gel', 'ibuprofen'], 'period pain': ['paracetamol', 'mefenamic', 'ibuprofen'], 'heat stroke': ['ors'],
};
const RX_ONLY = ['amoxicillin', 'azithromycin', 'cefixime', 'ciprofloxacin', 'clopidogrel', 'warfarin', 'metformin', 'losartan', 'amlodipine', 'simvastatin', 'levothyroxine', 'tramadol', 'sertraline', 'fluoxetine', 'sildenafil', 'spironolactone', 'montelukast'];

// Condition words (profile + diagnoses) -> drugs to avoid.
const CONDITION_RULES = [
  [/ulcer|peptic|gi bleed|stomach bleed|আলসার/i, NSAIDS, 'stomach ulcer history: NSAID painkillers can cause bleeding', 'পেপটিক আলসারের ইতিহাস: NSAID ব্যথানাশক রক্তক্ষরণ ঘটাতে পারে'],
  [/kidney|renal|ckd|nephr|কিডনি/i, [...NSAIDS, 'antacid'], 'kidney problem: NSAIDs and magnesium antacids can harm the kidneys', 'কিডনির সমস্যা: NSAID ও ম্যাগনেসিয়ামযুক্ত অ্যান্টাসিড কিডনির ক্ষতি করতে পারে'],
  [/angina|heart attack|heart disease|cardiac|coronary|heart failure|stroke|হৃদ/i, ['ibuprofen', 'diclofenac', 'naproxen', 'mefenamic'], 'heart condition: NSAID painkillers raise heart-attack and stroke risk', 'হৃদ্‌রোগ: NSAID ব্যথানাশক হার্ট অ্যাটাক ও স্ট্রোকের ঝুঁকি বাড়ায়'],
  [/asthma|হাঁপানি/i, NSAIDS, 'asthma: NSAIDs can trigger an attack in some people', 'হাঁপানি: কারও কারও ক্ষেত্রে NSAID হাঁপানির টান বাড়াতে পারে'],
  [/pregnan|গর্ভ/i, NSAIDS, 'pregnancy: NSAIDs are not safe, especially later in pregnancy', 'গর্ভাবস্থা: NSAID নিরাপদ নয়, বিশেষ করে শেষের মাসগুলোতে'],
  [/dengue|ডেঙ্গু/i, NSAIDS, 'possible dengue: NSAIDs raise the bleeding risk', 'ডেঙ্গুর সম্ভাবনা: NSAID রক্তক্ষরণের ঝুঁকি বাড়ায়'],
  [/liver|hepat|cirrhosis|লিভার/i, ['paracetamol'], 'liver disease: paracetamol needs a lower, doctor-set dose', 'লিভারের রোগ: প্যারাসিটামলের ডোজ ডাক্তার ঠিক করে দেবেন'],
];
const LAB_SAFETY = [
  ['creatinine', 1.3, NSAIDS, (v) => `your latest serum creatinine is high (${v} mg/dL), so NSAIDs could harm your kidneys`, (v) => `আপনার সর্বশেষ ক্রিয়েটিনিন বেশি (${v} mg/dL), তাই NSAID কিডনির ক্ষতি করতে পারে`],
  ['creatinine', 1.5, ['antacid'], (v) => `your latest serum creatinine is high (${v} mg/dL); avoid magnesium antacids`, (v) => `আপনার সর্বশেষ ক্রিয়েটিনিন বেশি (${v} mg/dL); ম্যাগনেসিয়ামযুক্ত অ্যান্টাসিড এড়িয়ে চলুন`],
  ['alt', 120, ['paracetamol'], (v) => `your liver enzyme (ALT ${v} U/L) is high; ask a doctor for a safe paracetamol dose`, (v) => `আপনার লিভার এনজাইম (ALT ${v} U/L) বেশি; প্যারাসিটামলের নিরাপদ ডোজ ডাক্তারের কাছে জেনে নিন`],
];
const R = (en, bn) => ({ en, bn: bn || en, toString() { return en; } });
const familyOf = (key) => (OTC[key] && OTC[key].family) || key;

// ---------- Sources shown under every answer ----------
const NHS = 'https://www.nhs.uk';
const TOPIC_SOURCES = {
  headache: ['Headaches: when to get help (UHSussex NHS)', 'https://www.uhsussex.nhs.uk/resources/headaches-emergency-department-leaflet/'],
  fever: ['Flu and high temperature (NHS)', `${NHS}/conditions/flu/`],
  cold: ['Flu, cold and sore throat (NHS)', `${NHS}/conditions/flu/`],
  'stomach pain': ['Stomach ache (NHS)', `${NHS}/symptoms/stomach-ache/`],
  diarrhea: ['Diarrhoea and vomiting bug (NHS)', `${NHS}/conditions/norovirus/`],
  sprain: ['Sprains and strains (NHS)', `${NHS}/conditions/sprains-and-strains/`],
  'back pain': ['Back pain (NHS)', `${NHS}/conditions/back-pain/`],
  burn: ['Burns and scalds (NHS)', `${NHS}/conditions/burns-and-scalds/`],
  cut: ['Cuts and grazes (NHS)', `${NHS}/conditions/cuts-and-grazes/`],
  toothache: ['Toothache (NHS)', `${NHS}/conditions/toothache/`],
  rash: ['Hives and itchy rash (NHS)', `${NHS}/conditions/hives/`],
  'period pain': ['Period pain (NHS)', `${NHS}/conditions/period-pain/`],
  'heat stroke': ['Heat exhaustion and heatstroke (NHS)', `${NHS}/conditions/heat-exhaustion-heatstroke/`],
};
const DRUG_SOURCES = {
  paracetamol: ['Paracetamol for adults (NHS)', `${NHS}/medicines/paracetamol-for-adults/`],
  ibuprofen: ['Ibuprofen for adults: who should not take it (NHS)', `${NHS}/medicines/ibuprofen-for-adults/`],
  diclofenac_gel: ['Sprains and strains: painkiller gels (NHS)', `${NHS}/conditions/sprains-and-strains/`],
  cetirizine: ['Cetirizine (NHS)', `${NHS}/medicines/cetirizine/`],
  fexofenadine: ['Fexofenadine (NHS)', `${NHS}/medicines/fexofenadine/`],
  loratadine: ['Loratadine (NHS)', `${NHS}/medicines/loratadine/`],
  omeprazole: ['Omeprazole (NHS)', `${NHS}/medicines/omeprazole/`],
  esomeprazole: ['Esomeprazole (NHS)', `${NHS}/medicines/esomeprazole/`],
  mefenamic: ['Mefenamic acid (NHS)', `${NHS}/medicines/mefenamic-acid/`],
  ors: ['Fluids and ORS for diarrhoea (NHS)', `${NHS}/conditions/norovirus/`],
  zinc: ['Diarrhoea and vomiting bug (NHS)', `${NHS}/conditions/norovirus/`],
};
const RULE_SOURCES = {
  nsaid: ['Painkiller cautions: ulcers, aspirin allergy, asthma (Oxford University Hospitals NHS)', 'https://www.ouh.nhs.uk/media/opzaru5g/86580prelief.pdf'],
  clopidogrel: ['Clopidogrel with omeprazole/esomeprazole (NHS Specialist Pharmacy Service)', 'https://sps.nhs.uk/articles/using-clopidogrel-with-proton-pump-inhibitors-ppis/'],
};

// ---------- Vitals history (recent readings) ----------
function vitalsRules(patientId) {
  const o = health.overview(patientId);
  const out = { notes: [], blocks: [], urgent: [] };
  const bp = o.kinds.bp; const sugar = o.kinds.sugar; const spo2 = o.kinds.spo2; const pulse = o.kinds.pulse;
  const label = (k) => `${k.name} ${health.fmt(k.last)} ${k.unit}`;
  for (const k of [bp, sugar, spo2, pulse]) if (k && k.last && k.status && k.status.level === 'urgent') out.urgent.push(R(`${label(k)}: ${k.status.note}`, `${label(k)}: বিপজ্জনক মাত্রা`));
  if (bp && bp.last && bp.status && ['doctor', 'urgent'].includes(bp.status.level)) {
    out.blocks.push([NSAIDS, R(`your recent blood pressure is high (${health.fmt(bp.last)} mmHg); NSAID painkillers can raise it further`, `আপনার সাম্প্রতিক রক্তচাপ বেশি (${health.fmt(bp.last)} mmHg); NSAID ব্যথানাশক তা আরও বাড়াতে পারে`)]);
    out.notes.push(R(`Recent blood pressure ${health.fmt(bp.last)} mmHg is high`, `সাম্প্রতিক রক্তচাপ ${health.fmt(bp.last)} mmHg, বেশি`));
  }
  if (sugar && sugar.last && sugar.status && ['doctor', 'urgent'].includes(sugar.status.level)) {
    out.blocks.push([['honey'], R(`your recent blood sugar is high (${health.fmt(sugar.last)} mmol/L); skip honey drinks`, `আপনার সাম্প্রতিক সুগার বেশি (${health.fmt(sugar.last)} mmol/L); মধুর পানীয় বাদ দিন`)]);
    out.notes.push(R(`Recent blood sugar ${health.fmt(sugar.last)} mmol/L is high`, `সাম্প্রতিক সুগার ${health.fmt(sugar.last)} mmol/L, বেশি`));
  }
  return out;
}

// ---------- When a doctor must decide (no self-treatment) ----------
const CRITICAL = [
  [/worst headache|sudden severe|thunderclap|stiff neck|confus|faint|vision loss|blurred vision|সবচেয়ে তীব্র|ঘাড় শক্ত|ঝাপসা/i, 'severe or unusual warning signs'],
  [/blood in (my )?(stool|poo|vomit|urine)|black stool|bloody|রক্ত যাচ্ছে|পায়খানায় রক্ত|বমিতে রক্ত|প্রস্রাবে রক্ত|paikhanay rokto|bomite rokto/i, 'bleeding'],
  [/broken|fracture|can.?t (walk|move|stand)|bone|deformed|হাড় ভেঙে|ভেঙে গেছে|নড়াতে পারছি না|হাঁটতে পারছি না|vanga|venge geche|hatte parchi na/i, 'a possible fracture'],
  [/high fever|\b10[3-6]\b|\b(39|40|41)(\.\d)?\s*°?c|খুব জ্বর|১০[৩-৬]|onek jor|khub jor/i, 'a high fever'],
  [/(\b([3-9]|1\d)\b|three|four|five|six|seven|several|many|[৩-৯]|তিন|চার|পাঁচ|ছয়|সাত)\s*(days?|দিন)|week|weeks|সপ্তাহ|মাস ধরে|month/i, 'symptoms lasting several days'],
  [/severe|unbearable|very bad|খুব বেশি|প্রচণ্ড|তীব্র|অসহ্য|khub beshi|onek beshi|prochondo|osojjo/i, 'severe pain'],
  [/pregnan|গর্ভবতী|গর্ভাবস্থা/i, 'pregnancy'],
  [/\b(baby|infant|toddler|my child|my son|my daughter|kid)\b|শিশু|বাচ্চা/i, 'a child (doses differ by age and weight)'],
  [/numb|weakness on one side|swelling (of )?(face|lips|tongue)|difficulty swallowing|অবশ|ঠোঁট ফুলে|মুখ ফুলে/i, 'warning signs that need examination'],
];
const CRITICAL_BN = {
  'severe or unusual warning signs': 'তীব্র বা অস্বাভাবিক বিপদের লক্ষণ', bleeding: 'রক্তক্ষরণ', 'a possible fracture': 'হাড় ভাঙার সম্ভাবনা', 'a high fever': 'খুব বেশি জ্বর',
  'symptoms lasting several days': 'কয়েক দিন ধরে চলা সমস্যা', 'severe pain': 'তীব্র ব্যথা', pregnancy: 'গর্ভাবস্থা', 'a child (doses differ by age and weight)': 'শিশু (বয়স ও ওজন অনুযায়ী ডোজ আলাদা)',
  'warning signs that need examination': 'পরীক্ষা করে দেখার মতো বিপদের লক্ষণ', 'a condition that needs a doctor to adjust treatment': 'এমন সমস্যা যার চিকিৎসা ডাক্তারকেই ঠিক করতে হবে', 'pregnancy in your records': 'আপনার রেকর্ডে গর্ভাবস্থা',
};
function criticalReasons(message, topics, vit, prof) {
  const r = [];
  const add = (en, bn) => { if (!r.some((x) => x.en === en)) r.push(R(en, bn || CRITICAL_BN[en])); };
  for (const [re, why] of CRITICAL) if (re.test(message)) add(why);
  for (const u of vit.urgent) add(`a dangerous recent reading (${u.en})`, `সাম্প্রতিক বিপজ্জনক রিডিং (${u.bn})`);
  if (topics.some((t) => ['high blood pressure', 'low sugar'].includes(t.keys[0]))) add('a condition that needs a doctor to adjust treatment');
  if (/pregnan|গর্ভ/i.test(prof.conditionText) && !r.some((x) => x.en === 'pregnancy')) add('pregnancy in your records');
  return r;
}

/** Verified doctors on MediConnect for these specialties (best match first). */
function doctorsFor(patientId, specialties) {
  const { rankDoctors } = require('./recommender');
  const patient = db.get('SELECT * FROM patient_profiles WHERE user_id = ?', patientId);
  const out = [];
  // The best 3 doctors for the specialty (2 each when there are several problems), topped up with General Medicine.
  const uniq = [...new Set(specialties)];
  const per = uniq.length > 1 ? 2 : 3;
  for (const sp of uniq) out.push(...rankDoctors({ specialties: [{ specialty: sp, confidence: 1 }], patient }).slice(0, per));
  // Too few specialists? A General Medicine doctor can see the patient first and refer.
  if (out.length < 3) {
    for (const d of rankDoctors({ specialties: [{ specialty: 'General Medicine', confidence: 1 }], patient })) {
      if (out.length >= 3) break;
      if (!out.some((x) => x.user_id === d.user_id)) out.push(d);
    }
  }
  return out.slice(0, 5);
}

/** "Doctors for your problem" block with booking links (doctor page) and a link to see more. */
function doctorLines(r, bn) {
  const L = (en, b) => (bn ? b : en);
  const lines = [];
  if (r.doctors && r.doctors.length) {
    for (const d of r.doctors) {
      lines.push(`• ${d.full_name} · ${d.specialty} · ${d.experience_years} ${L('yrs', 'বছর')} · BDT ${d.fee}${d.distance != null ? ' · ' + d.distance + ' km' : ''}${d.live ? ' · ' + L('live now', 'এখন লাইভ') : ''}\n  → /patient/doctors/${d.user_id}`);
    }
  }
  for (const sp of r.specialties || []) lines.push(`${L('More', 'আরও')} ${sp} ${L('doctors', 'ডাক্তার')} → /patient/find-doctor?specialty=${encodeURIComponent(sp)}`);
  return lines;
}

/** Everything in the patient's records that matters for medicine safety. */
function profileOf(patientId) {
  const p = db.get('SELECT allergies, conditions FROM patient_profiles WHERE user_id = ?', patientId) || {};
  const diag = db.all("SELECT diagnosis FROM prescriptions WHERE patient_id = ? AND diagnosis IS NOT NULL AND created_at >= ?", patientId, new Date(Date.now() - 180 * 86400000).toISOString()).map((r) => r.diagnosis);
  const meds = ix.recordDrugs(patientId);
  const labs = ix.latestLabs(patientId);
  // Short, de-duplicated list: "Stomach ulcer (2023) · Suspected angina · Seasonal allergy".
  const seen = new Set();
  const parts = [p.conditions || '', ...diag.map((d) => d.split(/[.:]/)[0])].flatMap((x) => x.split(/,|·/)).map((x) => x.trim()).filter((x) => {
    const k = x.toLowerCase().replace('hypertension', 'high blood pressure');
    if (!x || seen.has(k)) return false; seen.add(k); return true;
  });
  const vit = vitalsRules(patientId);
  return { allergies: p.allergies || '', conditions: p.conditions || '', diagnoses: diag, meds, labs, conditionText: parts.join(' · '), vitals: vit, vitalBlocks: vit.blocks, vitalNotes: vit.notes };
}

/** Check one drug for this patient. Returns { ok, reasons[], already }. */
function checkDrug(key, prof) {
  const g = familyOf(key);
  const reasons = [];
  const push = (r) => { if (!reasons.some((x) => x.en === r.en)) reasons.push(r); };
  for (const [drugs, why] of (prof.vitalBlocks || [])) if (drugs.includes(g) || drugs.includes(key)) push(why);
  const allergy = ix.allergyHit(g, prof.allergies);
  if (allergy) push(R(allergy, ix.allergyHit(g, prof.allergies, true)));
  for (const [re, drugs, why, whyBn] of CONDITION_RULES) if (re.test(prof.conditionText) && drugs.includes(g)) push(R(why, whyBn));
  for (const [marker, limit, drugs, why, whyBn] of LAB_SAFETY) {
    const lab = prof.labs[marker];
    if (lab && lab.value > limit && drugs.includes(g)) push(R(why(lab.value), whyBn(lab.value)));
  }
  for (const [a, b, why] of ix.PAIR_RULES) {
    const other = a === g ? b : b === g ? a : null;
    if (other && prof.meds[other]) push(R(`it interacts with your ${other} (${prof.meds[other].source}): ${why}`, `আপনার ${other}-এর সাথে মিথস্ক্রিয়া করে (${prof.meds[other].sourceBn}): ${ix.whyBn(why)}`));
  }
  if (key !== 'diclofenac_gel' && NSAIDS.includes(g)) {
    const otherNsaid = NSAIDS.find((n) => n !== g && prof.meds[n]);
    if (otherNsaid && !reasons.some((r) => r.en.includes(otherNsaid))) push(R(`you already take ${otherNsaid}, another NSAID painkiller; two together raise the bleeding risk`, `আপনি আগে থেকেই ${otherNsaid} (আরেকটি NSAID) খাচ্ছেন; দুটো একসাথে রক্তক্ষরণের ঝুঁকি বাড়ায়`));
  }
  const already = prof.meds[g] ? prof.meds[g].source : null;
  const alreadyBn = prof.meds[g] ? prof.meds[g].sourceBn : null;
  return { ok: reasons.length === 0, reasons, already, alreadyBn };
}

const topicKey = (topic) => topic && topic.keys[0];

/**
 * Personal medicine guidance for a message, or null if the message isn't about a complaint or a medicine.
 * kind: 'drug' (user named a medicine) or 'topic' (user described a complaint).
 */
function forMessage(patientId, message) {
  const prof = profileOf(patientId);
  const named = ix.drugsIn(message).filter((g) => g !== 'potassium');
  const topics = allAdviceFor(message);
  if (named.length) {
    const sp = [...new Set(topics.map((t) => t.specialty))];
    return { kind: 'drug', prof, drugs: named.map((g) => ({ g, rxOnly: RX_ONLY.includes(g), ...checkDrug(g, prof) })), topic: topics[0] || null, topics, specialties: sp, doctors: sp.length ? doctorsFor(patientId, sp) : [] };
  }
  if (!topics.length) return null;
  // Combine every complaint: one list of medicines, each marked with the complaints it helps.
  const covers = {};
  for (const t of topics) for (const k of FOR_TOPIC[topicKey(t)] || []) (covers[k] = covers[k] || []).push(topicKey(t));
  const checked = Object.keys(covers).map((k) => ({ k, covers: covers[k], ...checkDrug(k, prof) })).sort((x, y) => y.covers.length - x.covers.length);
  const safe = checked.filter((c) => c.ok);
  const reasons = criticalReasons(message, topics, prof.vitals, prof);
  // A complaint with medicine options but none safe for this patient also goes to a doctor.
  const uncovered = topics.filter((t) => (FOR_TOPIC[topicKey(t)] || []).length && !safe.some((c) => c.covers.includes(topicKey(t))));
  for (const t of uncovered) reasons.push(R(`no over-the-counter medicine for ${topicKey(t)} is safe with your records`, `আপনার রেকর্ড অনুযায়ী ${topicKey(t)}-এর কোনো সাধারণ ওষুধই নিরাপদ নয়`));
  const critical = reasons.length > 0;
  const specialties = topics.map((t) => t.specialty);
  return { kind: 'topic', prof, topics, topic: topics[0], safe, avoid: checked.filter((c) => !c.ok), critical, reasons, doctors: doctorsFor(patientId, specialties), specialties: [...new Set(specialties)] };
}

function checkedLine(prof, bn) {
  const meds = Object.values(prof.meds).map((m) => m.generic);
  const labs = Object.values(prof.labs).filter((l) => ['creatinine', 'alt', 'glucose', 'hba1c'].includes(l.marker)).map((l) => `${l.marker} ${l.value}`);
  return bn
    ? `🔎 আপনার রেকর্ড দেখে: অ্যালার্জি: ${prof.allergies || 'নেই'} · রোগ/অবস্থা: ${prof.conditionText || 'নেই'} · চলমান ওষুধ: ${meds.join(', ') || 'নেই'}${labs.length ? ' · ল্যাব: ' + labs.join(', ') : ''}${prof.vitalNotes && prof.vitalNotes.length ? ' · ভাইটালস: ' + prof.vitalNotes.map((x) => x.bn).join(', ') : ''}`
    : `🔎 Checked against your records: allergies: ${prof.allergies || 'none recorded'} · conditions: ${prof.conditionText || 'none recorded'} · current medicines: ${meds.join(', ') || 'none'}${labs.length ? ' · labs: ' + labs.join(', ') : ''}${prof.vitalNotes && prof.vitalNotes.length ? ' · vitals: ' + prof.vitalNotes.map((x) => x.en).join(', ') : ''}`;
}

/** First-aid text without generic medicine lines (the personal list replaces them). */
function firstAidSteps(topic, bn) {
  const names = Object.values(ix.DRUGS).flat().filter((w) => w.length > 3);
  return (bn ? topic.bn : topic.en).split('\n').filter((line) => !(line.trim().startsWith('•') && names.some((n) => line.toLowerCase().includes(n.toLowerCase())))).join('\n');
}

/** Build the chatbot reply text. */
function render(r, bn) {
  const L = (en, b) => (bn ? b : en);
  const out = [];
  const T = (list) => list.map((x) => (bn ? x.bn || x : x.en || x)).join('; ');
  if (r.kind === 'drug') {
    for (const d of r.drugs) {
      const nm = NAME(d.g);
      if (d.rxOnly) {
        out.push(L(`💊 ${nm} is a prescription medicine, so I can't recommend it. Only a doctor can decide if you need it.`, `💊 ${nm} প্রেসক্রিপশনের ওষুধ, তাই আমি এটি সাজেস্ট করতে পারি না। দরকার কি না শুধু ডাক্তার ঠিক করবেন।`));
        if (d.reasons.length) out.push(L(`⛔ Also, for you: ${T(d.reasons)}. Tell the doctor about this.`, `⛔ এছাড়া আপনার ক্ষেত্রে: ${T(d.reasons)}। ডাক্তারকে এটা জানাবেন।`));
      } else if (!d.ok) {
        out.push(L(`⛔ Please don't take ${nm}. From your records: ${T(d.reasons)}.`, `⛔ ${nm} খাবেন না। আপনার রেকর্ড অনুযায়ী: ${T(d.reasons)}।`));
      } else if (d.already) {
        out.push(L(`ℹ️ You already take ${nm} (${d.already}). Don't take extra; follow that prescription's dose.`, `ℹ️ আপনি আগে থেকেই ${nm} খাচ্ছেন (${d.alreadyBn})। আলাদা করে বেশি খাবেন না; প্রেসক্রিপশনের ডোজ মেনে চলুন।`));
      } else {
        const o = OTC[d.g];
        out.push(L(`✅ ${nm} looks OK for you: nothing in your records rules it out.${o ? ' Use: ' + o.how + '.' : ''}`, `✅ আপনার রেকর্ডে ${nm} নিয়ে কোনো বাধা নেই।${o ? ' নিয়ম: ' + o.howBn + '।' : ''}`));
      }
    }
    const blocked = r.drugs.some((d) => !d.ok || d.rxOnly);
    if (blocked && r.topic && FOR_TOPIC[topicKey(r.topic)]) {
      const alt = FOR_TOPIC[topicKey(r.topic)].map((k) => ({ k, ...checkDrug(k, r.prof) })).filter((c) => c.ok);
      if (alt.length) out.push(L(`Safer option for you: ${alt.map((c) => NAME(c.k)).join(' or ')}.`, `আপনার জন্য নিরাপদ বিকল্প: ${alt.map((c) => OTC[c.k].bn).join(' অথবা ')}।`));
    }
  } else {
    const LABEL = { 'stomach pain': L('stomach pain / acidity', 'পেট ব্যথা / গ্যাস্ট্রিক'), cold: L('cold, cough, sore throat', 'সর্দি-কাশি, গলা ব্যথা'), headache: L('headache', 'মাথা ব্যথা'), fever: L('fever', 'জ্বর'), diarrhea: L('diarrhoea', 'ডায়রিয়া'), 'back pain': L('back pain', 'কোমর/পিঠে ব্যথা'), sprain: L('sprain', 'মচকানো'), rash: L('itch / rash', 'চুলকানি / র‍্যাশ'), burn: L('burn', 'পোড়া'), cut: L('cut', 'কাটা'), toothache: L('toothache', 'দাঁত ব্যথা'), 'period pain': L('period pain', 'মাসিকের ব্যথা'), 'heat stroke': L('heat / dehydration', 'গরমে পানিশূন্যতা') };
    const lab = (k) => LABEL[k] || k;
    if (r.topics.length > 1) out.push(L(`I found ${r.topics.length} problems: ${r.topics.map((t) => lab(topicKey(t))).join(' + ')}. Here is one combined plan.`, `আপনার ${r.topics.length}টি সমস্যা পেয়েছি: ${r.topics.map((t) => lab(topicKey(t))).join(' + ')}। নিচে সব মিলিয়ে একটি পরিকল্পনা দিলাম।`));
    if (r.critical) {
      out.push(L(`🩺 This needs a doctor. I won't suggest medicines for it because of: ${T(r.reasons)}.`, `🩺 এটি ডাক্তার দেখানো দরকার। এই কারণে আমি নিজে ওষুধ বলব না: ${T(r.reasons)}।`));
      out.push(L(`Suggested specialist: ${r.specialties.join(' / ')}.`, `উপযুক্ত বিশেষজ্ঞ: ${r.specialties.join(' / ')}।`));
      out.push(L('👨‍⚕️ Verified doctors on MediConnect you can book now:', '👨‍⚕️ এখনই বুক করা যায় এমন যাচাইকৃত ডাক্তার:'));
      out.push(...doctorLines(r, bn));
      out.push('');
      out.push(L('Until you see the doctor (safe first steps, no new medicines):', 'ডাক্তার দেখানো পর্যন্ত (নিরাপদ প্রাথমিক পদক্ষেপ, নতুন ওষুধ ছাড়া):'));
      for (const t of r.topics) out.push(firstAidSteps(t, bn).split('\n').filter((l) => l.trim().startsWith('•')).slice(0, 3).join('\n'));
    } else {
      for (const t of r.topics) {
        if (r.topics.length > 1) out.push(L(`▸ For ${lab(topicKey(t))}:`, `▸ ${lab(topicKey(t))}-এর জন্য:`));
        out.push(r.topics.length > 1 ? firstAidSteps(t, bn).split('\n').filter((l) => l.trim().startsWith('•') || /^(See a doctor|ডাক্তার দেখান)/.test(l.trim())).join('\n') : firstAidSteps(t, bn));
      }
      out.push('');
      out.push(L('💊 Medicines that suit you:', '💊 আপনার জন্য উপযুক্ত ওষুধ:'));
      for (const c of r.safe) {
        const o = OTC[c.k];
        const both = r.topics.length > 1 ? (c.covers.length > 1 ? L(` (helps ${c.covers.map(lab).join(' + ')})`, ` (${c.covers.map(lab).join(' + ')} দুটোতেই কাজ করে)`) : L(` (for ${lab(c.covers[0])})`, ` (${lab(c.covers[0])}-এর জন্য)`)) : '';
        out.push(c.already ? L(`• ${o.name}${both}: you already take it (${c.already}); don't take extra.`, `• ${o.bn}${both}: আগে থেকেই খাচ্ছেন (${c.alreadyBn}); বেশি খাবেন না।`) : `• ${bn ? o.bn : o.name}${both}: ${bn ? o.howBn : o.how}`);
      }
    }
    if (r.avoid.length) {
      out.push(L('⛔ Avoid for you:', '⛔ আপনার জন্য এড়িয়ে চলুন:'));
      for (const c of r.avoid) out.push(`• ${bn ? OTC[c.k].bn : OTC[c.k].name}: ${T(c.reasons)}`);
    }
  }
  // Doctors for the problem, with booking links (critical answers already list them above).
  if (!(r.kind === 'topic' && r.critical) && ((r.doctors && r.doctors.length) || (r.specialties && r.specialties.length))) {
    out.push('');
    out.push(L(`👨‍⚕️ If it doesn't get better, these verified doctors can help (${(r.specialties || []).join(' / ')}). Tap to book:`, `👨‍⚕️ উন্নতি না হলে এই যাচাইকৃত ডাক্তাররা সাহায্য করতে পারবেন (${(r.specialties || []).join(' / ')})। বুক করতে চাপুন:`));
    out.push(...doctorLines(r, bn));
  }
  // Sources for everything above.
  const src = [];
  const add = (x) => { if (x && !src.some((y) => y[1] === x[1])) src.push(x); };
  for (const t of r.topics || (r.topic ? [r.topic] : [])) add(TOPIC_SOURCES[topicKey(t)]);
  for (const c of r.kind === 'topic' && !r.critical ? r.safe : []) add(DRUG_SOURCES[c.k]);
  for (const d of r.kind === 'drug' ? r.drugs : []) add(DRUG_SOURCES[d.g]);
  const reasonsText = JSON.stringify((r.avoid || r.drugs || []).map((c) => (c.reasons || []).map((x) => x.en)));
  if (/NSAID|ibuprofen|aspirin|ulcer/i.test(reasonsText)) add(RULE_SOURCES.nsaid);
  if (/clopidogrel/i.test(reasonsText)) add(RULE_SOURCES.clopidogrel);
  if (src.length) {
    out.push('');
    out.push(L('📚 Sources:', '📚 তথ্যসূত্র:'));
    for (const [title, url] of src) out.push(`• ${title}: ${url}`);
  }
  out.push('');
  out.push(checkedLine(r.prof, bn));
  out.push(L('This is guidance from your records, not a diagnosis. If you are unsure or it gets worse, see a doctor.', 'এটি আপনার রেকর্ড দেখে দেওয়া নির্দেশনা, রোগনির্ণয় নয়। সন্দেহ থাকলে বা অবস্থা খারাপ হলে ডাক্তার দেখান।'));
  return out.join('\n');
}

/** Short safety brief for the AI model: what it may and may not suggest to this patient. */
function brief(r) {
  if (!r) return '';
  const lines = [];
  if (r.kind === 'topic') {
    lines.push(`Medicines you MAY suggest for this patient: ${r.safe.map((c) => OTC[c.k].name + ' (' + OTC[c.k].how + ')').join('; ') || 'none'}.`);
    if (r.avoid.length) lines.push(`NEVER suggest: ${r.avoid.map((c) => `${OTC[c.k].name} (${c.reasons.map((x) => x.en).join('; ')})`).join('; ')}.`);
  } else {
    for (const d of r.drugs) lines.push(`${NAME(d.g)}: ${d.rxOnly ? 'prescription-only, do not recommend' : d.ok ? 'no conflict in records' : 'DO NOT take: ' + d.reasons.map((x) => x.en).join('; ')}.`);
  }
  lines.push(checkedLine(r.prof, false));
  return lines.join('\n');
}

/** Words for every drug the patient must not be offered (used to check an AI answer before it is shown). */
function blockedWords(r) {
  if (!r) return [];
  const keys = r.kind === 'topic' ? r.avoid.map((c) => familyOf(c.k)) : r.drugs.filter((d) => !d.ok || d.rxOnly).map((d) => d.g);
  return keys.flatMap((g) => (ix.DRUGS[g] || [g]).filter((w) => w.length > 3));
}

module.exports = { OTC, FOR_TOPIC, RX_ONLY, TOPIC_SOURCES, DRUG_SOURCES, profileOf, checkDrug, forMessage, render, brief, blockedWords, criticalReasons, doctorsFor };
