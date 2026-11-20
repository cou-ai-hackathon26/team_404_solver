// Pharmacy portal: orders (accept, partial, reject), status updates, delivery
// riders, stock and prices, payments, ratings and reviews.
const express = require('express');
const db = require('../db');
const { requireRole, notFound } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');
const { distanceKm } = require('../services/geo');
const reviews = require('../services/reviews');
const stats = require('../stats');
const H = require('../helpers');

const router = express.Router();
router.use(requireRole('pharmacy'));
router.use((req, res, next) => {
  if (!req.user.pharmacyId) return res.status(403).render('shared/error', { title: 'No pharmacy', message: 'Your account is not linked to a pharmacy.' });
  res.locals.pharmacy = db.get('SELECT * FROM pharmacies WHERE id = ?', req.user.pharmacyId);
  next();
});
const FLOW = ['received', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
const LOW = 30;
const listSql = `SELECT o.*, u.full_name AS patient_name, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS n,
                   (SELECT COUNT(*) FROM order_items i LEFT JOIN pharmacy_stock s ON s.medicine_id = i.medicine_id AND s.pharmacy_id = o.pharmacy_id WHERE i.order_id = o.id AND COALESCE(s.quantity, 0) < i.quantity) AS short,
                   p.verified AS rx_verified, p.source AS rx_source FROM orders o JOIN users u ON u.id = o.patient_id LEFT JOIN prescriptions p ON p.id = o.prescription_id`;
const addHistory = (orderId, status, note) => db.run('INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)', orderId, status, note || null);

// =============== Dashboard ===============
router.get('/', (req, res) => {
  const p = req.user.pharmacyId;
  const n = (sql, ...a) => db.get(sql, ...a).n;
  const s = {
    newOrders: n("SELECT COUNT(*) n FROM orders WHERE pharmacy_id = ? AND status = 'received'", p),
    preparing: n("SELECT COUNT(*) n FROM orders WHERE pharmacy_id = ? AND status IN ('preparing','ready')", p),
    out: n("SELECT COUNT(*) n FROM orders WHERE pharmacy_id = ? AND status = 'out_for_delivery'", p),
    low: n('SELECT COUNT(*) n FROM pharmacy_stock WHERE pharmacy_id = ? AND quantity < ?', p, LOW),
  };
  const cards = [
    { href: '/pharmacy/orders?f=received', tile: 't-blue', icon: 'pill', color: 'blue', label: 'New orders', value: s.newOrders, sub: 'Awaiting your response', trend: stats.daily('SELECT created_at AS t FROM orders WHERE pharmacy_id = ?', [p]) },
    { href: '/pharmacy/orders?f=preparing', tile: 't-orange', icon: 'flask', color: 'orange', label: 'Preparing', value: s.preparing, sub: 'Ready within 30 min', trend: stats.daily("SELECT created_at AS t FROM order_status_history WHERE status = 'preparing' AND order_id IN (SELECT id FROM orders WHERE pharmacy_id = ?)", [p]) },
    { href: '/pharmacy/delivery', tile: 't-purple', icon: 'message', color: 'purple', label: 'Out for delivery', value: s.out, sub: 'On the way', trend: stats.daily("SELECT created_at AS t FROM order_status_history WHERE status = 'out_for_delivery' AND order_id IN (SELECT id FROM orders WHERE pharmacy_id = ?)", [p]) },
    { href: '/pharmacy/stock?f=low', tile: 't-red', icon: 'shield', color: 'red', label: 'Low stock items', value: s.low, sub: 'Restock soon', trend: stats.daily('SELECT created_at AS t FROM orders WHERE pharmacy_id = ? AND partial = 1', [p]) },
  ];
  const chart = stats.monthly('SELECT created_at AS t FROM orders WHERE pharmacy_id = ?', [p]);
  const t = new Date();
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString();
  const todays = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM orders WHERE pharmacy_id = ? AND (created_at >= ? OR updated_at >= ?) GROUP BY status', p, start, start).map((r) => [r.status, r.n]));
  const ring = [
    { label: 'New', value: todays.received || 0, color: '#4f46e5' },
    { label: 'Preparing', value: (todays.preparing || 0) + (todays.ready || 0), color: '#f59e0b' },
    { label: 'Out for delivery', value: todays.out_for_delivery || 0, color: '#a855f7' },
    { label: 'Delivered', value: todays.delivered || 0, color: '#10b981' },
  ];
  const incoming = db.all(`${listSql} WHERE o.pharmacy_id = ? AND o.status IN ('received','preparing','ready') ORDER BY (o.status = 'received') DESC, o.created_at LIMIT 4`, p);
  const oldest = db.get(`${listSql} WHERE o.pharmacy_id = ? AND o.status = 'received' ORDER BY o.created_at`, p);
  const alerts = db.all('SELECT s.*, m.name, m.strength FROM pharmacy_stock s JOIN medicines m ON m.id = s.medicine_id WHERE s.pharmacy_id = ? ORDER BY s.quantity LIMIT 4', p);
  const rating = reviews.summary(p);
  res.render('pharmacy/dashboard', { title: 'Dashboard', s, cards, chart, ring, ringTotal: ring.reduce((a, b) => a + b.value, 0), incoming, oldest, alerts, rating, LOW });
});

// =============== Orders ===============
router.get('/orders', (req, res) => {
  const f = ['received', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'rejected'].includes(req.query.f) ? req.query.f : 'open';
  const where = f === 'open' ? "o.status NOT IN ('delivered','rejected','cancelled')" : 'o.status = ?';
  const orders = db.all(`${listSql} WHERE o.pharmacy_id = ? AND ${where} ORDER BY o.id DESC LIMIT 100`, req.user.pharmacyId, ...(f === 'open' ? [] : [f]));
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM orders WHERE pharmacy_id = ? GROUP BY status', req.user.pharmacyId).map((r) => [r.status, r.n]));
  res.render('pharmacy/orders', { title: 'Orders', orders, f, counts });
});
function myOrder(req, id) {
  return db.get(`SELECT o.*, u.full_name AS patient_name, u.phone AS patient_phone, pp.lat, pp.lng FROM orders o JOIN users u ON u.id = o.patient_id
                   LEFT JOIN patient_profiles pp ON pp.user_id = o.patient_id WHERE o.id = ? AND o.pharmacy_id = ?`, id, req.user.pharmacyId);
}
function orderItems(req, orderId) {
  return db.all(`SELECT oi.*, m.name, m.strength, m.rx_required, COALESCE(s.quantity, 0) AS stock FROM order_items oi JOIN medicines m ON m.id = oi.medicine_id
                   LEFT JOIN pharmacy_stock s ON s.medicine_id = oi.medicine_id AND s.pharmacy_id = ? WHERE oi.order_id = ?`, req.user.pharmacyId, orderId);
}
router.get('/orders/:id', (req, res) => {
  const order = myOrder(req, req.params.id);
  if (!order) return notFound(res, 'Order');
  const items = orderItems(req, order.id);
  const rx = order.prescription_id ? db.get('SELECT p.*, u.full_name AS doctor_name, d.specialty FROM prescriptions p LEFT JOIN users u ON u.id = p.doctor_id LEFT JOIN doctor_profiles d ON d.user_id = p.doctor_id WHERE p.id = ?', order.prescription_id) : null;
  const rxItems = rx ? db.all('SELECT i.*, m.name, m.strength FROM prescription_items i LEFT JOIN medicines m ON m.id = i.medicine_id WHERE i.prescription_id = ?', rx.id) : [];
  const history = db.all('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id', order.id);
  const needsRxCheck = items.some((i) => i.rx_required) && !order.prescription_checked;
  const fulfillable = items.filter((i) => Math.min(i.quantity, i.stock) > 0).length;
  const distance = distanceKm(res.locals.pharmacy.lat, res.locals.pharmacy.lng, order.lat, order.lng);
  if (rx) audit(req, 'prescription.viewed_by_pharmacy', { entity: 'prescription', entityId: rx.id, patientId: order.patient_id });
  res.render('pharmacy/order', { title: `Order ${H.code(order.id)}`, order, items, rx, rxItems, history, needsRxCheck, fulfillable, distance, FLOW });
});
// Accept fully or partly. Quantities can only go down from what was prescribed (pharmacies cannot change prescriptions).
router.post('/orders/:id/accept', (req, res) => {
  const order = myOrder(req, req.params.id);
  if (!order || order.status !== 'received' || order.accepted) return notFound(res, 'New order');
  const items = orderItems(req, order.id);
  if (items.some((i) => i.rx_required) && !order.prescription_checked && (!order.prescription_id || !req.body.prescription_verified)) {
    req.flash('error', 'This order has prescription-only medicines. Open the prescription and tick “Prescription checked” before accepting.');
    return res.redirect(`/pharmacy/orders/${order.id}`);
  }
  const partialOnly = req.body.mode === 'partial';
  let partial = false;
  const lines = items.map((i) => {
    const asked = parseInt(req.body[`qty_${i.id}`], 10);
    const qty = Math.max(0, Math.min(isNaN(asked) ? i.quantity : asked, i.quantity, i.stock));
    if (qty < i.quantity) partial = true;
    return { ...i, qty };
  });
  if (!lines.some((l) => l.qty > 0)) { req.flash('error', 'Nothing can be supplied from current stock. Reject the order instead.'); return res.redirect(`/pharmacy/orders/${order.id}`); }
  if (partial && !partialOnly) { req.flash('error', 'Some medicines are short. Use “Fulfill partly” so the patient knows.'); return res.redirect(`/pharmacy/orders/${order.id}`); }
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  db.tx(() => {
    for (const l of lines) {
      db.run('UPDATE order_items SET fulfilled_quantity = ? WHERE id = ?', l.qty, l.id);
      db.run('UPDATE pharmacy_stock SET quantity = MAX(0, quantity - ?), sold = sold + ?, updated_at = ? WHERE pharmacy_id = ? AND medicine_id = ?', l.qty, l.qty, db.now(), req.user.pharmacyId, l.medicine_id);
    }
    db.run("UPDATE orders SET accepted = 1, partial = ?, total = ?, status = 'preparing', prescription_checked = 1, pharmacy_note = ?, updated_at = ? WHERE id = ?",
      partial ? 1 : 0, subtotal + order.delivery_fee, String(req.body.note || '').slice(0, 300) || null, db.now(), order.id);
    addHistory(order.id, 'preparing', partial ? `Accepted, ${lines.filter((l) => l.qty > 0).length} of ${lines.length} medicines` : 'Accepted');
  });
  if (order.prescription_id) db.run('UPDATE prescriptions SET verified = 1 WHERE id = ?', order.prescription_id);
  audit(req, 'order.accepted', { entity: 'order', entityId: order.id, patientId: order.patient_id, details: { partial } });
  notify(order.patient_id, partial ? 'Order partly accepted' : 'Order accepted', `${res.locals.pharmacy.name} is preparing ${H.code(order.id)}${partial ? ' (some items unavailable)' : ''}. Total ${H.money(subtotal + order.delivery_fee)}.`, `/patient/orders/${order.id}`, 'order');
  req.flash('success', partial ? 'Order accepted with partial fulfilment. The patient was told.' : 'Order accepted.');
  res.redirect(`/pharmacy/orders/${order.id}`);
});
router.post('/orders/:id/reject', (req, res) => {
  const order = myOrder(req, req.params.id);
  if (!order || order.status !== 'received' || order.accepted) return notFound(res, 'New order');
  const note = String(req.body.note || '').trim().slice(0, 300) || 'Unable to fulfil';
  db.run("UPDATE orders SET status = 'rejected', pharmacy_note = ?, updated_at = ? WHERE id = ?", note, db.now(), order.id);
  addHistory(order.id, 'rejected', note);
  notify(order.patient_id, 'Order rejected', `${res.locals.pharmacy.name} could not fulfil ${H.code(order.id)}: ${note}`, `/patient/orders/${order.id}`, 'order');
  res.redirect(`/pharmacy/orders/${order.id}`);
});
router.post('/orders/:id/status', (req, res) => {
  const order = myOrder(req, req.params.id);
  if (!order || !order.accepted) return notFound(res, 'Accepted order');
  const next = FLOW[FLOW.indexOf(order.status) + 1];
  if (!next || req.body.status !== next) { req.flash('error', 'Statuses move forward one step at a time.'); return res.redirect(`/pharmacy/orders/${order.id}`); }
  if (next === 'out_for_delivery' && !String(req.body.rider_name || order.rider_name || '').trim()) { req.flash('error', 'Add the rider name before dispatch.'); return res.redirect(`/pharmacy/orders/${order.id}`); }
  const rider = String(req.body.rider_name || order.rider_name || '').trim().slice(0, 60) || null;
  const phone = String(req.body.rider_phone || order.rider_phone || '').trim().slice(0, 20) || null;
  const paid = next === 'delivered' && order.payment_method === 'cod' ? 'paid' : order.payment_status;
  db.run('UPDATE orders SET status = ?, payment_status = ?, rider_name = ?, rider_phone = ?, out_at = COALESCE(out_at, ?), updated_at = ? WHERE id = ?',
    next, paid, rider, phone, next === 'out_for_delivery' ? db.now() : null, db.now(), order.id);
  addHistory(order.id, next, next === 'out_for_delivery' ? `Rider: ${rider}` : req.body.note);
  notify(order.patient_id, `${H.code(order.id)}: ${H.label(next)}`, next === 'delivered' ? `Delivered by ${res.locals.pharmacy.name}. Rate your experience.` : `${res.locals.pharmacy.name} updated your order.`, `/patient/orders/${order.id}`, 'order');
  res.redirect(req.body.back === 'delivery' ? '/pharmacy/delivery' : `/pharmacy/orders/${order.id}`);
});

// =============== Medicines and stock ===============
router.get('/stock', (req, res) => {
  const p = req.user.pharmacyId;
  const f = ['low', 'out', 'expiring'].includes(req.query.f) ? req.query.f : 'all';
  const q = String(req.query.q || '').trim().toLowerCase();
  const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 7);
  let stock = db.all('SELECT s.*, m.name, m.brand, m.strength, m.form, m.rx_required FROM pharmacy_stock s JOIN medicines m ON m.id = s.medicine_id WHERE s.pharmacy_id = ? ORDER BY m.name', p);
  const all = stock;
  if (f === 'low') stock = stock.filter((s) => s.quantity > 0 && s.quantity < LOW);
  if (f === 'out') stock = stock.filter((s) => s.quantity === 0);
  if (f === 'expiring') stock = stock.filter((s) => s.expiry && s.expiry <= soon);
  if (q) stock = stock.filter((s) => `${s.name} ${s.brand}`.toLowerCase().includes(q));
  const edit = req.query.edit ? all.find((s) => s.id === Number(req.query.edit)) : null;
  const medicines = db.all('SELECT * FROM medicines WHERE id NOT IN (SELECT medicine_id FROM pharmacy_stock WHERE pharmacy_id = ?) ORDER BY name', p);
  const cards = [
    { tile: 't-blue', icon: 'pill', color: 'blue', label: 'Medicines listed', value: all.length, sub: 'In your catalogue', trend: stats.daily('SELECT created_at AS t FROM orders WHERE pharmacy_id = ?', [p]) },
    { tile: 't-orange', icon: 'bell', color: 'orange', label: 'Low stock', value: all.filter((s) => s.quantity > 0 && s.quantity < LOW).length, sub: 'Restock soon', trend: stats.daily("SELECT updated_at AS t FROM orders WHERE pharmacy_id = ? AND status = 'delivered'", [p]) },
    { tile: 't-red', icon: 'shield', color: 'red', label: 'Out of stock', value: all.filter((s) => s.quantity === 0).length, sub: 'Hidden from patients', trend: stats.daily('SELECT created_at AS t FROM orders WHERE pharmacy_id = ? AND partial = 1', [p]) },
    { tile: 't-purple', icon: 'calendar', color: 'purple', label: 'Expiring soon', value: all.filter((s) => s.expiry && s.expiry <= soon).length, sub: 'Within 60 days', trend: stats.daily('SELECT created_at AS t FROM pharmacy_reviews WHERE pharmacy_id = ?', [p]) },
  ];
  res.render('pharmacy/stock', { title: 'Medicines and stock', stock, edit, medicines, f, q, cards, LOW, soon });
});
router.post('/stock', (req, res) => {
  const p = req.user.pharmacyId;
  const med = db.get('SELECT id, name FROM medicines WHERE id = ?', req.body.medicine_id);
  const price = Number(req.body.price);
  const qty = parseInt(req.body.quantity, 10);
  if (!med || !(price >= 0) || !(qty >= 0)) { req.flash('error', 'Choose a medicine and enter a valid price and quantity.'); return res.redirect('/pharmacy/stock'); }
  const expiry = /^\d{4}-\d{2}$/.test(req.body.expiry || '') ? req.body.expiry : null;
  const discount = Math.min(90, Math.max(0, parseInt(req.body.discount_pct, 10) || 0));
  db.run(`INSERT INTO pharmacy_stock (pharmacy_id, medicine_id, price, quantity, expiry, deliverable, discount_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pharmacy_id, medicine_id) DO UPDATE SET price = excluded.price, quantity = excluded.quantity, expiry = excluded.expiry, deliverable = excluded.deliverable,
            discount_pct = excluded.discount_pct, updated_at = excluded.updated_at`,
    p, med.id, price, qty, expiry, req.body.deliverable ? 1 : 0, discount, db.now());
  req.flash('success', `${med.name} saved. Patients see the new stock and price when comparing.`);
  res.redirect('/pharmacy/stock');
});
// Quick live update from the counter: stock received, or a walk-in sale.
router.post('/stock/:id/adjust', (req, res) => {
  const s = db.get('SELECT s.*, m.name FROM pharmacy_stock s JOIN medicines m ON m.id = s.medicine_id WHERE s.id = ? AND s.pharmacy_id = ?', req.params.id, req.user.pharmacyId);
  const n = Math.abs(parseInt(req.body.amount, 10) || 0);
  if (!s || !n) { req.flash('error', 'Enter how many units.'); return res.redirect('/pharmacy/stock'); }
  if (req.body.kind === 'sold') {
    const sold = Math.min(n, s.quantity);
    db.run('UPDATE pharmacy_stock SET quantity = quantity - ?, sold = sold + ?, updated_at = ? WHERE id = ?', sold, sold, db.now(), s.id);
    req.flash('success', `${sold} × ${s.name} recorded as sold. ${s.quantity - sold} left.`);
  } else {
    db.run('UPDATE pharmacy_stock SET quantity = quantity + ?, updated_at = ? WHERE id = ?', n, db.now(), s.id);
    req.flash('success', `${n} × ${s.name} added. ${s.quantity + n} in stock.`);
  }
  res.redirect(req.get('referer') || '/pharmacy/stock');
});
router.get('/stock/live', (req, res) => {
  res.json({ rows: db.all('SELECT id, quantity, sold, updated_at FROM pharmacy_stock WHERE pharmacy_id = ?', req.user.pharmacyId) });
});
router.post('/stock/:id/delete', (req, res) => {
  db.run('DELETE FROM pharmacy_stock WHERE id = ? AND pharmacy_id = ?', req.params.id, req.user.pharmacyId);
  res.redirect('/pharmacy/stock');
});

