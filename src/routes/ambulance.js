// Ambulance service, like a ride app for emergencies.
//  - Ambulance owners register, get verified, go online and share their live GPS position.
//  - Patients see online ambulances near them on a live map, compare distance, ETA and fare,
//    and request one. The ambulance accepts and the patient tracks it until it arrives.
const express = require('express');
const db = require('../db');
const { requireRole, notFound } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { distanceKm } = require('../services/geo');
const H = require('../helpers');

const router = express.Router();
const owner = requireRole('ambulance');
const patient = requireRole('patient');
const ACTIVE = "('requested','accepted','on_the_way','arrived')";
const MIN_PER_KM = 2.5; // city ambulance with siren
const STATUS_TEXT = { requested: 'Waiting for the ambulance to accept', accepted: 'Accepted · getting ready', on_the_way: 'On the way to you', arrived: 'Ambulance has arrived', completed: 'Trip completed', declined: 'Declined', cancelled: 'Cancelled' };
const fresh = (at, mins = 10) => at && Date.now() - new Date(at) < mins * 60_000;
const fare = (a, d) => Math.round(a.base_fare + a.per_km * (d || 0));

/** Where the ambulance is now. Uses live GPS; if the driver's phone stopped sending, estimates it along the route. */
function positionOf(a, trip) {
  if (trip && trip.status === 'on_the_way' && !fresh(a.location_at, 1) && trip.start_lat != null && trip.pickup_lat != null) {
    const total = Math.max(4, (trip.distance || 2) * MIN_PER_KM) * 60_000;
    const k = Math.min(0.95, (Date.now() - new Date(trip.accepted_at || trip.updated_at)) / total);
    return { lat: trip.start_lat + (trip.pickup_lat - trip.start_lat) * k, lng: trip.start_lng + (trip.pickup_lng - trip.start_lng) * k, estimated: true };
  }
  return { lat: a.lat, lng: a.lng, estimated: !fresh(a.location_at) };
}
const point = (a, extra = {}) => ({ id: `a${a.id}`, kind: 'ambulance', live: fresh(a.location_at), lat: a.lat, lng: a.lng,
  popup: `<b>${H.esc(a.service_name)}</b><br>${H.esc(a.kind)} · ${H.esc(a.vehicle_no)}`, ...extra });

function nearby(me) {
  return db.all("SELECT a.*, u.phone AS owner_phone FROM ambulances a JOIN users u ON u.id = a.owner_user_id WHERE a.verified = 1 AND a.online = 1 AND u.status = 'active'")
    .map((a) => {
      const busy = db.get(`SELECT 1 FROM ambulance_requests WHERE ambulance_id = ? AND status IN ('accepted','on_the_way','arrived')`, a.id);
      const distance = distanceKm(me.lat, me.lng, a.lat, a.lng);
      return { ...a, busy: !!busy, distance, eta: distance != null ? Math.max(3, Math.round(distance * MIN_PER_KM + 2)) : null, fare: fare(a, distance) };
    })
    .sort((x, y) => (x.busy - y.busy) || ((x.distance ?? 999) - (y.distance ?? 999)));
}
const meOf = (userId) => {
  const p = db.get('SELECT * FROM patient_profiles WHERE user_id = ?', userId) || {};
  return { lat: p.live_lat ?? p.lat ?? null, lng: p.live_lng ?? p.lng ?? null, address: p.address, phone: null };
};

