// Drug-interaction safety rules and the "records vs rule" conflict check used by the Health AI chatbot.
//
// The chatbot must NOT answer when the patient's own records and a safety rule point in opposite
// directions, for example:
//   - the records say the patient is prescribed omeprazole AND clopidogrel (so the records say "take both"),
//     but the rule says omeprazole makes clopidogrel work less well (the rule says "don't combine");
//   - the patient asks "can I take ibuprofen?" while the records show aspirin is prescribed;
//   - the records show metformin is prescribed, but the latest lab report shows high creatinine.
// In those cases the answer depends on a doctor's judgement, so the bot abstains, explains the conflict
// and sends the patient to their doctor or pharmacist. Rules are fixed and written here, never decided by AI.
const db = require('../db');

// Generic name -> words that may appear in records or messages (brands common in Bangladesh, Bangla spellings).
const DRUGS = {
  paracetamol: ['paracetamol', 'acetaminophen', 'napa', 'প্যারাসিটামল', 'নাপা'],
  aspirin: ['aspirin', 'ecosprin', 'disprin', 'অ্যাসপিরিন', 'এসপিরিন', 'ইকোস্প্রিন'],
  clopidogrel: ['clopidogrel', 'clopid', 'lopirel', 'plavix', 'ক্লোপিডোগ্রেল'],
  warfarin: ['warfarin', 'warin', 'ওয়ারফারিন'],
  ibuprofen: ['ibuprofen', 'profen', 'brufen', 'advil', 'আইবুপ্রোফেন', 'ইবুপ্রোফেন'],
  diclofenac: ['diclofenac', 'clofenac', 'voltalin', 'ডাইক্লোফেনাক'],
  naproxen: ['naproxen', 'naprosyn', 'ন্যাপ্রোক্সেন'],
  omeprazole: ['omeprazole', 'seclo', 'losectil', 'ওমিপ্রাজল', 'ওমেপ্রাজল', 'সেকলো'],
  esomeprazole: ['esomeprazole', 'sergel', 'maxpro', 'ইসোমিপ্রাজল', 'সারজেল'],
  metformin: ['metformin', 'comet', 'glucophage', 'মেটফরমিন', 'মেটফর্মিন'],
  losartan: ['losartan', 'angilock', 'osartil', 'লোসার্টান'],
  spironolactone: ['spironolactone', 'aldactone', 'স্পিরোনোল্যাকটোন'],
  potassium: ['potassium chloride', 'potassium supplement', 'k-lyte'],
  sildenafil: ['sildenafil', 'viagra', 'সিলডেনাফিল'],
  nitroglycerin: ['nitroglycerin', 'glyceryl trinitrate', 'gtn', 'isosorbide', 'nitrocard'],
  amlodipine: ['amlodipine', 'camlodin', 'amdocal', 'অ্যামলোডিপিন'],
  simvastatin: ['simvastatin', 'simvas', 'সিমভাস্ট্যাটিন'],
  levothyroxine: ['levothyroxine', 'thyrox', 'eltroxin', 'লেভোথাইরক্সিন'],
  calcium: ['calcium carbonate', 'calbo', 'ostocal'],
  ciprofloxacin: ['ciprofloxacin', 'ciprocin', 'সিপ্রোফ্লক্সাসিন'],
  tramadol: ['tramadol', 'anadol', 'ট্রামাডল'],
  sertraline: ['sertraline', 'serlin', 'সারট্রালিন'],
  fluoxetine: ['fluoxetine', 'prozac', 'ফ্লুক্সেটিন'],
  cetirizine: ['cetirizine', 'alatrol', 'সেটিরিজিন'],
  fexofenadine: ['fexofenadine', 'fexo', 'telfast', 'ফেক্সোফেনাডিন'],
  loratadine: ['loratadine', 'loratin', 'লোরাটাডিন'],
  antacid: ['antacid', 'aluminium hydroxide', 'magnesium hydroxide', 'অ্যান্টাসিড'],
  mefenamic: ['mefenamic', 'ponstan', 'মেফেনামিক'],
  amoxicillin: ['amoxicillin', 'moxacil', 'amoxil', 'অ্যামক্সিসিলিন'],
  azithromycin: ['azithromycin', 'zimax', 'অ্যাজিথ্রোমাইসিন'],
  cefixime: ['cefixime', 'cef-3', 'সেফিক্সিম'],
  ors: ['ors', 'orsaline', 'oral rehydration', 'স্যালাইন', 'ওরস্যালাইন'],
  zinc: ['zinc', 'জিংক'],
  montelukast: ['montelukast', 'monas', 'মন্টিলুকাস্ট'],
};