// =============== Delivery ===============
router.get('/delivery', (req, res) => {
  const ready = db.all(`${listSql} WHERE o.pharmacy_id = ? AND o.status IN ('preparing','ready') ORDER BY o.created_at`, req.user.pharmacyId);
  const out = db.all(`${listSql} WHERE o.pharmacy_id = ? AND o.status = 'out_for_delivery' ORDER BY o.out_at`, req.user.pharmacyId);
  const done = db.all(`${listSql} WHERE o.pharmacy_id = ? AND o.status = 'delivered' ORDER BY o.updated_at DESC LIMIT 10`, req.user.pharmacyId);
  const riders = db.all("SELECT DISTINCT rider_name, rider_phone FROM orders WHERE pharmacy_id = ? AND rider_name IS NOT NULL", req.user.pharmacyId);
  res.render('pharmacy/delivery', { title: 'Delivery', ready, out, done, riders });
});

// =============== Payments ===============
router.get('/payments', (req, res) => {
  const p = req.user.pharmacyId;
  const rows = db.all(`${listSql} WHERE o.pharmacy_id = ? AND o.accepted = 1 ORDER BY o.updated_at DESC LIMIT 60`, p);
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const sum = db.get(`SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END),0) paid,
                        COALESCE(SUM(CASE WHEN payment_method = 'cod' AND payment_status = 'unpaid' THEN total ELSE 0 END),0) cod FROM orders WHERE pharmacy_id = ? AND accepted = 1 AND created_at >= ?`, p, month);
  res.render('pharmacy/payments', { title: 'Payments', rows, sum });
});

