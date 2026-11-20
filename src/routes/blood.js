// Blood bank: donor registry, requests, compatible-donor matching and responses.
// Open to patients and doctors. A donor's phone number is shared only after they accept.
const express = require('express');
const db = require('../db');
const { requireRole, notFound } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const blood = require('../services/blood');

const router = express.Router();
const allow = requireRole('patient', 'doctor');

router.get('/blood', allow, (req, res) => {
  const id = req.user.id;
  const donor = db.get('SELECT * FROM blood_donors WHERE user_id = ?', id);
  const profile = db.get('SELECT blood_group, lat, lng, live_lat, live_lng, address FROM patient_profiles WHERE user_id = ?', id) || {};
  const incoming = db.all(`SELECT s.*, r.blood_group, r.units, r.hospital, r.urgency, r.needed_by, r.patient_name, r.contact_phone, r.status AS req_status, r.created_at AS asked_at
                             FROM blood_responses s JOIN blood_requests r ON r.id = s.request_id WHERE s.donor_id = ? ORDER BY (r.status = 'open') DESC, s.id DESC LIMIT 10`, id);
  const mine = db.all('SELECT * FROM blood_requests WHERE requester_id = ? ORDER BY id DESC LIMIT 10', id).map((r) => ({
    ...r,
    responses: db.all(`SELECT s.*, u.full_name, u.phone, d.blood_group FROM blood_responses s JOIN users u ON u.id = s.donor_id JOIN blood_donors d ON d.user_id = s.donor_id
                        WHERE s.request_id = ? ORDER BY (s.status = 'accepted') DESC, s.distance`, r.id),
  }));
  const all = db.all('SELECT blood_group g, last_donation FROM blood_donors WHERE available = 1');
  const counts = {};
  for (const d of all) if (!blood.nextEligible(d.last_donation)) counts[d.g] = (counts[d.g] || 0) + 1;
  const q = { group: blood.GROUPS.includes(req.query.group) ? req.query.group : '', hospital: String(req.query.hospital || '').slice(0, 120), patient: String(req.query.patient || '').slice(0, 80) };
  const me = { lat: profile.live_lat ?? profile.lat, lng: profile.live_lng ?? profile.lng };
  const results = q.group ? blood.searchDonors({ group: q.group, lat: me.lat, lng: me.lng, excludeId: id }) : null;
  if (q.group) audit(req, 'blood.search', { details: { group: q.group, found: results.length } });
  const donations = db.all('SELECT * FROM blood_donations WHERE donor_id = ? ORDER BY donated_on DESC LIMIT 10', id);
  const open = db.get("SELECT COUNT(*) n FROM blood_requests WHERE status = 'open'").n;
  res.render('shared/blood', {
    title: 'Blood bank', donor, profile, incoming, mine, counts, open, GROUPS: blood.GROUPS, COMPATIBLE: blood.COMPATIBLE,
    nextEligible: donor ? blood.nextEligible(donor.last_donation) : null, gap: blood.GAP_DAYS, q, results, donations, me,
  });
});