// Allergy words -> drugs they rule out (including cross-reactions within a drug family).
const ALLERGY_FAMILIES = [
  [/penicillin|amoxi|ampicillin|পেনিসিলিন/i, ['amoxicillin'], 'penicillin allergy (amoxicillin is a penicillin)', 'পেনিসিলিনে অ্যালার্জি (অ্যামক্সিসিলিন পেনিসিলিন গোত্রের)'],
  [/cephalosporin|cefixime|ceftriaxone|সেফালো/i, ['cefixime'], 'cephalosporin allergy', 'সেফালোস্পোরিনে অ্যালার্জি'],
  [/nsaid|aspirin|ibuprofen|diclofenac|naproxen|mefenamic|painkiller|অ্যাসপিরিন|আইবুপ্রোফেন/i, ['aspirin', 'ibuprofen', 'diclofenac', 'naproxen', 'mefenamic'], 'NSAID / aspirin allergy (these painkillers cross-react)', 'NSAID / অ্যাসপিরিনে অ্যালার্জি (এই ব্যথানাশকগুলো একই গোত্রের)'],
  [/sulfa|sulpha|sulfonamide|সালফা/i, [], 'sulfa allergy', 'সালফায় অ্যালার্জি'],
  [/paracetamol|acetaminophen|প্যারাসিটামল/i, ['paracetamol'], 'paracetamol allergy', 'প্যারাসিটামলে অ্যালার্জি'],
  [/macrolide|azithro|erythro|clarithro/i, ['azithromycin'], 'macrolide allergy', 'ম্যাক্রোলাইডে অ্যালার্জি'],
  [/antihistamine|cetirizine|loratadine|fexofenadine/i, ['cetirizine', 'loratadine', 'fexofenadine'], 'antihistamine allergy', 'অ্যান্টিহিস্টামিনে অ্যালার্জি'],
];
/** Does the patient's allergy list rule out this drug? Returns the reason or null. */
function allergyHit(generic, allergyText, bn = false) {
  const t = String(allergyText || '');
  if (!t.trim()) return null;
  if ((DRUGS[generic] || [generic]).some((w) => w.length > 3 && t.toLowerCase().includes(w.toLowerCase()))) return bn ? `আপনার রেকর্ডে ${generic}-এ অ্যালার্জি আছে` : `allergy to ${generic} in your records`;
  for (const [re, drugs, why, whyB] of ALLERGY_FAMILIES) if (re.test(t) && drugs.includes(generic)) return bn ? whyB : why;
  return null;
}
const NAME = (g) => g.charAt(0).toUpperCase() + g.slice(1);

