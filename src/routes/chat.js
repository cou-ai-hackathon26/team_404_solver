// Patient <-> doctor chat. The patient sends a chat request; messages open only after
// the doctor accepts. Both sides are notified, and the page refreshes new messages live.
const express = require('express');
const db = require('../db');
const { requireRole, notFound } = require('../middleware/core');
const { notify } = require('../services/notify');
const { audit } = require('../services/audit');

const router = express.Router();
const allow = requireRole('patient', 'doctor');

const SQL = `SELECT t.*, p.full_name AS patient_name, d.full_name AS doctor_name, dp.specialty
               FROM chat_threads t JOIN users p ON p.id = t.patient_id JOIN users d ON d.id = t.doctor_id JOIN doctor_profiles dp ON dp.user_id = t.doctor_id`;
function mine(req, id) {
  const t = db.get(`${SQL} WHERE t.id = ?`, id);
  if (!t) return null;
  return (req.user.role === 'patient' && t.patient_id === req.user.id) || (req.user.role === 'doctor' && t.doctor_id === req.user.id) ? t : null;
}
const other = (req, t) => (req.user.role === 'patient' ? { id: t.doctor_id, name: t.doctor_name } : { id: t.patient_id, name: t.patient_name });

router.get('/messages', allow, (req, res) => {
  const col = req.user.role === 'patient' ? 'patient_id' : 'doctor_id';
  const threads = db.all(`${SQL} WHERE t.${col} = ? ORDER BY (t.status = 'pending') DESC, t.updated_at DESC`, req.user.id).map((t) => ({
    ...t,
    last: db.get('SELECT body, created_at FROM chat_posts WHERE thread_id = ? ORDER BY id DESC LIMIT 1', t.id),
    unread: db.get('SELECT COUNT(*) n FROM chat_posts WHERE thread_id = ? AND sender_id <> ? AND read_at IS NULL', t.id, req.user.id).n,
  }));
  if (threads.length && !req.query.list) {
    const first = threads.find((t) => t.status === 'accepted');
    if (first && req.user.role === 'patient') return res.redirect(`/messages/${first.id}`);
  }
  res.render('shared/chat', { title: req.user.role === 'patient' ? 'Doctor chat' : 'Patient chats', threads, sel: null, posts: [] });
});

router.post('/messages/request/:doctorId', requireRole('patient'), (req, res) => {
  const d = db.get("SELECT u.id, u.full_name FROM users u JOIN doctor_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.status = 'active' AND p.verified = 1", req.params.doctorId);
  if (!d) return notFound(res, 'Doctor');
  const open = db.get("SELECT * FROM chat_threads WHERE patient_id = ? AND doctor_id = ? AND status IN ('pending','accepted')", req.user.id, d.id);
  if (open) return res.redirect(open.status === 'accepted' ? `/messages/${open.id}` : '/messages?list=1');
  const topic = String(req.body.topic || '').trim().slice(0, 200) || null;
  const { id } = db.run('INSERT INTO chat_threads (patient_id, doctor_id, topic) VALUES (?, ?, ?)', req.user.id, d.id, topic);
  notify(d.id, 'New chat request', `${req.user.full_name} wants to message you${topic ? ': ' + topic : '.'}`, '/messages?list=1', 'chat');
  req.flash('success', `Chat request sent to ${d.full_name}. You can message as soon as the doctor accepts.`);
  res.redirect(req.get('referer') || '/messages?list=1');
});

