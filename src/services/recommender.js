// AI doctor recommendation (decision support only).
//
// Step 1 maps what the patient wrote to medical specialties using a weighted
// symptom knowledge base, and keeps the matched terms so the result is explainable.
// Step 2 ranks verified doctors in those specialties by specialty match,
// experience, availability, distance and fee.
//
// The knowledge base is deliberately simple and transparent. You can swap
// `classifySpecialties` for an LLM or ML model later without touching the rest.
const db = require('../db');
const { distanceKm } = require('./geo');

// Each specialty lists English, Banglish (Bangla written in English letters) and Bangla
// terms with a weight. Bangla terms match anywhere in the text so inflected forms work
// (ভেঙে / ভেঙ্গে / ভাঙা all contain the stem we list).
const KNOWLEDGE = {
  'General Medicine': {
    fever: 2, cold: 1, flu: 2, weakness: 1, fatigue: 1, 'body ache': 2, tired: 1, 'weight loss': 1, infection: 1,
    typhoid: 3, dengue: 3, malaria: 3, vomiting: 1, chills: 1, jor: 2, jwor: 2, durbol: 1, sordi: 1,
    'জ্বর': 2, 'সর্দি': 1, 'ঠান্ডা': 1, 'দুর্বল': 1, 'ক্লান্ত': 1, 'গা ব্যথা': 2, 'শরীর ব্যথা': 2, 'টাইফয়েড': 3,
    'ডেঙ্গু': 3, 'ম্যালেরিয়া': 3, 'বমি': 1, 'কাঁপুনি দিয়ে': 1,
  },
  Cardiology: {
    'chest pain': 4, palpitation: 3, heart: 2, 'high blood pressure': 3, hypertension: 3, 'blood pressure': 2,
    'shortness of breath': 2, breathless: 2, 'swollen legs': 2, 'irregular heartbeat': 3, cholesterol: 2, 'chest tightness': 3,
    'buke betha': 4, 'buk betha': 4, dhorfor: 3, 'high pressure': 3,
    'বুকে ব্যথা': 4, 'বুক ব্যথা': 4, 'বুক ধড়ফড়': 3, 'ধড়ফড়': 3, 'হার্ট': 3, 'হৃদ': 3, 'উচ্চ রক্তচাপ': 3, 'রক্তচাপ': 2,
    'প্রেশার': 2, 'পা ফুলে': 2, 'কোলেস্টেরল': 2, 'বুক চাপ': 3,
  },
  Neurology: {
    headache: 2, migraine: 3, seizure: 4, epilepsy: 4, numbness: 3, tingling: 2, dizziness: 2, vertigo: 2,
    'memory loss': 3, stroke: 4, tremor: 3, paralysis: 4, 'slurred speech': 4, fainting: 2, 'matha betha': 2, 'matha ghora': 2,
    'মাথা ব্যথা': 2, 'মাথাব্যথা': 2, 'মাইগ্রেন': 3, 'খিঁচুনি': 4, 'অবশ': 3, 'ঝিনঝিন': 2, 'মাথা ঘোরা': 2, 'মাথা ঘুর': 2,
    'স্মৃতি': 3, 'ভুলে যাই': 2, 'স্ট্রোক': 4, 'হাত কাঁপ': 3, 'প্যারালাইসিস': 4, 'অজ্ঞান': 2, 'মৃগী': 4,
  },
  Gastroenterology: {
    'stomach pain': 3, 'stomach ache': 3, 'abdominal pain': 3, acidity: 2, gastric: 2, ulcer: 3, diarrhea: 2, diarrhoea: 2,
    constipation: 2, bloating: 2, nausea: 1, jaundice: 3, liver: 3, 'blood in stool': 4, heartburn: 2, 'pet betha': 3, gas: 1,
    'পেট ব্যথা': 3, 'পেটে ব্যথা': 3, 'পেট কামড়': 3, 'গ্যাস': 2, 'অ্যাসিডিটি': 2, 'এসিডিটি': 2, 'আলসার': 3, 'ডায়রিয়া': 2,
    'পাতলা পায়খানা': 3, 'কোষ্ঠকাঠিন্য': 2, 'পায়খানা কষা': 2, 'পেট ফাঁপা': 2, 'বমি বমি': 1, 'জন্ডিস': 3, 'লিভার': 3,
    'পায়খানায় রক্ত': 4, 'বুক জ্বালা': 2, 'হজম': 2,
  },
  Pulmonology: {
    cough: 2, asthma: 4, wheezing: 3, 'breathing problem': 3, 'difficulty breathing': 3, tuberculosis: 4, tb: 3,
    'chest congestion': 2, pneumonia: 4, copd: 4, phlegm: 2, kashi: 2, hapani: 4, 'shash koshto': 3,
    'কাশি': 2, 'হাঁপানি': 4, 'শ্বাসকষ্ট': 3, 'শ্বাস নিতে কষ্ট': 3, 'যক্ষ্মা': 4, 'যক্ষা': 4, 'নিউমোনিয়া': 4, 'কফ': 2, 'বুকে কফ': 2,
  },
  Dermatology: {
    skin: 3, rash: 3, itch: 3, acne: 3, eczema: 4, psoriasis: 4, 'hair loss': 3, hairfall: 3, allergy: 1, pimple: 3, fungal: 3,
    ringworm: 4, scabies: 4, dandruff: 2, 'dark spots': 2, hives: 3, wart: 3, 'white patch': 3, chulkani: 3, chormo: 3,
    'চর্ম': 3, 'চামড়া': 3, 'ত্বক': 3, 'স্কিন': 3, 'চুলকা': 3, 'ফুসকুড়ি': 3, 'র‍্যাশ': 3, 'ব্রণ': 3, 'একজিমা': 4, 'দাদ': 4,
    'ছত্রাক': 3, 'চুল পড়': 3, 'খুশকি': 2, 'মেছতা': 3, 'কালো দাগ': 2, 'এলার্জি': 1, 'অ্যালার্জি': 1, 'খোসপাঁচড়া': 4, 'আঁচিল': 3, 'সাদা দাগ': 3,
  },
  Orthopedics: {
    fracture: 4, broken: 4, broke: 4, 'bone': 3, 'joint pain': 3, 'back pain': 3, 'knee pain': 3, knee: 2, arthritis: 3,
    'neck pain': 2, 'shoulder pain': 3, sprain: 3, dislocat: 4, ligament: 3, spine: 3, 'hand pain': 2, 'leg pain': 2,
    'muscle pain': 1, swelling: 1, injury: 2, accident: 2, 'har vanga': 4, 'hat vanga': 4, vengeche: 4, 'komor betha': 3, 'hat bhanga': 4,
    'হাড়': 3, 'ভেঙে': 4, 'ভেঙ্গে': 4, 'ভাঙা': 4, 'ভাঙ্গা': 4, 'মচকা': 3, 'জয়েন্ট': 3, 'গিঁটে ব্যথা': 3, 'গাঁটে ব্যথা': 3,
    'কোমর ব্যথা': 3, 'কোমরে ব্যথা': 3, 'পিঠে ব্যথা': 3, 'হাঁটু': 3, 'ঘাড় ব্যথা': 2, 'ঘাড়ে ব্যথা': 2, 'কাঁধ': 2, 'বাত': 3,
    'আর্থ্রাইটিস': 3, 'মেরুদণ্ড': 3, 'আঘাত': 2, 'দুর্ঘটনা': 2, 'ফুলে গেছে': 1,
  },
  ENT: {
    'ear pain': 3, 'ear ache': 3, earache: 3, 'hearing loss': 4, tinnitus: 3, sinus: 3, sinusitis: 3, tonsil: 3, 'nose bleed': 2,
    'blocked nose': 2, 'sore throat': 2, 'throat pain': 2, hoarseness: 2, 'ear discharge': 3, 'kan betha': 3, 'gola betha': 2,
    'কান ব্যথা': 3, 'কানে ব্যথা': 3, 'কানে কম শুন': 4, 'কম শোনা': 4, 'নাক বন্ধ': 2, 'সাইনাস': 3, 'টনসিল': 3, 'গলা ব্যথা': 2,
    'গলায় ব্যথা': 2, 'নাক দিয়ে রক্ত': 2, 'কানে পুঁজ': 3, 'গলা বসে': 2, 'কানে শব্দ': 3,
  },
  Ophthalmology: {
    eye: 3, 'blurred vision': 3, 'red eye': 3, vision: 2, cataract: 4, glaucoma: 4, 'watery eyes': 2, 'itchy eyes': 2, chokh: 3,
    'চোখ': 3, 'ঝাপসা': 3, 'চোখ লাল': 3, 'ছানি': 4, 'গ্লুকোমা': 4, 'চোখে পানি': 2, 'চশমা': 2, 'দেখতে কষ্ট': 3,
  },
  Dentistry: {
    tooth: 4, teeth: 4, toothache: 4, gum: 3, cavity: 3, dental: 3, 'bleeding gums': 3, 'mouth ulcer': 2, dat: 2, 'dat betha': 4,
    'দাঁত': 4, 'দাঁতে ব্যথা': 4, 'মাড়ি': 3, 'মুখে ঘা': 2, 'দাঁত শিরশির': 3,
  },
  'Gynecology & Obstetrics': {
    pregnancy: 4, pregnant: 4, 'irregular period': 4, menstrual: 3, period: 2, 'period pain': 3, pcos: 4,
    'vaginal discharge': 3, menopause: 3, 'pelvic pain': 3, masik: 3,
    'গর্ভ': 4, 'প্রেগন্যান্ট': 4, 'অন্তঃসত্ত্বা': 4, 'মাসিক': 3, 'পিরিয়ড': 3, 'অনিয়মিত মাসিক': 4, 'সাদা স্রাব': 3, 'পিসিওএস': 4,
    'মেনোপজ': 3, 'তলপেটে ব্যথা': 3,
  },
  Pediatrics: {
    child: 2, baby: 3, infant: 3, toddler: 3, newborn: 4, 'my son': 2, 'my daughter': 2, vaccination: 2, kid: 2, baccha: 3,
    'শিশু': 3, 'বাচ্চা': 3, 'নবজাতক': 4, 'ছেলের': 2, 'মেয়ের': 2, 'টিকা': 2,
  },
  Psychiatry: {
    anxiety: 3, depression: 4, 'panic attack': 4, insomnia: 2, "can't sleep": 2, stress: 2, 'mood swings': 3, 'low mood': 3,
    hallucination: 4, tension: 2, 'ghum hoy na': 2,
    'দুশ্চিন্তা': 3, 'উদ্বেগ': 3, 'বিষণ্ণ': 4, 'ডিপ্রেশন': 4, 'ঘুম হয় না': 2, 'ঘুম আসে না': 2, 'অনিদ্রা': 2, 'মানসিক চাপ': 2,
    'স্ট্রেস': 2, 'প্যানিক': 4, 'মন খারাপ': 3, 'টেনশন': 2,
  },
  Endocrinology: {
    diabetes: 4, 'blood sugar': 4, sugar: 2, thyroid: 4, 'excessive thirst': 3, 'frequent urination': 2, 'weight gain': 2,
    hormone: 3, obesity: 2, diabetic: 4,
    'ডায়াবেটিস': 4, 'সুগার': 3, 'থাইরয়েড': 4, 'বেশি পিপাসা': 3, 'ঘন ঘন প্রস্রাব': 2, 'ওজন বাড়': 2, 'হরমোন': 3, 'মোটা হয়ে': 2,
  },
  Nephrology: {
    kidney: 4, creatinine: 4, 'swollen face': 2, 'foamy urine': 3, dialysis: 4,
    'কিডনি': 4, 'ক্রিয়েটিনিন': 4, 'মুখ ফোলা': 2, 'ফেনা': 2, 'ডায়ালাইসিস': 4,
  },
  Urology: {
    'burning urination': 3, 'painful urination': 3, 'urinary infection': 3, uti: 3, 'kidney stone': 4, stone: 2,
    prostate: 4, 'blood in urine': 4, 'prosrabe jala': 3,
    'প্রস্রাবে জ্বালা': 3, 'প্রস্রাবে ব্যথা': 3, 'প্রস্রাবের সময়': 2, 'ইউরিন ইনফেকশন': 3, 'পাথর': 3, 'প্রোস্টেট': 4, 'প্রস্রাবে রক্ত': 4,
  },
};

