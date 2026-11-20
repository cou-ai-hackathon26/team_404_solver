// Blood bank: ABO/Rh compatibility, donor eligibility and nearest-donor matching.
const db = require('../db');
const { notify } = require('./notify');
const { distanceKm } = require('./geo');

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// recipient -> donor groups that can give red cells to them
const COMPATIBLE = {
  'O-': ['O-'],
  'O+': ['O+', 'O-'],
  'A-': ['A-', 'O-'],
  'A+': ['A+', 'A-', 'O+', 'O-'],
  'B-': ['B-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'],
  'AB-': ['AB-', 'A-', 'B-', 'O-'],
  'AB+': GROUPS,
};
const GAP_DAYS = 120; // 4 months between whole-blood donations

function nextEligible(lastDonation) {
  if (!lastDonation) return null;
  const d = new Date(lastDonation);
  d.setDate(d.getDate() + GAP_DAYS);
  return d > new Date() ? d : null;
}

/** Notify compatible, eligible, available donors, nearest first. Returns how many were notified. */
function matchAndNotify(requestId, limit = 25) {
  const r = db.get('SELECT * FROM blood_requests WHERE id = ?', requestId);
  if (!r || r.status !== 'open') return 0;
  const groups = COMPATIBLE[r.blood_group] || [];
  const ph = groups.map(() => '?').join(',');
  const donors = db
    .all(`SELECT d.*, u.full_name FROM blood_donors d JOIN users u ON u.id = d.user_id
           WHERE d.available = 1 AND u.status = 'active' AND d.user_id <> ? AND d.blood_group IN (${ph})`, r.requester_id, ...groups)
    .filter((d) => !nextEligible(d.last_donation))
    .map((d) => ({ ...d, distance: distanceKm(r.lat, r.lng, d.lat, d.lng) }))
    .sort((a, b) => (a.blood_group === r.blood_group ? 0 : 1) - (b.blood_group === r.blood_group ? 0 : 1) || (a.distance ?? 999) - (b.distance ?? 999))
    .slice(0, limit);
  let n = 0;
  for (const d of donors) {
    const res = db.run('INSERT OR IGNORE INTO blood_responses (request_id, donor_id, distance) VALUES (?, ?, ?)', r.id, d.user_id, d.distance);
    if (res.changes) {
      n++;
      notify(d.user_id, `${r.urgency === 'urgent' ? 'URGENT: ' : ''}${r.blood_group} blood needed`,
        `${r.units} unit(s) at ${r.hospital}${d.distance != null ? ` · ${d.distance} km away` : ''}. Can you donate?`, '/blood', 'blood');
    }
  }
  return n;
}

/** Eligible donors who can give to `group`: available, compatible and 4+ months since their last donation. */
function searchDonors({ group, lat, lng, excludeId }) {
  const groups = group ? COMPATIBLE[group] || [] : GROUPS;
  const ph = groups.map(() => '?').join(',');
  return db.all(`SELECT d.*, u.full_name, u.phone AS account_phone FROM blood_donors d JOIN users u ON u.id = d.user_id
                  WHERE d.available = 1 AND u.status = 'active' AND d.user_id <> ? AND d.blood_group IN (${ph})`, excludeId || 0, ...groups)
    .filter((d) => !nextEligible(d.last_donation))
    .map((d) => ({ ...d, phone: d.show_phone ? d.phone || d.account_phone : null, exact: d.blood_group === group, distance: distanceKm(lat, lng, d.lat, d.lng),
      since: d.last_donation ? Math.floor((Date.now() - new Date(d.last_donation)) / 86400000) : null }))
    .sort((a, b) => (b.exact - a.exact) || ((a.distance ?? 999) - (b.distance ?? 999)));
}

module.exports = { GROUPS, COMPATIBLE, GAP_DAYS, nextEligible, matchAndNotify, searchDonors };
