// Live maps with Leaflet + OpenStreetMap.
// <div data-map data-points='[{"lat":..,"lng":..,"kind":"doctor","label":"..","id":"d1"}]'
//      data-me="live"            -> watch this browser's GPS, show "You" and post it to /api/location
//      data-poll="/api/..."      -> refresh points from JSON every few seconds
//      data-target="d1"          -> draw a line from "You" to that point and show the distance
//      data-pick="form-id"       -> click on the map to set lat/lng fields of that form
// Everything degrades gracefully: without tiles you still see markers; without GPS the saved address is used.
(function () {
  if (!window.L) return;
  const csrf = document.querySelector('meta[name=csrf]');
  const COLORS = { me: '#2563eb', doctor: '#0d9488', ambulance: '#dc2626', pharmacy: '#9333ea', center: '#ea580c', donor: '#e11d48', place: '#4f46e5' };
  const ICONS = {
    me: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    doctor: '<path d="M6 3v6a5 5 0 0 0 10 0V3"/><path d="M11 14v2a5 5 0 0 0 10 0v-2"/><circle cx="21" cy="11.5" r="2"/>',
    ambulance: '<path d="M2 16V8a1 1 0 0 1 1-1h11v9"/><path d="M14 10h4l4 4v2h-8"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/><path d="M8 9.5v4M6 11.5h4"/>',
    pharmacy: '<path d="M10.5 20.5a5 5 0 0 1-7-7l7-7a5 5 0 0 1 7 7z"/><path d="m7 10 7 7"/>',
    center: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/>',
    donor: '<path d="M12 3s6.5 7.3 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.3 12 3 12 3z"/>',
    place: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  };
  const icon = (kind, live) => L.divIcon({
    className: '',
    html: `<div class="mk ${live ? 'live' : ''}" style="--c:${COLORS[kind] || COLORS.place}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.place}</svg></div>`,
    iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -18],
  });
  const km = (a, b) => {
    const R = 6371, r = (d) => (d * Math.PI) / 180;
    const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) * 10) / 10;
  };
  let lastPost = 0;
  function postLocation(p) {
    if (Date.now() - lastPost < 20000) return;
    lastPost = Date.now();
    fetch('/api/location', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf ? csrf.content : '' }, body: JSON.stringify(p) }).catch(() => {});
  }

  document.querySelectorAll('[data-map]').forEach((el) => {
    const pts = JSON.parse(el.dataset.points || '[]').filter((p) => p.lat != null && p.lng != null);
    const center = pts[0] || { lat: 23.7465, lng: 90.376 }; // Dhaka
    const map = L.map(el, { scrollWheelZoom: false }).setView([center.lat, center.lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    map.attributionControl.setPrefix('Leaflet');
    const markers = {};
    let line = null;
    const distEl = document.querySelector(el.dataset.distance || '[data-distance]');
    const etaEl = document.querySelector('[data-eta]');

    function upsert(p) {
      const key = p.id || `${p.kind}-${p.lat}-${p.lng}`;
      if (markers[key]) markers[key].setLatLng([p.lat, p.lng]).setIcon(icon(p.kind, p.live));
      else markers[key] = L.marker([p.lat, p.lng], { icon: icon(p.kind, p.live) }).addTo(map).bindPopup(p.popup || p.label || '');
      markers[key].options.kind = p.kind;
      return key;
    }
    function drawRoute() {
      const me = markers.me, target = markers[el.dataset.target];
      if (!me || !target) return;
      const a = me.getLatLng(), b = target.getLatLng();
      if (line) line.setLatLngs([a, b]); else line = L.polyline([a, b], { color: '#4f46e5', weight: 4, dashArray: '8 8', opacity: 0.8 }).addTo(map);
      const d = km(a, b);
      if (distEl) distEl.textContent = `${d} km`;
      if (etaEl) etaEl.textContent = `${Math.max(2, Math.round(d * (Number(el.dataset.minPerKm) || 3) + 2))} min`;
    }
    function fit() {
      const all = Object.values(markers).map((m) => m.getLatLng());
      if (all.length > 1) map.fitBounds(L.latLngBounds(all).pad(0.25), { maxZoom: 15 });
    }
    pts.forEach(upsert);
    fit();
    drawRoute();

    if (el.dataset.me && navigator.geolocation) {
      const onPos = (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const first = !markers.me;
        upsert({ ...p, id: 'me', kind: 'me', live: true, label: 'You (live)' });
        drawRoute();
        if (first) fit();
        if (el.dataset.me === 'live') postLocation(p);
        const f = el.dataset.fill && document.getElementById(el.dataset.fill);
        if (f && f.elements.lat && !f.elements.lat.dataset.touched) { f.elements.lat.value = p.lat.toFixed(5); f.elements.lng.value = p.lng.toFixed(5); }
        const s = el.parentElement.querySelector('[data-gps]');
        if (s) s.textContent = 'Live GPS';
      };
      navigator.geolocation.watchPosition(onPos, () => {
        const s = el.parentElement.querySelector('[data-gps]');
        if (s) s.textContent = 'GPS off: using saved address';
      }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
    }

    if (el.dataset.pick) {
      const f = document.getElementById(el.dataset.pick);
      map.on('click', (e) => {
        upsert({ lat: e.latlng.lat, lng: e.latlng.lng, id: 'picked', kind: 'place', label: 'Selected location' });
        if (f) { f.elements.lat.value = e.latlng.lat.toFixed(5); f.elements.lng.value = e.latlng.lng.toFixed(5); f.elements.lat.dataset.touched = '1'; }
      });
    }

    if (el.dataset.poll) {
      const every = Number(el.dataset.every || 8000);
      const tick = () => fetch(el.dataset.poll, { headers: { accept: 'application/json' } }).then((r) => r.json()).then((data) => {
        const seen = new Set(['me', 'picked']);
        (data.points || []).forEach((p) => seen.add(upsert(p)));
        Object.keys(markers).forEach((k) => { if (!seen.has(k) && markers[k].options.kind !== 'me') { map.removeLayer(markers[k]); delete markers[k]; } });
        drawRoute();
        if (data.status) { const st = document.querySelector('[data-live-status]'); if (st && st.textContent !== data.status) { st.textContent = data.status; if (data.reload) location.reload(); } }
      }).catch(() => {});
      setInterval(tick, every);
    }
    setTimeout(() => map.invalidateSize(), 300);
  });

  // Doctors and ambulances: keep posting this device's location while "share" is on.
  const sharer = document.querySelector('[data-share-location]');
  if (sharer && sharer.dataset.shareLocation === '1' && navigator.geolocation) {
    navigator.geolocation.watchPosition((pos) => postLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }), () => {
      sharer.textContent = 'Location blocked in browser';
    }, { enableHighAccuracy: true, maximumAge: 15000 });
  }
})();