// [drug A, drug B, why they should not be combined without a doctor, severity]
const PAIR_RULES = [
  ['clopidogrel', 'omeprazole', 'Omeprazole can make clopidogrel work less well, which raises the risk of a heart attack or stroke.', 'high'],
  ['clopidogrel', 'esomeprazole', 'Esomeprazole can make clopidogrel work less well, which raises the risk of a heart attack or stroke.', 'high'],
  ['aspirin', 'ibuprofen', 'Ibuprofen with aspirin raises the risk of stomach bleeding and can block aspirin’s heart protection.', 'high'],
  ['aspirin', 'naproxen', 'Naproxen with aspirin raises the risk of stomach bleeding.', 'high'],
  ['aspirin', 'diclofenac', 'Diclofenac with aspirin raises the risk of stomach bleeding.', 'high'],
  ['warfarin', 'aspirin', 'Aspirin with warfarin greatly raises the risk of serious bleeding.', 'high'],
  ['warfarin', 'ibuprofen', 'Ibuprofen with warfarin greatly raises the risk of serious bleeding.', 'high'],
  ['warfarin', 'diclofenac', 'Diclofenac with warfarin greatly raises the risk of serious bleeding.', 'high'],
  ['warfarin', 'naproxen', 'Naproxen with warfarin greatly raises the risk of serious bleeding.', 'high'],
  ['warfarin', 'ciprofloxacin', 'Ciprofloxacin can make warfarin much stronger and cause bleeding.', 'high'],
  ['sildenafil', 'nitroglycerin', 'Sildenafil with nitrates can cause a dangerous drop in blood pressure.', 'high'],
  ['losartan', 'spironolactone', 'Losartan with spironolactone can raise blood potassium to unsafe levels.', 'high'],
  ['losartan', 'potassium', 'Losartan with potassium supplements can raise blood potassium to unsafe levels.', 'high'],
  ['tramadol', 'sertraline', 'Tramadol with sertraline can cause serotonin syndrome or seizures.', 'high'],
  ['tramadol', 'fluoxetine', 'Tramadol with fluoxetine can cause serotonin syndrome or seizures.', 'high'],
  ['amlodipine', 'simvastatin', 'Amlodipine raises simvastatin levels; above 20 mg simvastatin this risks muscle damage.', 'moderate'],
  ['levothyroxine', 'calcium', 'Calcium stops levothyroxine from being absorbed if taken at the same time.', 'moderate'],
];

