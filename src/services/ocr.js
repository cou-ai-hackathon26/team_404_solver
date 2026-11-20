// Prescription processing: OCR (tesseract.js, optional) + medicine name matching.
//
// tesseract.js downloads its English language data (~10 MB) the first time it runs,
// so the first scan needs internet access and takes longer. If OCR is unavailable
// or fails, the patient can type or correct the medicine names by hand.
const db = require('../db');

let ocrPausedUntil = 0;

async function extractText(filePath, mimeType) {
  if (!/^image\//.test(mimeType || '')) {
    return { text: '', error: 'Automatic reading works for images (JPG/PNG). Please type the medicines below.' };
  }
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch {
    return { text: '', error: 'OCR engine not installed. Please type the medicines below.' };
  }
  if (Date.now() < ocrPausedUntil) {
    return { text: '', error: 'Automatic reading is temporarily unavailable. Please type the medicines below.' };
  }
  let worker;
  let timer;
  try {
    // tesseract.js reports some failures (e.g. language data download) only through
    // errorHandler; without it the error is thrown inside the worker and crashes the
    // server. We turn those reports into a rejection, with an overall timeout.
    let fail;
    const failure = new Promise((_, reject) => (fail = reject));
    timer = setTimeout(() => fail(new Error('OCR timed out')), 90_000);
    worker = await Promise.race([
      Tesseract.createWorker('eng', 1, { errorHandler: (e) => fail(new Error(String(e))) }),
      failure,
    ]);
    const { data } = await Promise.race([worker.recognize(filePath), failure]);
    return { text: data.text || '' };
  } catch (e) {
    console.error('OCR failed:', String(e && e.message ? e.message : e).slice(0, 200));
    ocrPausedUntil = Date.now() + 10 * 60_000; // avoid piling up stuck workers when offline
    return { text: '', error: 'Could not read the image automatically (the first scan needs internet to download the OCR model). Please type or correct the medicines below.' };
  } finally {
    clearTimeout(timer);
    if (worker) worker.terminate().catch(() => {});
  }
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

/** Find the best catalog medicine for one line of text. */
function matchMedicine(line, medicines) {
  const words = line.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  let best = null;
  for (const med of medicines) {
    const brand = med.name.toLowerCase().split(/\s+/)[0];
    const generic = (med.brand || '').toLowerCase().split(/\s+/)[0];
    for (const w of words) {
      for (const target of [brand, generic]) {
        if (!target) continue;
        const dist = w === target ? 0 : levenshtein(w, target);
        const tolerance = target.length >= 7 ? 2 : 1;
        if (dist <= tolerance && (!best || dist < best.dist)) best = { med, dist };
      }
    }
  }
  return best ? best.med : null;
}

/** Turn free text (OCR output or typed list, one medicine per line) into prescription items. */
function parseMedicines(text) {
  const medicines = db.all('SELECT * FROM medicines');
  const items = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 3) continue;
    const med = matchMedicine(line, medicines);
    const dosage = (line.match(/\b\d\s*\+\s*\d\s*\+\s*\d\b/) || [null])[0];
    const qtyMatch = line.match(/(?:qty|x|×)\s*(\d{1,3})\b/i);
    if (!med && !/[a-z]{3,}/i.test(line)) continue;
    if (items.find((i) => med && i.medicine_id === med.id)) continue;
    items.push({
      raw_name: line.slice(0, 120),
      medicine_id: med ? med.id : null,
      medicine_name: med ? `${med.name} ${med.strength || ''}`.trim() : null,
      dose: dosage ? dosage.replace(/\s/g, '') : null,
      quantity: qtyMatch ? parseInt(qtyMatch[1], 10) : 10,
    });
  }
  return items;
}

module.exports = { extractText, parseMedicines };