router.post('/blood/donor', allow, (req, res) => {
  const b = req.body;
  if (!blood.GROUPS.includes(b.blood_group)) { req.flash('error', 'Choose your blood group.'); return res.redirect('/blood'); }
  const profile = db.get('SELECT lat, lng FROM patient_profiles WHERE user_id = ?', req.user.id) || {};
  const lat = b.lat !== '' && !isNaN(Number(b.lat)) ? Number(b.lat) : profile.lat ?? null;
  const lng = b.lng !== '' && !isNaN(Number(b.lng)) ? Number(b.lng) : profile.lng ?? null;
  const last = /^\d{4}-\d{2}-\d{2}$/.test(b.last_donation || '') && new Date(b.last_donation) <= new Date() ? b.last_donation : null;
  const phone = /^\+?[0-9 -]{7,20}$/.test(String(b.phone || '').trim()) ? String(b.phone).trim() : req.user.phone;
  db.run(`INSERT INTO blood_donors (user_id, blood_group, lat, lng, area, last_donation, available, phone, show_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET blood_group = excluded.blood_group, lat = excluded.lat, lng = excluded.lng, area = excluded.area, last_donation = excluded.last_donation,
            available = excluded.available, phone = excluded.phone, show_phone = excluded.show_phone`,
    req.user.id, b.blood_group, lat, lng, String(b.area || '').slice(0, 80) || null, last, b.available ? 1 : 0, phone, b.show_phone ? 1 : 0);
  if (last && !db.get('SELECT 1 FROM blood_donations WHERE donor_id = ? AND donated_on = ?', req.user.id, last)) db.run('INSERT INTO blood_donations (donor_id, donated_on) VALUES (?, ?)', req.user.id, last);
  const next = blood.nextEligible(last);
  req.flash('success', `Donor profile saved. Thank you for helping.${next ? ` You will appear in searches again from ${next.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : ''}`);
  res.redirect('/blood');
});

// A donor records the date they gave blood. They are hidden from searches for the next 4 months.
router.post('/blood/donated', allow, (req, res) => {
  const donor = db.get('SELECT * FROM blood_donors WHERE user_id = ?', req.user.id);
  if (!donor) { req.flash('error', 'Register as a donor first.'); return res.redirect('/blood'); }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.donated_on || '') ? req.body.donated_on : new Date().toISOString().slice(0, 10);
  if (new Date(date) > new Date()) { req.flash('error', 'The donation date cannot be in the future.'); return res.redirect('/blood'); }
  db.run('INSERT INTO blood_donations (donor_id, donated_on, place) VALUES (?, ?, ?)', req.user.id, date, String(req.body.place || '').slice(0, 120) || null);
  const latest = db.get('SELECT MAX(donated_on) d FROM blood_donations WHERE donor_id = ?', req.user.id).d;
  db.run('UPDATE blood_donors SET last_donation = ?, donations = donations + 1 WHERE user_id = ?', latest, req.user.id);
  const next = blood.nextEligible(latest);
  req.flash('success', `Thank you for donating! ${next ? `You can donate again from ${next.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} (4 months).` : ''}`);
  res.redirect('/blood');
});

router.post('/blood/requests', allow, (req, res) => {
  const b = req.body;
  const errors = [];
  if (!blood.GROUPS.includes(b.blood_group)) errors.push('Choose the blood group needed.');
  const units = parseInt(b.units, 10);
  if (!(units >= 1 && units <= 10)) errors.push('Units must be between 1 and 10.');
  if (!String(b.hospital || '').trim()) errors.push('Enter the hospital.');
  if (!/^\+?[0-9 -]{7,20}$/.test(String(b.contact_phone || '').trim())) errors.push('Enter a contact phone number.');
  if (!String(b.patient_name || '').trim()) errors.push('Enter the patient name.');
  if (errors.length) { req.flash('error', errors.join(' ')); return res.redirect('/blood#request'); }
  const profile = db.get('SELECT lat, lng FROM patient_profiles WHERE user_id = ?', req.user.id) || {};
  const lat = b.lat !== '' && !isNaN(Number(b.lat)) ? Number(b.lat) : profile.lat ?? null;
  const lng = b.lng !== '' && !isNaN(Number(b.lng)) ? Number(b.lng) : profile.lng ?? null;
  const { id } = db.run(`INSERT INTO blood_requests (requester_id, patient_name, blood_group, units, hospital, lat, lng, needed_by, urgency, contact_phone, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, String(b.patient_name).trim().slice(0, 80), b.blood_group, units, String(b.hospital).trim().slice(0, 120), lat, lng, b.needed_by || null,
    b.urgency === 'urgent' ? 'urgent' : 'normal', String(b.contact_phone).trim(), String(b.note || '').slice(0, 300) || null);
  const n = blood.matchAndNotify(id);
  audit(req, 'blood.request_created', { entity: 'blood_request', entityId: id, details: { group: b.blood_group, notified: n } });
  req.flash(n ? 'success' : 'error', n ? `Request posted. ${n} compatible donor${n > 1 ? 's' : ''} nearby were notified.` : 'Request posted, but no eligible compatible donor was found yet. We will keep it open; also contact your nearest blood bank.');
  res.redirect('/blood#mine');
});

router.post('/blood/responses/:id/:action(accept|decline|donated)', allow, (req, res) => {
  const s = db.get('SELECT s.*, r.requester_id, r.blood_group, r.hospital, r.status AS req_status FROM blood_responses s JOIN blood_requests r ON r.id = s.request_id WHERE s.id = ?', req.params.id);
  if (!s) return notFound(res, 'Request');
  const act = req.params.action;
  if (act === 'donated') {
    if (s.requester_id !== req.user.id || s.status !== 'accepted') return notFound(res, 'Accepted donor');
    db.run("UPDATE blood_responses SET status = 'donated' WHERE id = ?", s.id);
    db.run('UPDATE blood_donors SET last_donation = ?, donations = donations + 1 WHERE user_id = ?', new Date().toISOString().slice(0, 10), s.donor_id);
    notify(s.donor_id, 'Thank you for donating', `Your donation at ${s.hospital} was confirmed. You can donate again in ${blood.GAP_DAYS} days.`, '/blood', 'blood');
    req.flash('success', 'Marked as donated. The donor has been thanked.');
    return res.redirect('/blood#mine');
  }
  if (s.donor_id !== req.user.id || s.req_status !== 'open' || s.status !== 'notified') return notFound(res, 'Open request');
  db.run('UPDATE blood_responses SET status = ?, responded_at = ? WHERE id = ?', act === 'accept' ? 'accepted' : 'declined', db.now(), s.id);
  if (act === 'accept') {
    notify(s.requester_id, `A donor accepted your ${s.blood_group} request`, `${req.user.full_name} can donate. Their phone number is now visible in Blood Bank.`, '/blood#mine', 'blood');
    req.flash('success', 'Thank you! The family can now see your phone number and will contact you.');
  } else req.flash('success', 'No problem. We will not contact you about this request.');
  res.redirect('/blood');
});

router.post('/blood/requests/:id/:action(fulfilled|cancel|rematch)', allow, (req, res) => {
  const r = db.get('SELECT * FROM blood_requests WHERE id = ? AND requester_id = ?', req.params.id, req.user.id);
  if (!r || r.status !== 'open') return notFound(res, 'Open request');
  if (req.params.action === 'rematch') {
    const n = blood.matchAndNotify(r.id, 60);
    req.flash('success', n ? `${n} more donor${n > 1 ? 's' : ''} notified.` : 'No new eligible donors found right now.');
  } else {
    db.run('UPDATE blood_requests SET status = ? WHERE id = ?', req.params.action === 'cancel' ? 'cancelled' : 'fulfilled', r.id);
    req.flash('success', req.params.action === 'cancel' ? 'Request cancelled.' : 'Great news. Request marked as fulfilled.');
  }
  res.redirect('/blood#mine');
});

module.exports = router;