// Bangla text for each rule above.
const WHY_BN = {
  'Omeprazole can make clopidogrel work less well, which raises the risk of a heart attack or stroke.': 'ওমিপ্রাজল ক্লোপিডোগ্রেলের কাজ কমিয়ে দিতে পারে, এতে হার্ট অ্যাটাক বা স্ট্রোকের ঝুঁকি বাড়ে।',
  'Esomeprazole can make clopidogrel work less well, which raises the risk of a heart attack or stroke.': 'ইসোমিপ্রাজল ক্লোপিডোগ্রেলের কাজ কমিয়ে দিতে পারে, এতে হার্ট অ্যাটাক বা স্ট্রোকের ঝুঁকি বাড়ে।',
  'Ibuprofen with aspirin raises the risk of stomach bleeding and can block aspirin’s heart protection.': 'অ্যাসপিরিনের সাথে আইবুপ্রোফেন খেলে পাকস্থলীতে রক্তক্ষরণের ঝুঁকি বাড়ে এবং অ্যাসপিরিনের হৃদ্‌সুরক্ষা কমে যায়।',
  'Naproxen with aspirin raises the risk of stomach bleeding.': 'অ্যাসপিরিনের সাথে ন্যাপ্রোক্সেন খেলে পাকস্থলীতে রক্তক্ষরণের ঝুঁকি বাড়ে।',
  'Diclofenac with aspirin raises the risk of stomach bleeding.': 'অ্যাসপিরিনের সাথে ডাইক্লোফেনাক খেলে পাকস্থলীতে রক্তক্ষরণের ঝুঁকি বাড়ে।',
  'Aspirin with warfarin greatly raises the risk of serious bleeding.': 'ওয়ারফারিনের সাথে অ্যাসপিরিন খেলে মারাত্মক রক্তক্ষরণের ঝুঁকি অনেক বাড়ে।',
  'Ibuprofen with warfarin greatly raises the risk of serious bleeding.': 'ওয়ারফারিনের সাথে আইবুপ্রোফেন খেলে মারাত্মক রক্তক্ষরণের ঝুঁকি অনেক বাড়ে।',
  'Diclofenac with warfarin greatly raises the risk of serious bleeding.': 'ওয়ারফারিনের সাথে ডাইক্লোফেনাক খেলে মারাত্মক রক্তক্ষরণের ঝুঁকি অনেক বাড়ে।',
  'Naproxen with warfarin greatly raises the risk of serious bleeding.': 'ওয়ারফারিনের সাথে ন্যাপ্রোক্সেন খেলে মারাত্মক রক্তক্ষরণের ঝুঁকি অনেক বাড়ে।',
  'Ciprofloxacin can make warfarin much stronger and cause bleeding.': 'সিপ্রোফ্লক্সাসিন ওয়ারফারিনের প্রভাব অনেক বাড়িয়ে রক্তক্ষরণ ঘটাতে পারে।',
  'Sildenafil with nitrates can cause a dangerous drop in blood pressure.': 'নাইট্রেটের সাথে সিলডেনাফিল খেলে রক্তচাপ বিপজ্জনকভাবে কমে যেতে পারে।',
  'Losartan with spironolactone can raise blood potassium to unsafe levels.': 'লোসার্টানের সাথে স্পিরোনোল্যাকটোন রক্তে পটাশিয়াম বিপজ্জনক মাত্রায় বাড়াতে পারে।',
  'Losartan with potassium supplements can raise blood potassium to unsafe levels.': 'লোসার্টানের সাথে পটাশিয়াম সাপ্লিমেন্ট রক্তে পটাশিয়াম বিপজ্জনক মাত্রায় বাড়াতে পারে।',
  'Tramadol with sertraline can cause serotonin syndrome or seizures.': 'ট্রামাডলের সাথে সারট্রালিন সেরোটোনিন সিনড্রোম বা খিঁচুনি ঘটাতে পারে।',
  'Tramadol with fluoxetine can cause serotonin syndrome or seizures.': 'ট্রামাডলের সাথে ফ্লুক্সেটিন সেরোটোনিন সিনড্রোম বা খিঁচুনি ঘটাতে পারে।',
  'Amlodipine raises simvastatin levels; above 20 mg simvastatin this risks muscle damage.': 'অ্যামলোডিপিন সিমভাস্ট্যাটিনের মাত্রা বাড়ায়; ২০ মি.গ্রা.-এর বেশি সিমভাস্ট্যাটিনে মাংসপেশির ক্ষতির ঝুঁকি।',
  'Calcium stops levothyroxine from being absorbed if taken at the same time.': 'একই সময়ে খেলে ক্যালসিয়াম লেভোথাইরক্সিন শোষণে বাধা দেয়।',
  'Your latest serum creatinine is high; metformin needs a doctor’s review when kidney function is reduced.': 'আপনার সর্বশেষ ক্রিয়েটিনিন বেশি; কিডনির কার্যক্ষমতা কম থাকলে মেটফরমিন ডাক্তারকে দেখিয়ে নিতে হবে।',
  'Your latest serum creatinine is high; ibuprofen can harm the kidneys further.': 'আপনার সর্বশেষ ক্রিয়েটিনিন বেশি; আইবুপ্রোফেন কিডনির আরও ক্ষতি করতে পারে।',
  'Your latest serum creatinine is high; diclofenac can harm the kidneys further.': 'আপনার সর্বশেষ ক্রিয়েটিনিন বেশি; ডাইক্লোফেনাক কিডনির আরও ক্ষতি করতে পারে।',
  'Your latest serum creatinine is high; naproxen can harm the kidneys further.': 'আপনার সর্বশেষ ক্রিয়েটিনিন বেশি; ন্যাপ্রোক্সেন কিডনির আরও ক্ষতি করতে পারে।',
};
const whyBn = (en) => WHY_BN[en] || en;

// [drug, lab marker, threshold, why]  (marker values come from the patient's own lab reports)
const LAB_RULES = [
  ['metformin', 'creatinine', 1.5, 'Your latest serum creatinine is high; metformin needs a doctor’s review when kidney function is reduced.'],
  ['ibuprofen', 'creatinine', 1.3, 'Your latest serum creatinine is high; ibuprofen can harm the kidneys further.'],
  ['diclofenac', 'creatinine', 1.3, 'Your latest serum creatinine is high; diclofenac can harm the kidneys further.'],
  ['naproxen', 'creatinine', 1.3, 'Your latest serum creatinine is high; naproxen can harm the kidneys further.'],
];

// A question about the patient's medicines in general ("which medicines today?", "আমার ওষুধ কি একসাথে খাব?").
const MED_QUESTION = /\b(medicines?|medications?|tablets?|pills?|capsules?|doses?|drugs?)\b|ওষুধ|ঔষধ|ট্যাবলেট|ক্যাপসুল|ডোজ/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALIAS_RE = Object.entries(DRUGS).map(([g, words]) => [g, new RegExp(`(?:^|[^a-z\\u0980-\\u09FF])(?:${words.map(esc).join('|')})(?![a-z])`, 'i')]);

