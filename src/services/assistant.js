// Health Assistant chatbot (Bangla / English).
// - Emergency words are caught by rules first, before any AI.
// - Answers are built from the patient's own records (appointments, prescriptions,
//   reminders, orders, tests, readings), never from guesses about them.
// - With ANTHROPIC_API_KEY set, Claude writes the reply from that context.
//   Without a key, built-in rule-based answers are used.
// The assistant never diagnoses and never changes doses.
const db = require('../db');
const config = require('../config');
const { classifySpecialties } = require('./recommender');
const reminders = require('./reminders');
const health = require('./health');
const { adviceFor } = require('./firstaid');
const { correctiveRetrieve } = require('./retrieval');
const interactions = require('./interactions');

const EMERGENCY = [
  'chest pain', 'can\'t breathe', 'cannot breathe', 'difficulty breathing', 'unconscious', 'fainted', 'seizure',
  'stroke', 'slurred speech', 'face drooping', 'severe bleeding', 'vomiting blood', 'coughing blood', 'suicide',
  'kill myself', 'overdose', 'বুকে ব্যথা', 'শ্বাস নিতে কষ্ট', 'অজ্ঞান', 'খিঁচুনি', 'রক্তবমি', 'আত্মহত্যা',
];
const isBangla = (t) => /[ঀ-৿]/.test(t);
const has = (t, words) => words.some((w) => t.includes(w));
const when = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function context(userId) {
  const appts = db.all(
    `SELECT a.status, a.proposed_time, u.full_name AS doctor, d.specialty FROM appointments a
       JOIN users u ON u.id = a.doctor_id JOIN doctor_profiles d ON d.user_id = a.doctor_id
      WHERE a.patient_id = ? AND a.status IN ('requested','proposed','reschedule_requested','confirmed') ORDER BY a.proposed_time`, userId);
  const meds = db.all(
    `SELECT DISTINCT COALESCE(m.name || ' ' || IFNULL(m.strength,''), i.raw_name) AS name, i.dose, i.frequency, i.duration_days
       FROM prescription_items i JOIN prescriptions p ON p.id = i.prescription_id LEFT JOIN medicines m ON m.id = i.medicine_id
      WHERE p.patient_id = ? AND p.created_at >= ? ORDER BY p.id DESC LIMIT 12`, userId, new Date(Date.now() - 60 * 86400000).toISOString());
  const doses = reminders.today(userId);
  const orders = db.all(
    `SELECT o.id, o.status, o.total, p.name AS pharmacy FROM orders o JOIN pharmacies p ON p.id = o.pharmacy_id
      WHERE o.patient_id = ? ORDER BY o.id DESC LIMIT 3`, userId);
  const tests = db.all(
    `SELECT t.name, o.status, c.name AS center FROM test_orders o JOIN test_catalog t ON t.id = o.test_id
       LEFT JOIN centers c ON c.id = o.center_id WHERE o.patient_id = ? ORDER BY o.id DESC LIMIT 6`, userId);
  const h = health.overview(userId);
  return { appts, meds, doses, orders, tests, health: h };
}

function contextText(c) {
  const lines = [];
  lines.push('Appointments: ' + (c.appts.map((a) => `${a.doctor} (${a.specialty}) ${a.status}${a.proposed_time ? ' at ' + when(a.proposed_time) : ''}`).join('; ') || 'none'));
  lines.push('Recent prescribed medicines: ' + (c.meds.map((m) => `${m.name.trim()} ${m.dose || ''} ${m.frequency || ''}`.trim()).join('; ') || 'none'));
  lines.push("Today's doses: " + (c.doses.map((d) => `${d.medicine_name} at ${new Date(d.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${d.status})`).join('; ') || 'none'));
  lines.push('Medicine orders: ' + (c.orders.map((o) => `#MC-${1000 + o.id} from ${o.pharmacy}: ${o.status}`).join('; ') || 'none'));
  lines.push('Tests: ' + (c.tests.map((t) => `${t.name}: ${t.status}${t.center ? ' at ' + t.center : ''}`).join('; ') || 'none'));
  lines.push('Latest readings: ' + (Object.values(c.health.kinds).filter((k) => k.last).map((k) => `${k.name} ${health.fmt(k.last)} ${k.unit} (${k.status.note})`).join('; ') || 'none'));
  return lines.join('\n');
}