// =============== Ratings and reviews (new) ===============
router.get('/reviews', (req, res) => {
  const p = req.user.pharmacyId;
  const list = db.all(`SELECT r.*, u.full_name FROM pharmacy_reviews r JOIN users u ON u.id = r.patient_id WHERE r.pharmacy_id = ? ORDER BY r.created_at DESC`, p);
  const rank = db.all("SELECT id, name FROM pharmacies WHERE verified = 1").map((x) => ({ ...x, score: reviews.summary(x.id).score })).sort((a, b) => b.score - a.score);
  res.render('pharmacy/reviews', { title: 'Ratings and reviews', list, rating: reviews.summary(p), ASPECTS: reviews.ASPECTS, position: rank.findIndex((x) => x.id === p) + 1, of: rank.length });
});
router.post('/reviews/:id/reply', (req, res) => {
  const r = db.get('SELECT * FROM pharmacy_reviews WHERE id = ? AND pharmacy_id = ?', req.params.id, req.user.pharmacyId);
  const reply = String(req.body.reply || '').trim().slice(0, 500);
  if (!r || !reply) return res.redirect('/pharmacy/reviews');
  db.run('UPDATE pharmacy_reviews SET reply = ?, replied_at = ? WHERE id = ?', reply, db.now(), r.id);
  notify(r.patient_id, `${res.locals.pharmacy.name} replied to your review`, reply.slice(0, 80), `/patient/orders/${r.order_id}#review`, 'review');
  req.flash('success', 'Reply posted.');
  res.redirect('/pharmacy/reviews');
});

