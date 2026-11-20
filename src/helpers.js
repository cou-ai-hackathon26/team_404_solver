// View helpers available in every EJS template (app.locals).
// Charts are drawn as inline SVG on the server, so no chart library or CDN is needed.

const LABELS = {
  requested: 'Requested', proposed: 'Time proposed', reschedule_requested: 'Reschedule asked', confirmed: 'Confirmed',
  completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled', prescribed: 'Prescribed', scheduled: 'Scheduled',
  sample_collected: 'Sample collected', pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
  received: 'New', preparing: 'Preparing', ready: 'Ready for delivery', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', active: 'Active', suspended: 'Suspended', unpaid: 'Unpaid', paid: 'Paid', refunded: 'Refunded',
  open: 'Open', fulfilled: 'Fulfilled', notified: 'Notified', accepted: 'Accepted', donated: 'Donated', due: 'Due',
  taken: 'Taken', skipped: 'Skipped', normal: 'Normal', watch: 'Watch', doctor: 'See a doctor', urgent: 'Get help now',
};
const TONE = {
  confirmed: 'green', completed: 'green', approved: 'green', delivered: 'green', active: 'green', paid: 'green',
  fulfilled: 'green', accepted: 'green', donated: 'green', taken: 'green', normal: 'green',
  declined: 'red', cancelled: 'red', rejected: 'red', suspended: 'red', urgent: 'red', doctor: 'red',
  proposed: 'amber', pending: 'amber', requested: 'amber', reschedule_requested: 'amber', received: 'blue',
  preparing: 'amber', sample_collected: 'amber', watch: 'amber', due: 'blue', skipped: 'gray', unpaid: 'amber',
  scheduled: 'blue', ready: 'blue', out_for_delivery: 'amber', prescribed: 'blue', open: 'blue', notified: 'blue',
};

// Icons: simplified Lucide-style line icons (24x24, stroke).
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  heart: '<path d="M12 20s-7-4.4-9.2-8.6C1.2 8.3 3 4.5 6.6 4.5c2 0 3.3 1.1 4.4 2.6 1.1-1.5 2.4-2.6 4.4-2.6 3.6 0 5.4 3.8 3.8 6.9C19 15.6 12 20 12 20z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 14h9"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6z"/>',
  pill: '<path d="M10.5 20.5a5 5 0 0 1-7-7l7-7a5 5 0 0 1 7 7z"/><path d="m7 10 7 7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  pen: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  message: '<path d="M4 5h16v11H8l-4 4z"/>',
  chart: '<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  drop: '<path d="M12 3s6.5 7.3 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.3 12 3 12 3z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5"/>',
  alarm: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M4 4 2 6M20 4l2 2"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.2 7.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 3.4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.2 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  stethoscope: '<path d="M6 3v6a5 5 0 0 0 10 0V3"/><path d="M4 3h4M14 3h4M11 14v2a5 5 0 0 0 10 0v-2"/><circle cx="21" cy="11.5" r="2"/>',
  ambulance: '<path d="M2 16V8a1 1 0 0 1 1-1h11v9"/><path d="M14 10h4l4 4v2h-8"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/><path d="M8 9.5v4M6 11.5h4"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7H6"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13"/>',
  map: '<path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  nav: '<path d="M12 2 4 21l8-4 8 4z"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  mobile: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  syringe: '<path d="m18 2 4 4M17 7l-9.5 9.5L4 18l1.5-3.5L15 5M14 4l6 6M9.5 11.5l2 2M12 9l2 2M3 21l2-2"/>',
  thermo: '<path d="M14 14.5V4a2 2 0 0 0-4 0v10.5a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  bone: '<path d="M17 10c.7.7 1.7 1 2.8.6a2.5 2.5 0 1 0-2.4-4 2.5 2.5 0 1 0-4 2.4c-.4 1.1-.1 2.1.6 2.8L10 15c-.7-.7-1.7-1-2.8-.6a2.5 2.5 0 1 0 2.4 4 2.5 2.5 0 1 0 4-2.4c.4-1.1.1-2.1-.6-2.8z"/>',
  tooth: '<path d="M7 3c-2.5 0-4 2-4 4.5 0 3 1.5 4 2 7 .4 2.5 1 6.5 2.5 6.5S9 18 10 15.5c.5-1.3 1.5-1.3 2 0 1 2.5 1 5.5 2.5 5.5s2.1-4 2.5-6.5c.5-3 2-4 2-7C19 5 17.5 3 15 3c-1.7 0-2.3 1-3 1s-1.3-1-3-1z"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  dna: '<path d="M6 3c0 6 12 6 12 12M18 3c0 6-12 6-12 12M6 21c0-2 1-3.5 2.5-4.5M18 21c0-2-1-3.5-2.5-4.5M8 6h8M8 18h8"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M8 7h4M8 11h4M8 15h4M3 21h18"/>',
};

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function icon(name, size = 20, cls = '') {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
}