// Phrases that should send the patient to emergency care immediately.
const RED_FLAGS = [
  'chest pain', 'difficulty breathing', 'unconscious', 'seizure', 'stroke', 'slurred speech',
  'face drooping', 'severe bleeding', 'coughing blood', 'vomiting blood', 'suicidal', 'paralysis',
  'বুকে ব্যথা', 'বুক ব্যথা', 'শ্বাস নিতে কষ্ট', 'অজ্ঞান', 'খিঁচুনি', 'রক্তবমি', 'স্ট্রোক', 'প্যারালাইসিস', 'আত্মহত্যা',
];

const SPECIALTIES = Object.keys(KNOWLEDGE);

const BANGLA = /[\u0980-\u09FF]/;
function contains(text, phrase) {
  if (BANGLA.test(phrase)) return text.includes(phrase.normalize('NFC'));
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(^|[^a-z])${escaped}`, 'i').test(text);
}

/** Returns [{ specialty, confidence (0-1), matched: [terms] }] sorted best first. */
function classifySpecialties(entry) {
  const primary = [entry.current_problems, entry.symptoms, entry.suspected_diseases, entry.other_info]
    .filter(Boolean)
    .join(' . ')
    .toLowerCase()
    .normalize('NFC');
  const history = String(entry.previous_conditions || '').toLowerCase().normalize('NFC');

  const scores = [];
  for (const [specialty, terms] of Object.entries(KNOWLEDGE)) {
    let score = 0;
    const matched = [];
    for (const [term, weight] of Object.entries(terms)) {
      if (contains(primary, term)) {
        score += weight;
        matched.push(term);
      } else if (contains(history, term)) {
        score += weight * 0.5; // history matters, but less than current complaints
        matched.push(`${term} (history)`);
      }
    }
    if (score > 0) scores.push({ specialty, score, matched });
  }

  const total = scores.reduce((s, x) => s + x.score, 0);
  let result = scores
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => ({ specialty: s.specialty, confidence: total ? s.score / total : 0, matched: s.matched }));

  if (!result.length || result[0].confidence < 0.3) {
    if (!result.find((r) => r.specialty === 'General Medicine')) {
      result.push({ specialty: 'General Medicine', confidence: result.length ? 0.2 : 1, matched: ['general assessment'] });
    }
  }
  return result;
}

function redFlags(entry) {
  const text = [entry.current_problems, entry.symptoms, entry.other_info].filter(Boolean).join(' ').toLowerCase().normalize('NFC');
  return RED_FLAGS.filter((f) => contains(text, f));
}

/**
 * Rank verified doctors. `specialties` = output of classifySpecialties (or a single
 * specialty with confidence 1 when the patient filters manually).
 */
function rankDoctors({ specialties, patient, maxFee, maxDistanceKm }) {
  const names = specialties.map((s) => s.specialty);
  if (!names.length) return [];
  const placeholders = names.map(() => '?').join(',');
  const doctors = db.all(
    `SELECT u.id, u.full_name, u.email, u.phone, u.created_at, d.*
       FROM users u JOIN doctor_profiles d ON d.user_id = u.id
      WHERE u.role = 'doctor' AND u.status = 'active' AND d.verified = 1 AND d.specialty IN (${placeholders})`,
    ...names
  );
  const maxDoctorFee = Math.max(1, ...doctors.map((d) => d.fee));

  return doctors
    .map((d) => {
      const spec = specialties.find((s) => s.specialty === d.specialty);
      const pLat = patient ? patient.live_lat ?? patient.lat : null;
      const pLng = patient ? patient.live_lng ?? patient.lng : null;
      const live = d.share_location && d.live_lat != null && Date.now() - new Date(d.live_at || 0) < 30 * 60_000;
      const distance = patient ? distanceKm(pLat, pLng, live ? d.live_lat : d.lat, live ? d.live_lng : d.lng) : null;
      const parts = {
        specialtyMatch: Math.round((spec ? spec.confidence : 0) * 50),
        experience: Math.min(d.experience_years, 20),
        availability: Math.min(10, 2 * db.get('SELECT COUNT(*) n FROM doctor_hours WHERE doctor_id = ? AND enabled = 1', d.user_id).n),
        location: distance === null ? 5 : Math.max(0, Math.round(10 - distance)),
        fee: Math.round(10 * (1 - d.fee / maxDoctorFee)),
      };
      const score = Object.values(parts).reduce((a, b) => a + b, 0);
      const isNew = Date.now() - new Date(d.created_at || 0) < 30 * 86400000;
      return { ...d, distance, score, parts, live, isNew };
    })
    .filter((d) => (maxFee ? d.fee <= maxFee : true))
    .filter((d) => (maxDistanceKm && d.distance !== null ? d.distance <= maxDistanceKm : true))
    .sort((a, b) => b.score - a.score);
}

/**
 * Optional AI step: when ANTHROPIC_API_KEY is set, Claude reads the description (Bangla or
 * English) and picks specialties from our list. The rule-based result is used when the key
 * is missing or the call fails, so the feature always works offline.
 */
async function classifyWithAI(description) {
  const rules = classifySpecialties({ current_problems: description });
  const config = require('../config');
  if (!config.anthropicKey) return { specialties: rules, ai: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.anthropicModel, max_tokens: 300,
        system: `You route patients in Bangladesh to the right medical specialty. The text may be Bangla, English or Banglish.
Choose 1 to 3 specialties ONLY from this list: ${SPECIALTIES.join(', ')}.
Reply with JSON only: {"specialties":[{"specialty":"...","confidence":0.0-1.0,"matched":["short symptom words in English"]}]}`,
        messages: [{ role: 'user', content: description.slice(0, 2000) }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).map((p) => p.text || '').join('');
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const list = (parsed.specialties || []).filter((x) => SPECIALTIES.includes(x.specialty)).slice(0, 3)
      .map((x) => ({ specialty: x.specialty, confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0.5)), matched: (x.matched || []).slice(0, 4).map(String) }));
    return list.length ? { specialties: list, ai: true } : { specialties: rules, ai: false };
  } catch (e) {
    console.error('AI specialty match failed, using built-in rules:', e.message);
    return { specialties: rules, ai: false };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { classifySpecialties, classifyWithAI, rankDoctors, redFlags, SPECIALTIES };
