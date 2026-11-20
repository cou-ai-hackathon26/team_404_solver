// Doctor schedules: weekly hours, time off and bookable slots.
// Patients and doctors can only pick open slots, so double booking cannot happen.
const db = require('../db');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDER = [6, 0, 1, 2, 3, 4, 5]; // Bangladesh week starts on Saturday
const HOLDING = "('requested','proposed','confirmed','reschedule_requested')";

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
const label = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function hours(doctorId) {
  const rows = db.all('SELECT * FROM doctor_hours WHERE doctor_id = ?', doctorId);
  return ORDER.map((wd) => rows.find((r) => r.weekday === wd) || { doctor_id: doctorId, weekday: wd, enabled: 0, start_time: '09:00', end_time: '13:00' });
}

function timeOffOn(doctorId, day) {
  return db.get('SELECT * FROM doctor_time_off WHERE doctor_id = ? AND start_date <= ? AND end_date >= ?', doctorId, day, day);
}

/** Times already held on a day: confirmed or proposed appointments (including offered alternatives). */
function heldTimes(doctorId, day, exceptAppointmentId = 0) {
  const rows = db.all(
    `SELECT id, proposed_time, alt_times, preferred_time, status, duration FROM appointments
      WHERE doctor_id = ? AND status IN ${HOLDING} AND id <> ?`,
    doctorId, exceptAppointmentId
  );
  const out = [];
  for (const r of rows) {
    const times = [r.proposed_time, ...(r.alt_times ? JSON.parse(r.alt_times) : [])];
    if (['reschedule_requested', 'requested'].includes(r.status) && r.preferred_time && /^\d{4}-\d{2}-\d{2}T/.test(r.preferred_time)) times.push(r.preferred_time);
    for (const t of times.filter(Boolean)) {
      const d = new Date(t);
      if (dateStr(d) === day) out.push({ start: d.getHours() * 60 + d.getMinutes(), duration: r.duration || 30 });
    }
  }
  return out;
}

/**
 * Slots for one day: [{ iso, label, state: 'open' | 'booked' | 'past' }].
 * Returns { slots, off } where off is the time-off reason or 'closed'.
 */
function slotsFor(doctorId, day, exceptAppointmentId = 0) {
  const doc = db.get('SELECT slot_minutes, buffer_minutes, max_per_day FROM doctor_profiles WHERE user_id = ?', doctorId);
  if (!doc) return { slots: [], off: 'closed' };
  const off = timeOffOn(doctorId, day);
  if (off) return { slots: [], off: off.reason || 'Time off' };
  const date = new Date(`${day}T00:00:00`);
  const h = db.get('SELECT * FROM doctor_hours WHERE doctor_id = ? AND weekday = ?', doctorId, date.getDay());
  if (!h || !h.enabled) return { slots: [], off: 'closed' };
  const held = heldTimes(doctorId, day, exceptAppointmentId);
  const full = held.length >= doc.max_per_day;
  const step = doc.slot_minutes;
  const now = Date.now();
  const slots = [];
  for (let m = toMin(h.start_time); m + step <= toMin(h.end_time); m += step) {
    const d = new Date(`${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`);
    const clash = held.some((x) => m < x.start + x.duration + doc.buffer_minutes && x.start < m + step + doc.buffer_minutes);
    const state = d.getTime() < now ? 'past' : clash || full ? 'booked' : 'open';
    slots.push({ iso: d.toISOString(), label: label(d), state });
  }
  return { slots, off: null };
}

function isOpen(doctorId, iso, exceptAppointmentId = 0) {
  const d = new Date(iso);
  if (isNaN(d)) return false;
  return slotsFor(doctorId, dateStr(d), exceptAppointmentId).slots.some((s) => s.state === 'open' && s.iso === d.toISOString());
}

/** The next n days as a date strip: [{ day, dow, num, open }]. */
function dateStrip(doctorId, days = 7, from = new Date()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const day = dateStr(d);
    const { slots } = slotsFor(doctorId, day);
    out.push({ day, dow: d.toLocaleDateString('en-US', { weekday: 'short' }), num: d.getDate(), open: slots.some((s) => s.state === 'open') });
  }
  return out;
}

function nextAvailable(doctorId, days = 14) {
  const t = new Date();
  for (let i = 0; i < days; i++) {
    const day = dateStr(new Date(t.getFullYear(), t.getMonth(), t.getDate() + i));
    const s = slotsFor(doctorId, day).slots.find((x) => x.state === 'open');
    if (s) return s.iso;
  }
  return null;
}

module.exports = { WEEKDAYS, ORDER, hours, slotsFor, isOpen, dateStrip, nextAvailable, dateStr, timeOffOn };
