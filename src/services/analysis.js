// Health analysis from the patient's own documents.
//
// 1. Read text from uploaded lab reports (PDF text layer, or OCR for photos).
// 2. Find known lab values (hemoglobin, sugar, HbA1c, cholesterol, creatinine, BP ...)
//    in English or Bangla wording.
// 3. Group values by month, compare with normal ranges, compute a 0-100 health score
//    per month, and predict next month with a weighted linear trend.
// This is decision support only: it never diagnoses.
const fs = require('fs');
const zlib = require('zlib');
const db = require('../db');

// key: name, unit, normal range [low, high], patterns (number follows the label)
const MARKERS = {
  hemoglobin: { name: 'Hemoglobin', unit: 'g/dL', low: 12, high: 17, re: /(?:ha?emoglobin|\bhb\b|\bhgb\b|হিমোগ্লোবিন)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  glucose: { name: 'Blood sugar (fasting)', unit: 'mmol/L', low: 3.9, high: 6.1, re: /(?:fasting\s*(?:blood\s*)?(?:sugar|glucose)|\bfbs\b|blood\s*sugar|glucose|সুগার|ডায়াবেটিস)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i, convert: (v) => (v > 35 ? Math.round((v / 18) * 10) / 10 : v) },
  hba1c: { name: 'HbA1c', unit: '%', low: 4, high: 5.7, re: /(?:hba1c|a1c|glycated)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  cholesterol: { name: 'Total cholesterol', unit: 'mg/dL', low: 120, high: 200, re: /(?:total\s*cholesterol|cholesterol|কোলেস্টেরল)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  ldl: { name: 'LDL cholesterol', unit: 'mg/dL', low: 0, high: 130, re: /\bldl\b[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  hdl: { name: 'HDL cholesterol', unit: 'mg/dL', low: 40, high: 90, re: /\bhdl\b[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  triglycerides: { name: 'Triglycerides', unit: 'mg/dL', low: 0, high: 150, re: /(?:triglycerides?|\btg\b)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  creatinine: { name: 'Serum creatinine', unit: 'mg/dL', low: 0.6, high: 1.3, re: /(?:s(?:erum)?\.?\s*creatinine|creatinine|ক্রিয়েটিনিন)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  tsh: { name: 'TSH', unit: 'mIU/L', low: 0.4, high: 4.5, re: /\btsh\b[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  alt: { name: 'SGPT / ALT', unit: 'U/L', low: 7, high: 40, re: /(?:sgpt|\balt\b)[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  uric: { name: 'Uric acid', unit: 'mg/dL', low: 3.5, high: 7.2, re: /uric\s*acid[^\d\n]{0,25}(\d+(?:\.\d+)?)/i },
  systolic: { name: 'Blood pressure (top)', unit: 'mmHg', low: 90, high: 130, re: /(?:\bbp\b|blood\s*pressure|রক্তচাপ|প্রেশার)[^\d\n]{0,20}(\d{2,3})\s*\/\s*\d{2,3}/i },
  diastolic: { name: 'Blood pressure (bottom)', unit: 'mmHg', low: 60, high: 85, re: /(?:\bbp\b|blood\s*pressure|রক্তচাপ|প্রেশার)[^\d\n]{0,20}\d{2,3}\s*\/\s*(\d{2,3})/i },
  weight: { name: 'Weight', unit: 'kg', low: null, high: null, re: /(?:weight|\bwt\b|ওজন)[^\d\n]{0,15}(\d+(?:\.\d+)?)\s*kg/i },
};
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAscii = (t) => String(t || '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

/** Text from a simple PDF: decompress content streams and collect the strings drawn with Tj / TJ. */
function pdfText(buf) {
  const out = [];
  const src = buf.toString('latin1');
  const re = /<<([^>]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    if (/FlateDecode/.test(m[1])) { try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data); } catch { continue; } } }
    const s = data.toString('latin1');
    const lines = [];
    const tok = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ|T\*|Td|TD|ET/g;
    let t;
    let line = '';
    while ((t = tok.exec(s))) {
      const x = t[0];
      if (/^(T\*|Td|TD|ET)$/.test(x)) { if (line.trim()) lines.push(line); line = ''; continue; }
      const parts = x.match(/\((?:\\.|[^\\)])*\)/g) || [];
      line += parts.map((p) => p.slice(1, -1).replace(/\\([nrt()\\])/g, (_, c) => ({ n: '\n', r: '', t: ' ', '(': '(', ')': ')', '\\': '\\' })[c])).join('');
    }
    if (line.trim()) lines.push(line);
    out.push(...lines);
    re.lastIndex = end;
  }
  return out.join('\n');
}

async function readText(filePath, mimeType) {
  if (mimeType === 'application/pdf') {
    try { return { text: pdfText(fs.readFileSync(filePath)) }; } catch (e) { return { text: '', error: 'Could not read this PDF.' }; }
  }
  const { extractText } = require('./ocr');
  const r = await extractText(filePath, mimeType);
  return r.error ? { text: r.text || '', error: 'Could not read the photo automatically. Type the values below.' } : r;
}

/** Find lab values in free text. Returns [{ marker, value }]. */
function parseValues(raw) {
  const text = toAscii(raw);
  const found = [];
  for (const [key, def] of Object.entries(MARKERS)) {
    // Check each line so "HDL" is not read as part of "cholesterol" on another line.
    for (const line of text.split(/\n/)) {
      if (key === 'cholesterol' && /\b(ldl|hdl)\b/i.test(line)) continue;
      if (key === 'hemoglobin' && /a1c/i.test(line)) continue;
      if (key === 'glucose' && /a1c|hba/i.test(line)) continue;
      const m = line.match(def.re);
      if (m) {
        let v = Number(m[1]);
        if (def.convert) v = def.convert(v);
        if (Number.isFinite(v) && v > 0 && v < 2000) { found.push({ marker: key, value: v }); break; }
      }
    }
  }
  return found;
}

const statusOf = (key, v) => {
  const d = MARKERS[key];
  if (!d || d.low == null || v == null) return 'normal';
  if (v < d.low) return Math.abs(d.low - v) / d.low > 0.15 ? 'doctor' : 'watch';
  if (v > d.high) return (v - d.high) / d.high > 0.15 ? 'doctor' : 'watch';
  return 'normal';
};
/** 100 inside range, falling the further a value is outside it. */
function markerScore(key, v) {
  const d = MARKERS[key];
  if (!d || d.low == null) return null;
  if (v >= d.low && v <= d.high) return 100;
  const off = v < d.low ? (d.low - v) / Math.max(d.low, 1) : (v - d.high) / d.high;
  return Math.max(20, Math.round(100 - off * 160));
}

/** Least-squares line through the points, weighting recent months more. */
function predictNext(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return pts.length ? pts[0][1] : null;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  pts.forEach(([x, y], k) => { const w = 1 + k / pts.length; sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; });
  const slope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx || 1);
  const icpt = (sy - slope * sx) / sw;
  const next = icpt + slope * values.length;
  const last = pts[pts.length - 1][1];
  // Keep predictions sensible: within 30% of the last value.
  return Math.round(Math.min(last * 1.3, Math.max(last * 0.7, next)) * 10) / 10;
}

const monthKey = (d) => String(d).slice(0, 7);
const monthLabel = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
const nextMonth = (k) => { const d = new Date(`${k}-01T00:00:00`); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 7); };

/** Everything the analysis page needs for one patient. */
function analyze(patientId, months = 6) {
  // Lab values from documents + home readings (BP, sugar, weight) from Health Status.
  const rows = db.all('SELECT marker, value, measured_on FROM health_markers WHERE patient_id = ?', patientId);
  for (const r of db.all("SELECT kind, value1, value2, context, measured_at FROM health_readings WHERE patient_id = ? AND kind IN ('bp','sugar','weight')", patientId)) {
    if (r.kind === 'bp') { rows.push({ marker: 'systolic', value: r.value1, measured_on: r.measured_at }); rows.push({ marker: 'diastolic', value: r.value2, measured_on: r.measured_at }); }
    if (r.kind === 'sugar' && r.context === 'fasting') rows.push({ marker: 'glucose', value: r.value1, measured_on: r.measured_at });
    if (r.kind === 'weight') rows.push({ marker: 'weight', value: r.value1, measured_on: r.measured_at });
  }
  const now = new Date();
  const keys = [];
  for (let i = months - 1; i >= 0; i--) keys.push(new Date(now.getFullYear(), now.getMonth() - i, 15).toISOString().slice(0, 7));
  const byMarker = {};
  for (const r of rows) {
    const k = monthKey(r.measured_on);
    if (!keys.includes(k) || r.value == null) continue;
    ((byMarker[r.marker] = byMarker[r.marker] || {})[k] = byMarker[r.marker][k] || []).push(r.value);
  }
  const markers = Object.entries(byMarker).filter(([key]) => MARKERS[key]).map(([key, perMonth]) => {
    const values = keys.map((k) => (perMonth[k] ? Math.round((perMonth[k].reduce((a, b) => a + b, 0) / perMonth[k].length) * 10) / 10 : null));
    const known = values.filter((v) => v != null);
    const latest = known[known.length - 1];
    const prev = known.length > 1 ? known[known.length - 2] : null;
    const predicted = predictNext(values);
    const d = MARKERS[key];
    const towards = (v) => (d.low == null ? 0 : v < d.low ? d.low - v : v > d.high ? v - d.high : 0);
    const trend = prev == null ? 'new' : towards(latest) < towards(prev) ? 'better' : towards(latest) > towards(prev) ? 'worse' : 'same';
    return { key, ...d, values, latest, prev, predicted, status: statusOf(key, latest), predictedStatus: statusOf(key, predicted), trend, count: known.length };
  }).sort((a, b) => ({ doctor: 0, watch: 1, normal: 2 }[a.status] - { doctor: 0, watch: 1, normal: 2 }[b.status]) || b.count - a.count);

  // Monthly health score: average of marker scores that month.
  const score = keys.map((k, i) => {
    const s = markers.map((m) => (m.values[i] != null ? markerScore(m.key, m.values[i]) : null)).filter((x) => x != null);
    return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
  });
  const predictedScore = (() => {
    const s = markers.map((m) => (m.predicted != null ? markerScore(m.key, m.predicted) : null)).filter((x) => x != null);
    return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
  })();
  const labels = keys.map(monthLabel);
  return { keys, labels, nextLabel: monthLabel(nextMonth(keys[keys.length - 1])), markers, score, predictedScore, latestScore: [...score].reverse().find((x) => x != null) ?? null };
}

module.exports = { MARKERS, readText, parseValues, analyze, statusOf, pdfText, predictNext };