const SYSTEM = `You are MediConnect Health AI, a friendly health adviser for patients in Bangladesh.
You give practical first-aid and self-care advice for everyday health problems (for example: headache, fever, cold, acidity, diarrhoea, minor burns, cuts, sprains, toothache, rash, stress, sleep), healthy-living tips, and explain when to see which kind of doctor.
Rules you must follow:
- Reply in the same language as the user (Bangla or English, including Banglish). Use short bullet points, under 160 words, plain and kind.
- Give concrete first steps the person can safely do at home, then clear warning signs for when to see a doctor or go to hospital.
- Use ONLY the patient's records given below for anything about them. If something is not in the records, say so.
- Never diagnose, never name a disease the patient "has", never start, stop or change a dose. For dose questions, tell them to follow their prescription and ask their doctor or pharmacist.
- For general questions, give safe general information and suggest the right type of specialist. You may mention common over-the-counter options (e.g. paracetamol, ORS, antacid) with "as per the pack"; never give prescription-drug doses.
- If anything sounds like an emergency, tell them to call 999 or go to the nearest emergency department now.
- Point to MediConnect pages when useful: Find a Doctor (AI), Appointments, Medical Tests, Medicine Reminders, Order Medicine, Health Status, Blood Bank.`;

async function llmReply(userId, message, ctx, aid) {
  const history = db
    .all('SELECT role, body FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 10', userId)
    .reverse()
    .map((m) => ({ role: m.role, content: m.body }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 400,
        system: `${SYSTEM}\n\nPatient records:\n${contextText(ctx)}` +
          (aid ? `\n\nRetrieved first-aid knowledge (base your advice on it; reply in the user's language):\n${aid.en}\nSuggested specialist: ${aid.specialty}` : ''),
        messages: [...history, { role: 'user', content: message }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return (data.content || []).map((p) => p.text || '').join('').trim() || null;
  } catch (e) {
    console.error('Assistant API failed, using built-in answers:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ruleReply(message, c) {
  const t = message.toLowerCase();
  const bn = isBangla(message);
  const L = (en, b) => (bn ? b : en);

  // First-aid advice comes first: "I have a headache, what should I do?"
  const aid = adviceFor(message);
  if (aid) {
    return `${bn ? aid.bn : aid.en}\n\n${L(`A ${aid.specialty} doctor can help if it doesn't improve. Open Find a Doctor (AI) to book one nearby.`, `উন্নতি না হলে ${aid.specialty} বিশেষজ্ঞ দেখান। Find a Doctor (AI) থেকে কাছের ডাক্তার বুক করুন।`)}\n${L('This is general advice, not a diagnosis.', 'এটি সাধারণ পরামর্শ, রোগনির্ণয় নয়।')}`;
  }

  if (has(t, ['appointment', 'doctor time', 'schedule', 'অ্যাপয়েন্টমেন্ট', 'সিরিয়াল'])) {
    if (!c.appts.length) return L('You have no active appointments. Use Find a Doctor (AI) to request one.', 'আপনার কোনো চলমান অ্যাপয়েন্টমেন্ট নেই। Find a Doctor (AI) থেকে অনুরোধ করুন।');
    return L('Your appointments:\n', 'আপনার অ্যাপয়েন্টমেন্ট:\n') + c.appts.map((a) => `• ${a.doctor} (${a.specialty}): ${a.status.replace('_', ' ')}${a.proposed_time ? ', ' + when(a.proposed_time) : ''}`).join('\n')
      + (c.appts.some((a) => a.status === 'proposed') ? L('\nOne time is waiting for your confirmation in Appointments.', '\nএকটি সময় আপনার নিশ্চিতকরণের অপেক্ষায় আছে।') : '');
  }
  if (has(t, ['dose', 'reminder', 'take my', 'medicine today', 'missed', 'ওষুধ', 'ডোজ', 'খাব'])) {
    if (has(t, ['change', 'increase', 'double', 'stop', 'বাড়া', 'বন্ধ'])) {
      return L('I can\'t change or stop a dose. Please follow your prescription and ask your doctor or pharmacist before changing anything.', 'আমি ডোজ পরিবর্তন বা বন্ধ করতে পারি না। প্রেসক্রিপশন অনুযায়ী খান এবং পরিবর্তনের আগে ডাক্তার বা ফার্মাসিস্টকে জিজ্ঞেস করুন।');
    }
    if (!c.doses.length) return L('No doses are scheduled today. Open Medicine Reminders to create reminders from a prescription.', 'আজ কোনো ডোজ নির্ধারিত নেই। Medicine Reminders থেকে প্রেসক্রিপশন দিয়ে রিমাইন্ডার তৈরি করুন।');
    return L("Today's doses:\n", 'আজকের ডোজ:\n') + c.doses.map((d) => `• ${new Date(d.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ${d.medicine_name} (${d.dose}): ${d.status}`).join('\n');
  }
  if (has(t, ['order', 'delivery', 'pharmacy', 'অর্ডার', 'ডেলিভারি'])) {
    if (!c.orders.length) return L('You have no medicine orders yet. Use Order Medicine to compare nearby pharmacies.', 'এখনো কোনো অর্ডার নেই। Order Medicine থেকে কাছের ফার্মেসি তুলনা করুন।');
    return c.orders.map((o) => `• #MC-${1000 + o.id} ${o.pharmacy}: ${o.status.replace(/_/g, ' ')}`).join('\n') + L('\nOpen Order History to track it on the map.', '\nম্যাপে ট্র্যাক করতে Order History খুলুন।');
  }
  if (has(t, ['report', 'test', 'lab', 'রিপোর্ট', 'টেস্ট', 'পরীক্ষা'])) {
    if (!c.tests.length) return L('No tests have been prescribed yet.', 'এখনো কোনো টেস্ট দেওয়া হয়নি।');
    return c.tests.map((x) => `• ${x.name}: ${x.status.replace(/_/g, ' ')}${x.center ? ' (' + x.center + ')' : ''}`).join('\n');
  }
  if (has(t, ['blood donor', 'need blood', 'রক্ত'])) {
    return L('Open Blood Bank to post a request. Compatible donors nearby are notified at once, and their number is shared only after they accept.', 'Blood Bank এ গিয়ে অনুরোধ দিন। কাছের উপযুক্ত ডোনারদের সাথে সাথে জানানো হবে।');
  }
  if (has(t, ['bp', 'blood pressure', 'sugar', 'pulse', 'oxygen', 'weight', 'প্রেশার', 'সুগার'])) {
    const ks = Object.values(c.health.kinds).filter((k) => k.last);
    if (!ks.length) return L('No readings yet. Log them in Health Status to see trends and warnings.', 'এখনো কোনো রিডিং নেই। Health Status এ রিডিং যোগ করুন।');
    return ks.map((k) => `• ${k.name}: ${health.fmt(k.last)} ${k.unit} – ${k.status.note} (${k.trend.dir})`).join('\n') + L('\nThis is guidance, not a diagnosis.', '\nএটি নির্দেশনা মাত্র, রোগনির্ণয় নয়।');
  }
  const spec = classifySpecialties({ current_problems: message });
  if (spec[0] && spec[0].matched[0] !== 'general assessment') {
    return L(`From what you describe (${spec[0].matched.slice(0, 3).join(', ')}), a ${spec[0].specialty} specialist may be the right doctor. I can't diagnose, but Find a Doctor (AI) will show verified ${spec[0].specialty} doctors near you.`,
      `আপনার বর্ণনা অনুযায়ী ${spec[0].specialty} বিশেষজ্ঞ উপযুক্ত হতে পারেন। আমি রোগনির্ণয় করি না, তবে Find a Doctor (AI) থেকে যাচাই করা ডাক্তার পাবেন।`);
  }
  if (has(t, ['healthy', 'diet', 'exercise', 'weight', 'tips', 'স্বাস্থ্যকর', 'খাবার', 'ব্যায়াম', 'ওজন'])) {
    return L(`Everyday health tips:\n• Eat more vegetables, fruit, lentils and fish; less salt, sugar and fried food.\n• Walk or exercise 30 minutes a day.\n• Drink 8 glasses of water; sleep 7–8 hours.\n• No smoking or betel leaf (paan/jorda).\n• Check BP and sugar once a year after 35, and keep vaccinations up to date.`,
      `প্রতিদিনের স্বাস্থ্য টিপস:\n• বেশি করে শাকসবজি, ফল, ডাল ও মাছ খান; লবণ, চিনি ও ভাজাপোড়া কম খান।\n• প্রতিদিন ৩০ মিনিট হাঁটুন বা ব্যায়াম করুন।\n• দিনে ৮ গ্লাস পানি পান করুন; ৭–৮ ঘণ্টা ঘুমান।\n• ধূমপান, পান-জর্দা বাদ দিন।\n• ৩৫ বছরের পর বছরে একবার প্রেশার ও সুগার পরীক্ষা করুন।`);
  }
  return L('I am your health adviser. Tell me what you feel (e.g. "I have a headache", "fever since yesterday", "acidity") and I will tell you what you can do first and when to see a doctor. I can also check your appointments, doses, reports and orders.',
    'আমি আপনার স্বাস্থ্য পরামর্শদাতা। আপনার কী সমস্যা লিখুন (যেমন "মাথা ব্যথা", "গতকাল থেকে জ্বর", "গ্যাস্ট্রিক") — প্রথমে কী করবেন আর কখন ডাক্তার দেখাবেন জানাব। আপনার অ্যাপয়েন্টমেন্ট, ওষুধ, রিপোর্ট ও অর্ডারের খবরও দিতে পারি।');
}

async function reply(user, message) {
  const t = message.toLowerCase();
  if (has(t, EMERGENCY)) {
    return {
      flagged: true,
      text: isBangla(message)
        ? 'এটি জরুরি হতে পারে। এখনই 999 নম্বরে কল করুন অথবা নিকটস্থ জরুরি বিভাগে যান। একা থাকলে কাউকে পাশে ডাকুন।'
        : 'This could be an emergency. Call 999 now or go to the nearest emergency department. If you are alone, call someone to be with you.',
    };
  }
  // Safety stop: if the patient's own records and a drug-interaction rule disagree, don't answer at all
  // (neither the AI nor the built-in rules). Explain the conflict and send them to their doctor.
  const check = interactions.checkQuestion(user.id, message);
  if (check && check.conflicts.length) {
    return { flagged: true, abstained: true, conflicts: check.conflicts, text: interactions.abstainText(check.conflicts, isBangla(message)) };
  }
  const caution = check && check.ruleOnly ? interactions.ruleOnlyText(check.ruleOnly, isBangla(message)) : '';
  const ctx = context(user.id);
  if (config.anthropicKey) {
    // Retrieve the matching first-aid entry; if the wording matches nothing, rewrite the query and retry.
    const { result: aid } = await correctiveRetrieve(message, adviceFor);
    const text = await llmReply(user.id, message, ctx, aid);
    if (text) return { flagged: false, text: caution ? `${caution}\n\n${text}` : text, ai: true };
  }
  const text = ruleReply(message, ctx);
  return { flagged: false, text: caution ? `${caution}\n\n${text}` : text };
}

module.exports = { reply, isBangla };