router.post('/messages/:id/:action(accept|decline)', requireRole('doctor'), (req, res) => {
  const t = mine(req, req.params.id);
  if (!t || t.status !== 'pending') return notFound(res, 'Chat request');
  const accepted = req.params.action === 'accept';
  db.run('UPDATE chat_threads SET status = ?, updated_at = ? WHERE id = ?', accepted ? 'accepted' : 'declined', db.now(), t.id);
  notify(t.patient_id, accepted ? 'Chat request accepted' : 'Chat request declined', accepted ? `${req.user.full_name} accepted. You can message now.` : `${req.user.full_name} cannot chat right now. Book an appointment instead.`,
    accepted ? `/messages/${t.id}` : `/patient/doctors/${t.doctor_id}`, 'chat');
  audit(req, accepted ? 'chat.accepted' : 'chat.declined', { entity: 'chat', entityId: t.id, patientId: t.patient_id });
  req.flash('success', accepted ? `Chat with ${t.patient_name} is open.` : 'Request declined.');
  res.redirect(accepted ? `/messages/${t.id}` : (req.get('referer') || '/messages?list=1'));
});

router.get('/messages/:id', allow, (req, res) => {
  const t = mine(req, req.params.id);
  if (!t) return notFound(res, 'Chat');
  db.run('UPDATE chat_posts SET read_at = ? WHERE thread_id = ? AND sender_id <> ? AND read_at IS NULL', db.now(), t.id, req.user.id);
  const col = req.user.role === 'patient' ? 'patient_id' : 'doctor_id';
  const threads = db.all(`${SQL} WHERE t.${col} = ? ORDER BY t.updated_at DESC`, req.user.id).map((x) => ({ ...x, last: db.get('SELECT body, created_at FROM chat_posts WHERE thread_id = ? ORDER BY id DESC LIMIT 1', x.id), unread: 0 }));
  const posts = db.all('SELECT * FROM chat_posts WHERE thread_id = ? ORDER BY id', t.id);
  res.render('shared/chat', { title: `Chat with ${other(req, t).name}`, threads, sel: t, posts, peer: other(req, t) });
});

router.get('/messages/:id/poll', allow, (req, res) => {
  const t = mine(req, req.params.id);
  if (!t) return res.status(404).json({ posts: [] });
  const posts = db.all('SELECT id, sender_id, body, created_at FROM chat_posts WHERE thread_id = ? AND id > ? ORDER BY id', t.id, Number(req.query.after) || 0);
  db.run('UPDATE chat_posts SET read_at = ? WHERE thread_id = ? AND sender_id <> ? AND read_at IS NULL', db.now(), t.id, req.user.id);
  res.json({ status: t.status, posts: posts.map((p) => ({ ...p, mine: p.sender_id === req.user.id, time: new Date(p.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) })) });
});

router.post('/messages/:id', allow, (req, res) => {
  const t = mine(req, req.params.id);
  if (!t) return notFound(res, 'Chat');
  const body = String(req.body.body || '').trim().slice(0, 2000);
  const json = (req.get('accept') || '').includes('application/json');
  if (t.status !== 'accepted') { if (json) return res.status(409).json({ ok: false }); req.flash('error', 'This chat is not open.'); return res.redirect(`/messages/${t.id}`); }
  if (body) {
    const { id } = db.run('INSERT INTO chat_posts (thread_id, sender_id, body) VALUES (?, ?, ?)', t.id, req.user.id, body);
    db.run('UPDATE chat_threads SET updated_at = ? WHERE id = ?', db.now(), t.id);
    const peer = other(req, t);
    const recent = db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND link = ? AND is_read = 0', peer.id, `/messages/${t.id}`).n;
    if (!recent) notify(peer.id, `Message from ${req.user.full_name}`, body.slice(0, 80), `/messages/${t.id}`, 'chat');
    if (json) return res.json({ ok: true, id });
  }
  res.redirect(`/messages/${t.id}#end`);
});

router.post('/messages/:id/close', allow, (req, res) => {
  const t = mine(req, req.params.id);
  if (!t) return notFound(res, 'Chat');
  db.run("UPDATE chat_threads SET status = 'closed', updated_at = ? WHERE id = ?", db.now(), t.id);
  req.flash('success', 'Chat closed. The patient can send a new request later.');
  res.redirect('/messages?list=1');
});

module.exports = router;