/** Generic drug names found in any text. */
function drugsIn(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  return ALIAS_RE.filter(([, re]) => re.test(t)).map(([g]) => g);
}

/** Medicines the patient's own records say they take: recent prescriptions and active reminders. */
function recordDrugs(patientId) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = db.all(
    `SELECT COALESCE(m.name, '') || ' ' || IFNULL(m.brand, '') || ' ' || i.raw_name AS text, i.raw_name, m.strength,
            p.created_at, u.full_name AS doctor
       FROM prescription_items i JOIN prescriptions p ON p.id = i.prescription_id
       LEFT JOIN medicines m ON m.id = i.medicine_id LEFT JOIN users u ON u.id = p.doctor_id
      WHERE p.patient_id = ? AND p.created_at >= ?`, patientId, since);
  const rem = db.all("SELECT medicine_name AS text, medicine_name AS raw_name, NULL AS strength, created_at, NULL AS doctor FROM reminders WHERE patient_id = ? AND active = 1", patientId);
  const out = {};
  for (const r of [...rows, ...rem]) {
    for (const g of drugsIn(r.text)) {
      if (out[g] && out[g].doctor) continue;
      const day = new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      out[g] = { generic: g, doctor: r.doctor, source: r.doctor ? `prescribed by ${r.doctor} on ${day}` : 'in your active medicine reminders',
        sourceBn: r.doctor ? `${r.doctor}-এর প্রেসক্রিপশনে (${day})` : 'আপনার চালু ওষুধের রিমাইন্ডারে' };
    }
  }
  return out;
}

function latestLabs(patientId) {
  const rows = db.all(
    `SELECT marker, value, measured_on FROM health_markers h
      WHERE patient_id = ? AND measured_on = (SELECT MAX(measured_on) FROM health_markers WHERE patient_id = h.patient_id AND marker = h.marker)`, patientId);
  return Object.fromEntries(rows.map((r) => [r.marker, r]));
}

/** Conflicts between the patient's records and the rules, limited to `focus` drugs when given. */
function conflictsFor(patientId, { mentioned = [], medQuestion = false } = {}) {
  const rec = recordDrugs(patientId);
  const labs = latestLabs(patientId);
  const pool = new Set([...Object.keys(rec), ...mentioned]);
  const inScope = (g) => mentioned.includes(g) || (medQuestion && !mentioned.length && rec[g]);
  const found = [];
  for (const [a, b, why, severity] of PAIR_RULES) {
    if (!pool.has(a) || !pool.has(b)) continue;
    if (!(inScope(a) || inScope(b))) continue;
    // Opposite directions: at least one drug is backed by the patient's own records, while the rule says no.
    if (!rec[a] && !rec[b]) continue;
    found.push({ kind: 'pair', drugs: [a, b], why, whyBn: whyBn(why), severity, records: [rec[a], rec[b]].filter(Boolean) });
  }
  const allergies = (db.get('SELECT allergies FROM patient_profiles WHERE user_id = ?', patientId) || {}).allergies;
  for (const g of pool) {
    const why = rec[g] && allergyHit(g, allergies);
    if (why && inScope(g)) found.push({ kind: 'allergy', drugs: [g], why: `Your records list an ${why}, but ${NAME(g)} is ${rec[g].source}.`, whyBn: `আপনার রেকর্ডে ${allergyHit(g, allergies, true)} লেখা আছে, অথচ ${NAME(g)} ${rec[g].sourceBn} দেওয়া হয়েছে।`, severity: 'high', records: [rec[g]] });
  }
  for (const [drug, marker, limit, why] of LAB_RULES) {
    const lab = labs[marker];
    if (!lab || lab.value <= limit || !pool.has(drug) || !inScope(drug)) continue;
    found.push({ kind: 'lab', drugs: [drug], why, whyBn: whyBn(why), severity: 'high', lab, records: [rec[drug]].filter(Boolean) });
  }
  return found;
}