// ======================= Patient side (/emergency) =======================
router.get('/emergency', patient, (req, res) => {
  const me = meOf(req.user.id);
  const list = nearby(me);
  const active = db.get(`SELECT * FROM ambulance_requests WHERE patient_id = ? AND status IN ${ACTIVE} ORDER BY id DESC`, req.user.id);
  const history = db.all(`SELECT r.*, a.service_name, a.vehicle_no FROM ambulance_requests r JOIN ambulances a ON a.id = r.ambulance_id WHERE r.patient_id = ? ORDER BY r.id DESC LIMIT 5`, req.user.id);
  const points = [...(me.lat != null ? [{ id: 'me', kind: 'me', lat: me.lat, lng: me.lng, label: 'You' }] : []), ...list.slice(0, 20).map((a) => point(a))];
  res.render('patient/emergency', { title: 'Ambulance', list, me, active, history, points, phone: req.user.phone });
});
router.get('/emergency/nearby', patient, (req, res) => {
  const me = meOf(req.user.id);
  res.json({ points: nearby(me).slice(0, 20).map((a) => point(a)) });
});
router.post('/emergency/request', patient, (req, res) => {
  const b = req.body;
  const lat = Number(b.lat), lng = Number(b.lng);
  const me = Number.isFinite(lat) && b.lat !== '' ? { lat, lng } : meOf(req.user.id);
  if (me.lat == null) { req.flash('error', 'Allow location or add your address so the ambulance can find you.'); return res.redirect('/emergency'); }
  if (db.get(`SELECT 1 FROM ambulance_requests WHERE patient_id = ? AND status IN ${ACTIVE}`, req.user.id)) { req.flash('error', 'You already have an active ambulance request.'); return res.redirect('/emergency'); }
  const list = nearby(me).filter((a) => !a.busy);
  const a = b.ambulance_id === 'nearest' ? list[0] : list.find((x) => x.id === Number(b.ambulance_id));
  if (!a) { req.flash('error', 'That ambulance is no longer available. Choose another, or call 999.'); return res.redirect('/emergency'); }
  const { id } = db.run(`INSERT INTO ambulance_requests (patient_id, ambulance_id, pickup_lat, pickup_lng, pickup_address, destination, phone, note, distance, fare)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.id, a.id, me.lat, me.lng, String(b.pickup_address || '').slice(0, 200) || meOf(req.user.id).address,
  String(b.destination || '').slice(0, 200) || null, String(b.phone || req.user.phone || '').slice(0, 20), String(b.note || '').slice(0, 300) || null, a.distance, a.fare);
  notify(a.owner_user_id, 'EMERGENCY: ambulance requested', `${req.user.full_name} needs an ambulance ${a.distance != null ? a.distance + ' km away' : ''}. Accept now.`, '/ambulance', 'ambulance');
  audit(req, 'ambulance.requested', { entity: 'ambulance_request', entityId: id, patientId: req.user.id });
  req.flash('success', `Request sent to ${a.service_name}. Stay on this page; you will see it moving towards you.`);
  res.redirect(`/emergency/trips/${id}`);
});
function myTrip(req) {
  return db.get(`SELECT r.*, a.service_name, a.vehicle_no, a.kind, a.driver_name, a.driver_phone, a.lat, a.lng, a.location_at, a.owner_user_id
                   FROM ambulance_requests r JOIN ambulances a ON a.id = r.ambulance_id WHERE r.id = ? AND r.patient_id = ?`, req.params.id, req.user.id);
}
function tripPoints(t) {
  const pos = positionOf(t, t);
  return [{ id: 'pickup', kind: 'me', lat: t.pickup_lat, lng: t.pickup_lng, label: 'Pickup (you)' },
    { id: 'amb', kind: 'ambulance', live: !pos.estimated, lat: pos.lat, lng: pos.lng, popup: `<b>${H.esc(t.service_name)}</b><br>${H.esc(t.vehicle_no)}` }];
}
router.get('/emergency/trips/:id', patient, (req, res) => {
  const t = myTrip(req);
  if (!t) return notFound(res, 'Ambulance request');
  const pos = positionOf(t, t);
  const away = distanceKm(pos.lat, pos.lng, t.pickup_lat, t.pickup_lng);
  res.render('patient/emergency-trip', { title: 'Ambulance tracking', t, points: tripPoints(t), away, STATUS_TEXT, eta: away != null ? Math.max(1, Math.round(away * MIN_PER_KM + 1)) : null });
});
router.get('/emergency/trips/:id/poll', patient, (req, res) => {
  const t = myTrip(req);
  if (!t) return res.status(404).json({});
  res.json({ points: tripPoints(t), status: STATUS_TEXT[t.status], reload: true });
});
router.post('/emergency/trips/:id/cancel', patient, (req, res) => {
  const t = myTrip(req);
  if (!t || !['requested', 'accepted', 'on_the_way'].includes(t.status)) return notFound(res, 'Active request');
  db.run("UPDATE ambulance_requests SET status = 'cancelled', updated_at = ? WHERE id = ?", db.now(), t.id);
  notify(t.owner_user_id, 'Ambulance request cancelled', `${req.user.full_name} cancelled the request.`, '/ambulance', 'ambulance');
  req.flash('success', 'Request cancelled.');
  res.redirect('/emergency');
});

// ======================= Ambulance owner portal (/ambulance) =======================
const mine = (req) => db.get('SELECT * FROM ambulances WHERE owner_user_id = ?', req.user.id);
const tripSql = `SELECT r.*, u.full_name AS patient_name, u.phone AS patient_phone FROM ambulance_requests r JOIN users u ON u.id = r.patient_id`;

router.get('/ambulance', owner, (req, res) => {
  const a = mine(req);
  const incoming = db.all(`${tripSql} WHERE r.ambulance_id = ? AND r.status = 'requested' ORDER BY r.id DESC`, a.id);
  const active = db.get(`${tripSql} WHERE r.ambulance_id = ? AND r.status IN ('accepted','on_the_way','arrived') ORDER BY r.id DESC`, a.id);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const s = db.get(`SELECT COUNT(*) n, SUM(fare) f FROM ambulance_requests WHERE ambulance_id = ? AND status = 'completed'`, a.id);
  const t = db.get(`SELECT COUNT(*) n, SUM(fare) f FROM ambulance_requests WHERE ambulance_id = ? AND status = 'completed' AND updated_at >= ?`, a.id, today.toISOString());
  const points = [{ id: `a${a.id}`, kind: 'ambulance', live: fresh(a.location_at), lat: a.lat, lng: a.lng, label: 'You' }];
  const target = active || incoming[0];
  if (target) points.push({ id: 'pickup', kind: 'me', lat: target.pickup_lat, lng: target.pickup_lng, label: `Pickup: ${target.patient_name}` });
  const stats = require('../stats');
  const cards = [
    { tile: a.online ? 't-teal' : 't-orange', icon: 'ambulance', color: a.online ? 'teal' : 'orange', label: 'Status', value: a.online ? 'Online' : 'Offline', sub: a.online ? 'Patients can find you' : 'Go online to get requests', trend: stats.daily('SELECT created_at AS t FROM ambulance_requests WHERE ambulance_id = ?', [a.id]) },
    { tile: 't-red', icon: 'bell', color: 'red', label: 'New requests', value: incoming.length, sub: 'Waiting for you', trend: stats.daily("SELECT created_at AS t FROM ambulance_requests WHERE ambulance_id = ?", [a.id]) },
    { tile: 't-blue', icon: 'nav', color: 'blue', label: 'Trips today', value: t.n || 0, sub: `${s.n || 0} in total`, trend: stats.daily("SELECT updated_at AS t FROM ambulance_requests WHERE ambulance_id = ? AND status = 'completed'", [a.id]) },
    { tile: 't-purple', icon: 'wallet', color: 'purple', label: 'Earned today', value: H.money(t.f || 0), sub: `${H.money(s.f || 0)} in total`, trend: stats.daily("SELECT updated_at AS t FROM ambulance_requests WHERE ambulance_id = ? AND status = 'completed'", [a.id]) },
  ];
  res.render('ambulance/dashboard', { title: a.service_name, a, incoming, active, points, cards, live: fresh(a.location_at), STATUS_TEXT });
});
router.get('/ambulance/poll', owner, (req, res) => {
  const a = mine(req);
  const n = db.get("SELECT COUNT(*) n FROM ambulance_requests WHERE ambulance_id = ? AND status IN ('requested','accepted','on_the_way','arrived')", a.id).n;
  res.json({ points: [{ id: `a${a.id}`, kind: 'ambulance', live: fresh(a.location_at), lat: a.lat, lng: a.lng, label: 'You' }], status: `${n} active`, reload: true });
});
router.post('/ambulance/online', owner, (req, res) => {
  const a = mine(req);
  const on = req.body.on === '1' ? 1 : 0;
  if (on && db.get("SELECT 1 FROM users WHERE id = ? AND status <> 'active'", req.user.id)) return res.redirect('/ambulance');
  db.run('UPDATE ambulances SET online = ? WHERE id = ?', on, a.id);
  req.flash('success', on ? 'You are online. Keep this page open so patients see your live location.' : 'You are offline. Patients will not see you.');
  res.redirect('/ambulance');
});
router.post('/ambulance/requests/:id/:action(accept|decline|on_the_way|arrived|completed)', owner, (req, res) => {
  const a = mine(req);
  const r = db.get(`${tripSql} WHERE r.id = ? AND r.ambulance_id = ?`, req.params.id, a.id);
  if (!r) return notFound(res, 'Request');
  const act = req.params.action;
  const FLOW = { accept: ['requested', 'accepted'], decline: ['requested', 'declined'], on_the_way: ['accepted', 'on_the_way'], arrived: ['on_the_way', 'arrived'], completed: ['arrived', 'completed'] };
  const [from, to] = FLOW[act];
  if (r.status !== from && !(act === 'arrived' && r.status === 'accepted')) { req.flash('error', 'This request has already moved on.'); return res.redirect('/ambulance'); }
  if (act === 'accept' && db.get("SELECT 1 FROM ambulance_requests WHERE ambulance_id = ? AND status IN ('accepted','on_the_way','arrived')", a.id)) {
    req.flash('error', 'Finish your current trip before accepting another.'); return res.redirect('/ambulance');
  }
  if (act === 'accept' || act === 'on_the_way') db.run('UPDATE ambulance_requests SET start_lat = ?, start_lng = ?, accepted_at = ? WHERE id = ?', a.lat, a.lng, db.now(), r.id);
  db.run('UPDATE ambulance_requests SET status = ?, updated_at = ? WHERE id = ?', to, db.now(), r.id);
  const MSG = {
    accept: ['Ambulance accepted', `${a.service_name} (${a.vehicle_no}) accepted. Driver: ${a.driver_name || ''} ${a.driver_phone || ''}`],
    decline: ['Ambulance unavailable', `${a.service_name} cannot come. Please request another ambulance now.`],
    on_the_way: ['Ambulance on the way', `${a.service_name} is coming to you. Track it live.`],
    arrived: ['Ambulance has arrived', `${a.service_name} is at your pickup point.`],
    completed: ['Trip completed', `Fare ${H.money(r.fare)}. Get well soon.`],
  }[act];
  notify(r.patient_id, MSG[0], MSG[1], act === 'decline' ? '/emergency' : `/emergency/trips/${r.id}`, 'ambulance');
  req.flash('success', { accept: 'Accepted. Tap “Start trip” when you leave.', decline: 'Declined.', on_the_way: 'Trip started. The patient can see you moving.', arrived: 'Marked as arrived.', completed: 'Trip completed.' }[act]);
  res.redirect('/ambulance');
});
router.get('/ambulance/trips', owner, (req, res) => {
  const a = mine(req);
  const trips = db.all(`${tripSql} WHERE r.ambulance_id = ? ORDER BY r.id DESC LIMIT 100`, a.id);
  res.render('ambulance/trips', { title: 'Trips', trips, STATUS_TEXT });
});
router.get('/ambulance/profile', owner, (req, res) => res.render('ambulance/profile', { title: 'Vehicle & profile', a: mine(req) }));
router.post('/ambulance/profile', owner, (req, res) => {
  const b = req.body;
  const coord = (v) => (v === '' || v === undefined || isNaN(Number(v)) ? null : Number(v));
  db.run(`UPDATE ambulances SET service_name = ?, kind = ?, driver_name = ?, driver_phone = ?, base_area = ?, base_fare = ?, per_km = ?, lat = COALESCE(?, lat), lng = COALESCE(?, lng) WHERE owner_user_id = ?`,
    String(b.service_name || '').trim() || 'Ambulance', ['Non-AC', 'AC', 'ICU / Life support', 'Freezer van'].includes(b.kind) ? b.kind : 'Non-AC', b.driver_name || null, b.driver_phone || null,
    b.base_area || null, Math.max(0, parseInt(b.base_fare, 10) || 0), Math.max(0, parseInt(b.per_km, 10) || 0), coord(b.lat), coord(b.lng), req.user.id);
  req.flash('success', 'Profile saved.');
  res.redirect('/ambulance/profile');
});

module.exports = router;
