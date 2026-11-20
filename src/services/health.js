// Health status: classify readings with fixed, published thresholds (never by AI),
// compute trends and write a plain-language weekly summary.
// These are general guidance values for adults, not a diagnosis.
const db = require('../db');

const KINDS = {
  bp: { name: 'Blood pressure', unit: 'mmHg' },
  sugar: { name: 'Blood sugar', unit: 'mmol/L' },
  weight: { name: 'Weight', unit: 'kg' },
  pulse: { name: 'Pulse', unit: 'bpm' },
  spo2: { name: 'Oxygen (SpO2)', unit: '%' },
};
const LEVEL = { normal: 0, watch: 1, doctor: 2, urgent: 3 };
const LEVEL_TEXT = { normal: 'Normal', watch: 'Watch', doctor: 'See a doctor', urgent: 'Get help now' };

function classify(r, heightCm) {
  const [a, b] = [r.value1, r.value2];
  switch (r.kind) {
    case 'bp':
      if (a >= 180 || b >= 120) return { level: 'urgent', note: 'Very high blood pressure' };
      if (a >= 140 || b >= 90) return { level: 'doctor', note: 'High blood pressure (140/90 or above)' };
      if (a < 90 || b < 60) return { level: 'watch', note: 'Low blood pressure' };
      if (a >= 130 || b >= 80) return { level: 'watch', note: 'Slightly raised' };
      return { level: 'normal', note: 'In the normal range' };
    case 'sugar': {
      const fasting = r.context === 'fasting';
      if (a < 3.9) return { level: 'doctor', note: 'Low blood sugar' };
      if (a >= 16.7) return { level: 'urgent', note: 'Very high blood sugar' };
      if (fasting ? a >= 7 : a >= 11.1) return { level: 'doctor', note: fasting ? 'High fasting sugar (7.0 or above)' : 'High sugar (11.1 or above)' };
      if (fasting ? a > 5.5 : a >= 7.8) return { level: 'watch', note: 'Above the normal range' };
      return { level: 'normal', note: 'In the normal range' };
    }
    case 'weight': {
      if (!heightCm) return { level: 'normal', note: 'Add your height in Profile to see BMI' };
      const bmi = a / (heightCm / 100) ** 2;
      const v = bmi.toFixed(1);
      if (bmi >= 30) return { level: 'doctor', note: `BMI ${v} (obese range)`, bmi: v };
      if (bmi >= 25) return { level: 'watch', note: `BMI ${v} (overweight range)`, bmi: v };
      if (bmi < 18.5) return { level: 'watch', note: `BMI ${v} (underweight range)`, bmi: v };
      return { level: 'normal', note: `BMI ${v} (healthy range)`, bmi: v };
    }
    case 'pulse':
      if (a < 40 || a > 130) return { level: 'urgent', note: 'Pulse far outside the normal range' };
      if (a < 50 || a > 120) return { level: 'doctor', note: 'Pulse outside the normal range' };
      if (a < 60 || a > 100) return { level: 'watch', note: 'Slightly outside 60 to 100' };
      return { level: 'normal', note: 'In the normal range' };
    case 'spo2':
      if (a < 90) return { level: 'urgent', note: 'Oxygen level is low' };
      if (a <= 92) return { level: 'doctor', note: 'Oxygen level below 93%' };
      if (a <= 94) return { level: 'watch', note: 'Slightly low oxygen' };
      return { level: 'normal', note: 'In the normal range' };
    default:
      return { level: 'normal', note: '' };
  }
}

function fmt(r) {
  if (r.kind === 'bp') return `${Math.round(r.value1)}/${Math.round(r.value2)}`;
  if (r.kind === 'sugar') return Number(r.value1).toFixed(1);
  return String(Math.round(r.value1 * 10) / 10);
}

/** Slope of the last readings per day: positive = rising. */
function trend(rows) {
  const pts = rows.slice(-7).map((r) => [new Date(r.measured_at).getTime() / 86400000, r.value1]);
  if (pts.length < 3) return { dir: 'stable', slope: 0 };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  const num = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const den = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0) || 1;
  const slope = num / den;
  const rel = Math.abs(slope) / (Math.abs(my) || 1);
  return { dir: rel < 0.004 ? 'stable' : slope > 0 ? 'rising' : 'falling', slope };
}

function overview(patientId) {
  const profile = db.get('SELECT height_cm FROM patient_profiles WHERE user_id = ?', patientId) || {};
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    const rows = db.all('SELECT * FROM health_readings WHERE patient_id = ? AND kind = ? ORDER BY measured_at', patientId, kind);
    const last = rows.at(-1);
    out[kind] = { ...KINDS[kind], kind, rows, last, status: last ? classify(last, profile.height_cm) : null, trend: trend(rows) };
  }
  const levels = Object.values(out).filter((k) => k.status).map((k) => k.status.level);
  const worst = levels.sort((x, y) => LEVEL[y] - LEVEL[x])[0] || null;
  return { kinds: out, worst };
}

function weeklySummary(o) {
  const parts = [];
  const since = Date.now() - 7 * 86400000;
  for (const k of Object.values(o.kinds)) {
    const week = k.rows.filter((r) => new Date(r.measured_at).getTime() >= since);
    if (!week.length) continue;
    const avg = week.reduce((s, r) => s + r.value1, 0) / week.length;
    const avgText = k.kind === 'bp'
      ? `${Math.round(avg)}/${Math.round(week.reduce((s, r) => s + r.value2, 0) / week.length)}`
      : (Math.round(avg * 10) / 10).toString();
    parts.push(`${k.name}: ${week.length} reading${week.length > 1 ? 's' : ''}, average ${avgText} ${k.unit}, ${k.trend.dir}. ${k.status.note}.`);
  }
  if (!parts.length) return 'No readings this week yet. Log a reading to start your weekly summary.';
  const tail = o.worst === 'urgent' ? ' One reading needs urgent attention: call 999 or go to the nearest emergency department if you feel unwell.'
    : o.worst === 'doctor' ? ' Some readings are outside the normal range. Book a doctor to review them.'
    : ' Keep logging regularly so your doctor can see the trend.';
  return parts.join(' ') + tail;
}

module.exports = { KINDS, LEVEL_TEXT, classify, fmt, trend, overview, weeklySummary };
