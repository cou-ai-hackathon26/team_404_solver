// Pharmacy ratings and reviews from verified buyers (one review per delivered order).
const db = require('../db');

const ASPECTS = { availability: 'Availability', price: 'Price', delivery: 'Delivery', service: 'Service' };
const PRIOR_WEIGHT = 5; // Bayesian prior: a shop needs several reviews to move far from the average
const PRIOR_MEAN = 4.0;

/** Rating summary with a Bayesian average so one 5-star review cannot top the list. */
function summary(pharmacyId) {
  const rows = db.all('SELECT * FROM pharmacy_reviews WHERE pharmacy_id = ? AND hidden = 0', pharmacyId);
  const n = rows.length;
  const sum = rows.reduce((s, r) => s + r.overall, 0);
  const aspects = Object.fromEntries(Object.keys(ASPECTS).map((k) => [k, n ? rows.reduce((s, r) => s + r[k], 0) / n : null]));
  return {
    count: n,
    average: n ? sum / n : null,
    score: (PRIOR_WEIGHT * PRIOR_MEAN + sum) / (PRIOR_WEIGHT + n),
    aspects,
  };
}

// Light moderation: hide abusive reviews and mask phone numbers and emails.
const BLOCKED = ['fraud!!!', 'idiot', 'stupid', 'bastard', 'shala', 'kutta'];
function moderate(text) {
  let t = String(text || '').trim().slice(0, 600);
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email hidden]').replace(/(\+?88)?01[3-9]\d{8}/g, '[phone hidden]');
  const hidden = BLOCKED.some((w) => t.toLowerCase().includes(w));
  return { text: t, hidden };
}

module.exports = { ASPECTS, summary, moderate };