const PALETTE = { blue: '#4f46e5', orange: '#ea580c', teal: '#0f766e', purple: '#a855f7', red: '#be123c', green: '#059669', sky: '#0284c7' };

/** Small trend line for stat cards. values: numbers. */
function sparkline(values, color = 'blue') {
  const v = values && values.length > 1 ? values : [2, 3, 2.5, 4, 4.2];
  const w = 120, h = 34, max = Math.max(...v), min = Math.min(...v), span = max - min || 1;
  const pts = v.map((y, i) => [Number(((i / (v.length - 1)) * (w - 4) + 2).toFixed(1)), Number((h - 5 - ((y - min) / span) * (h - 10)).toFixed(1))]);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${smoothPath(pts)}" fill="none" stroke="${PALETTE[color] || color}" stroke-width="2.4" stroke-linecap="round"/></svg>`;
}

function smoothPath(points) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

/** Area chart with month labels. */
function areaChart(values, labels, opts = {}) {
  const W = 600, H = 230, L = 34, R = 10, T = 16, B = 34;
  const max = Math.max(1, ...values) * 1.15;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, values.length - 1);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const pts = values.map((v, i) => [Number(x(i).toFixed(1)), Number(y(v).toFixed(1))]);
  const line = smoothPath(pts);
  const id = `ag${Math.random().toString(36).slice(2, 8)}`;
  const grid = [0, 1, 2, 3].map((k) => { const gy = T + (k * (H - T - B)) / 3; return `<line x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}" stroke="#e8ecf6"/>`; }).join('');
  const last = pts.at(-2) || pts[0];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Trend')}">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#6366f1" stop-opacity=".35"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="${line} L${pts.at(-1)[0]},${H - B} L${pts[0][0]},${H - B} Z" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="#4f46e5" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="6" fill="#fff" stroke="#4f46e5" stroke-width="2.5"/>
    ${values.map((v, i) => `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" class="axis">${esc(labels[i])}</text>`).join('')}
    ${values.map((v, i) => `<title>${esc(labels[i])}: ${v}</title>`).join('')}
  </svg>`;
}

/** Donut chart. segments: [{ value, color, label }] */
function donut(segments, centerValue, centerLabel) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = 78, c = 2 * Math.PI * r;
  let off = 0;
  const arcs = total
    ? segments.filter((s) => s.value > 0).map((s) => {
        const len = (s.value / total) * c;
        const el = `<circle r="${r}" cx="100" cy="100" fill="none" stroke="${s.color}" stroke-width="34" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(s.label)}: ${s.value}</title></circle>`;
        off += len;
        return el;
      }).join('')
    : `<circle r="${r}" cx="100" cy="100" fill="none" stroke="#e8ecf6" stroke-width="34"/>`;
  return `<svg class="donut" viewBox="0 0 200 200" role="img" aria-label="${esc(centerLabel)}">${arcs}
    <text x="100" y="104" text-anchor="middle" class="donut-num">${esc(centerValue)}</text>
    <text x="100" y="128" text-anchor="middle" class="donut-lbl">${esc(centerLabel)}</text></svg>`;
}

/** Vertical bars with value labels. */
function bars(values, labels) {
  const W = 600, H = 230, L = 20, B = 34, T = 28;
  const max = Math.max(1, ...values);
  const slot = (W - 2 * L) / values.length;
  const bw = Math.min(56, slot * 0.56);
  const out = values.map((v, i) => {
    const h = (v / max) * (H - T - B);
    const x = L + i * slot + (slot - bw) / 2;
    return `<rect x="${x}" y="${H - B - h}" width="${bw}" height="${Math.max(h, 2)}" rx="10" fill="url(#barg)"><title>${esc(labels[i])}: ${v}</title></rect>
      <text x="${x + bw / 2}" y="${H - B - h - 8}" text-anchor="middle" class="bar-val">${v}</text>
      <text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" class="axis">${esc(labels[i])}</text>`;
  }).join('');
  const grid = [0, 1, 2, 3].map((k) => { const gy = T + (k * (H - T - B)) / 3; return `<line x1="${L}" x2="${W - L}" y1="${gy}" y2="${gy}" stroke="#e8ecf6"/>`; }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart"><defs><linearGradient id="barg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>${grid}${out}</svg>`;
}

/** Monthly bars with an optional predicted bar (dashed) and the normal range as a green band. */
function monthBars(values, labels, opts = {}) {
  const W = 620, H = 240, L = 44, R = 12, T = 26, B = 34;
  const all = [...values, opts.predicted].filter((v) => v != null);
  if (!all.length) return '<div class="empty small">No values yet</div>';
  const cols = values.length + (opts.predicted != null ? 1 : 0);
  const top = Math.max(...all, opts.high || 0) * 1.12 || 1;
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const slot = (W - L - R) / cols;
  const bw = Math.min(46, slot * 0.58);
  const uid = `mb${Math.random().toString(36).slice(2, 7)}`;
  let out = '';
  if (opts.low != null && opts.high != null) {
    out += `<rect x="${L}" y="${y(Math.min(opts.high, top))}" width="${W - L - R}" height="${Math.max(0, y(opts.low) - y(Math.min(opts.high, top)))}" fill="#dcfce7" opacity=".55"/>
      <text x="${L + 6}" y="${y(Math.min(opts.high, top)) + 12}" text-anchor="start" class="axis" fill="#15803d">normal range</text>`;
  }
  [0, 0.5, 1].forEach((k) => { const v = top * k; out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e8ecf6"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${Math.round(v * 10) / 10}</text>`; });
  const bad = (v) => opts.low != null && (v < opts.low || v > opts.high);
  values.forEach((v, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    out += `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" class="axis">${esc(labels[i])}</text>`;
    if (v == null) return;
    out += `<rect class="grow-bar" style="--i:${i}" x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(2, H - B - y(v))}" rx="8" fill="url(#${bad(v) ? uid + 'r' : uid})"><title>${esc(labels[i])}: ${v} ${esc(opts.unit || '')}</title></rect>
      <text x="${x + bw / 2}" y="${y(v) - 7}" text-anchor="middle" class="bar-val">${v}</text>`;
  });
  if (opts.predicted != null) {
    const i = values.length, v = opts.predicted;
    const x = L + i * slot + (slot - bw) / 2;
    out += `<rect class="grow-bar" style="--i:${i}" x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(2, H - B - y(v))}" rx="8" fill="url(#${uid}p)" stroke="#7c3aed" stroke-dasharray="5 4" stroke-width="2"><title>Predicted ${esc(opts.nextLabel || '')}: ${v}</title></rect>
      <text x="${x + bw / 2}" y="${y(v) - 7}" text-anchor="middle" class="bar-val" fill="#7c3aed">${v}</text>
      <text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" class="axis" fill="#7c3aed">${esc(opts.nextLabel || 'Next')}*</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Monthly values')}"><defs>
    <linearGradient id="${uid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/></linearGradient>
    <linearGradient id="${uid}r" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fb923c"/><stop offset="1" stop-color="#e11d48"/></linearGradient>
    <pattern id="${uid}p" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#f3e8ff"/><line x1="0" y1="0" x2="0" y2="8" stroke="#c4b5fd" stroke-width="4"/></pattern>
  </defs>${out}</svg>`;
}

