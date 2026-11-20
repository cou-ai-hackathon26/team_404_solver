// Notifications: stored in the database and pushed live to open browser tabs
// through Server-Sent Events (see GET /notifications/stream).
const db = require('../db');

const listeners = new Map(); // userId -> Set<res>

function subscribe(userId, res) {
  if (!listeners.has(userId)) listeners.set(userId, new Set());
  listeners.get(userId).add(res);
  return () => {
    const set = listeners.get(userId);
    if (set) {
      set.delete(res);
      if (!set.size) listeners.delete(userId);
    }
  };
}

function unreadCount(userId) {
  return db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', userId).n;
}

function notify(userId, title, body = '', link = '', kind = 'info') {
  if (!userId) return;
  const { id } = db.run(
    'INSERT INTO notifications (user_id, title, body, link, kind) VALUES (?, ?, ?, ?, ?)',
    userId,
    title,
    body,
    link,
    kind
  );
  const set = listeners.get(userId);
  if (set) {
    const payload = JSON.stringify({ id, title, body, link, kind, unread: unreadCount(userId) });
    for (const res of set) res.write(`event: notification\ndata: ${payload}\n\n`);
  }
}

module.exports = { notify, subscribe, unreadCount };