/**
 * Should the chatbot refuse to answer this message?
 * Returns null when it's safe to answer, or { conflicts, ruleOnly } otherwise.
 * - conflicts: records and a rule disagree -> abstain.
 * - ruleOnly: the user named two interacting drugs that are not in their records -> answer, but warn.
 */
function checkQuestion(patientId, message) {
  const mentioned = drugsIn(message);
  // A general "my medicines" question; a new complaint ("headache, which medicine?") gets personal advice instead.
  const medQuestion = MED_QUESTION.test(message) && !require('./firstaid').adviceFor(message);
  if (!mentioned.length && !medQuestion) return null;
  const conflicts = conflictsFor(patientId, { mentioned, medQuestion });
  if (conflicts.length) return { conflicts };
  const ruleOnly = PAIR_RULES.filter(([a, b]) => mentioned.includes(a) && mentioned.includes(b)).map(([a, b, why]) => ({ drugs: [a, b], why }));
  return ruleOnly.length ? { conflicts: [], ruleOnly } : null;
}

/** Record-vs-rule conflicts among everything the patient currently takes (for the shared timeline). */
function forPatient(patientId) {
  return conflictsFor(patientId, { medQuestion: true });
}

function abstainText(conflicts, bn) {
  const recLine = (c) => c.records.map((r) => `${NAME(r.generic)} (${r.source})`).join(' and ');
  const recLineBn = (c) => c.records.map((r) => `${NAME(r.generic)} (${r.sourceBn})`).join(' এবং ');
  if (bn) {
    return ['⚠️ এই প্রশ্নের উত্তর আমি দিতে পারছি না।',
      'আপনার নিজের মেডিকেল রেকর্ড আর একটি ওষুধ-মিথস্ক্রিয়ার নিরাপত্তা নিয়ম উল্টো কথা বলছে:',
      ...conflicts.map((c) => `• রেকর্ড: ${recLineBn(c) || c.drugs.map(NAME).join(', ')}\n• নিয়ম: ${c.whyBn || c.why}${c.lab ? ` (ক্রিয়েটিনিন ${c.lab.value}, ${c.lab.measured_on})` : ''}`),
      'এমন অবস্থায় আমি অনুমান করে উত্তর দেব না। পরের ডোজের আগে আপনার ডাক্তার বা ফার্মাসিস্টকে জিজ্ঞেস করুন (Doctor Chat বা Appointments থেকে বার্তা পাঠাতে পারেন)। নিজে থেকে কোনো ওষুধ বন্ধ বা পরিবর্তন করবেন না। বুকে ব্যথা, রক্তপাত বা শ্বাসকষ্ট হলে এখনই ৯৯৯-এ কল করুন।'].join('\n');
  }
  return ["⚠️ I can't answer this one safely.",
    'Your own medical records and a drug-interaction safety rule point in opposite directions:',
    ...conflicts.map((c) => `• Your records: ${recLine(c) || c.drugs.map(NAME).join(', ')}\n• Safety rule: ${c.why}${c.lab ? ` (creatinine ${c.lab.value} on ${c.lab.measured_on})` : ''}`),
    "Because of this conflict I won't guess. Please ask your doctor or pharmacist before your next dose (you can message them from Doctor Chat or Appointments). Don't stop or change any medicine on your own. If you have chest pain, bleeding or trouble breathing, call 999 now."].join('\n');
}

function ruleOnlyText(items, bn) {
  return items.map((r) => (bn ? `⚠️ সতর্কতা: ${NAME(r.drugs[0])} + ${NAME(r.drugs[1])}: ${whyBn(r.why)} ডাক্তারকে না জিজ্ঞেস করে একসাথে খাবেন না।`
    : `⚠️ Caution: ${NAME(r.drugs[0])} + ${NAME(r.drugs[1])}: ${r.why} Don't combine them without asking your doctor.`)).join('\n');
}

module.exports = { DRUGS, PAIR_RULES, LAB_RULES, ALLERGY_FAMILIES, WHY_BN, whyBn, allergyHit, drugsIn, recordDrugs, latestLabs, conflictsFor, checkQuestion, forPatient, abstainText, ruleOnlyText };