/** Line chart for health readings (one or two series) with optional limit line. */
function readingsChart(rows, opts = {}) {
  if (!rows.length) return '<div class="empty small">No readings yet</div>';
  const W = 600, H = 200, L = 40, R = 12, T = 14, B = 30;
  const s1 = rows.map((r) => r.value1);
  const s2 = rows.map((r) => r.value2).filter((v) => v != null);
  const all = [...s1, ...s2, ...(opts.limit ? [opts.limit] : [])];
  const min = Math.min(...all) * 0.9, max = Math.max(...all) * 1.08;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, rows.length - 1);
  const y = (v) => T + (1 - (v - min) / (max - min || 1)) * (H - T - B);
  const line = (vals, col) => `<polyline points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linejoin="round"/>` + vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${col}"/>`).join('');
  const lim = opts.limit ? `<line x1="${L}" x2="${W - R}" y1="${y(opts.limit)}" y2="${y(opts.limit)}" stroke="#ef4444" stroke-dasharray="6 5"/><text x="${W - R}" y="${y(opts.limit) - 6}" text-anchor="end" class="axis" fill="#ef4444">${esc(opts.limitLabel || opts.limit)}</text>` : '';
  const ticks = rows.map((r, i) => (i % Math.ceil(rows.length / 7) === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="axis">${new Date(r.measured_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</text>` : '')).join('');
  const yt = [min, (min + max) / 2, max].map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${Math.round(v)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Readings')}">${lim}${yt}${line(s1, '#4f46e5')}${s2.length ? line(rows.map((r) => r.value2), '#0ea5e9') : ''}${ticks}</svg>`;
}

const AVATAR_COLORS = ['blue', 'teal', 'orange', 'purple', 'pink', 'indigo'];
function initials(name) {
  return String(name || '?').replace(/^(Dr\.?\s+)/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
function avatar(name, size = 'md', seed) {
  const k = [...String(seed ?? name)].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return `<span class="avatar ${size} av-${AVATAR_COLORS[k]}">${esc(initials(name))}</span>`;
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? v : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function shortDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? v : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function fmtTime(v) {
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? v : `${shortDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** "Tomorrow, 5:00 PM", "Wed 18 Nov, 11:00 AM" */
function friendly(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return v;
  const t = new Date();
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  const when = dayDiff === 0 ? 'Today' : dayDiff === 1 ? 'Tomorrow' : dayDiff === -1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${when}, ${fmtTime(d)}`;
}
function ago(v) {
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${s >= 7200 ? 's' : ''} ago`;
  if (s < 172800) return 'Yesterday';
  return shortDate(v);
}
function toLocalInput(v) {
  const d = v ? new Date(v) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const todayInput = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

module.exports = {
  icon, sparkline, areaChart, donut, bars, monthBars, readingsChart, avatar, initials, esc,
  label: (s) => LABELS[s] || s,
  badge: (s, text) => `<span class="badge ${TONE[s] || 'gray'}">${esc(text || LABELS[s] || s)}</span>`,
  pill: (text, tone = 'blue') => `<span class="badge ${tone}">${esc(text)}</span>`,
  money: (n) => `BDT ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  km: (d) => (d === null || d === undefined ? 'distance unknown' : `${d} km away`),
  code: (id) => `#MC-${1000 + Number(id)}`,
  stars: (n) => { const r = Math.round((n || 0) * 2) / 2; return `<span class="stars" title="${(n || 0).toFixed(1)} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= r ? 'on' : i - 0.5 === r ? 'half' : ''}">★</i>`).join('')}</span>`; },
  fmtDate, shortDate, fmtTime, fmtDateTime, friendly, ago, toLocalInput, todayInput,
  dateChip: () => { const d = new Date(); return `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`; },
};