// =============== Profile ===============
router.get('/profile', (req, res) => res.render('pharmacy/profile', { title: 'Shop profile' }));
router.post('/profile', (req, res) => {
  const b = req.body;
  db.run('UPDATE pharmacies SET name = ?, address = ?, phone = ?, delivery_minutes = ?, delivery_fee = ?, accepts_cod = ?, accepts_online = ?, lat = ?, lng = ?, discount_pct = ?, emergency_fee = ?, emergency_minutes = ? WHERE id = ?',
    String(b.name || '').trim() || res.locals.pharmacy.name, b.address, b.phone, Math.max(5, parseInt(b.delivery_minutes, 10) || 45), Math.max(0, parseInt(b.delivery_fee, 10) || 0),
    b.accepts_cod ? 1 : 0, b.accepts_online ? 1 : 0, b.lat === '' || isNaN(Number(b.lat)) ? null : Number(b.lat), b.lng === '' || isNaN(Number(b.lng)) ? null : Number(b.lng),
    Math.min(90, Math.max(0, parseInt(b.discount_pct, 10) || 0)), Math.max(0, parseInt(b.emergency_fee, 10) || 0), Math.max(5, parseInt(b.emergency_minutes, 10) || 25), req.user.pharmacyId);
  req.flash('success', 'Shop details saved.');
  res.redirect('/pharmacy/profile');
});

module.exports = router;
