// MediConnect browser helpers. Kept in one external file so the strict
// Content-Security-Policy (no inline scripts) works.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  // Mobile menu
  const menu = $('[data-menu]');
  if (menu) menu.addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // Notification dropdown
  const bell = $('[data-bell]');
  const dd = $('#notif-dd');
  if (bell && dd) {
    bell.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!dd.contains(e.target)) dd.classList.add('hidden'); });
    $$('[data-ntab]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-ntab]').forEach((x) => x.classList.toggle('on', x === b));
      $$('#notif-list .notif').forEach((n) => { n.style.display = b.dataset.ntab === 'unread' && n.dataset.read === '1' ? 'none' : ''; });
    }));
  }

  // Confirm before destructive actions
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));

  $$('[data-confirm-click]').forEach((b) => b.addEventListener('click', (e) => { if (!confirm(b.dataset.confirmClick)) e.preventDefault(); }));

  // OTP boxes: auto-advance, backspace, paste a full code
  $$('[data-otp]').forEach((wrap) => {
    const boxes = $$('input', wrap);
    const hidden = $(wrap.dataset.otp);
    const sync = () => { hidden.value = boxes.map((b) => b.value).join(''); };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => { b.value = b.value.replace(/\D/g, '').slice(-1); if (b.value && boxes[i + 1]) boxes[i + 1].focus(); sync(); });
      b.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus(); });
      b.addEventListener('paste', (e) => {
        const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, boxes.length);
        if (!t) return;
        e.preventDefault();
        t.split('').forEach((c, k) => { boxes[k].value = c; });
        (boxes[t.length] || boxes.at(-1)).focus();
        sync();
      });
    });
    if (boxes[0]) boxes[0].focus();
  });

  // Countdown text: <span data-countdown="45">
  $$('[data-countdown]').forEach((el) => {
    let s = Number(el.dataset.countdown);
    const btn = el.closest('button');
    const tick = () => {
      if (s <= 0) { el.textContent = ''; if (btn) btn.disabled = false; return; }
      if (btn) btn.disabled = true;
      el.textContent = ` in 00:${String(s).padStart(2, '0')}`;
      s--;
      setTimeout(tick, 1000);
    };
    tick();
  });

  // Use my location
  $$('[data-geolocate]').forEach((btn) => btn.addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Location is not supported by this browser.');
    btn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition((pos) => {
      const f = btn.form || btn.closest('form');
      f.elements.lat.value = pos.coords.latitude.toFixed(5);
      f.elements.lng.value = pos.coords.longitude.toFixed(5);
      btn.textContent = 'Location added ✓';
    }, () => { btn.textContent = 'Could not get location'; });
  }));

  // Drop zones show the chosen file name
  $$('.drop input[type=file]').forEach((inp) => inp.addEventListener('change', () => {
    const t = inp.closest('.drop').querySelector('[data-fname]');
    if (t && inp.files[0]) t.textContent = `${inp.files[0].name} · ${(inp.files[0].size / 1048576).toFixed(1)} MB selected`;
  }));
  $$('.drop').forEach((z) => {
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.style.background = '#eef2ff'; });
    z.addEventListener('dragleave', () => { z.style.background = ''; });
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      const inp = z.querySelector('input[type=file]');
      if (inp && e.dataTransfer.files.length) { inp.files = e.dataTransfer.files; inp.dispatchEvent(new Event('change')); }
    });
  });

  // Prescription writer: add medicine rows
  const addRow = $('[data-add-row]');
  if (addRow) addRow.addEventListener('click', () => {
    const body = $(addRow.dataset.addRow);
    const row = body.querySelector('tr').cloneNode(true);
    row.querySelectorAll('input, select').forEach((i) => { if (i.tagName === 'SELECT') i.selectedIndex = 0; else i.value = ''; });
    body.appendChild(row);
  });

  // Doctor: live preview of the proposed time
  const prev = $('[data-preview]');
  if (prev) {
    const update = () => {
      const picked = $$('input[name=slots]:checked');
      const first = picked[0];
      prev.querySelector('[data-p-time]').textContent = first ? first.dataset.label : 'Pick a time';
      const mode = ($('input[name=mode]:checked') || {}).value === 'online' ? 'Online' : 'In person';
      const dur = ($('[name=duration]') || {}).value || 30;
      prev.querySelector('[data-p-meta]').textContent = `${prev.dataset.spec} · ${mode} · ${dur} min${picked.length > 1 ? ` · +${picked.length - 1} more option(s)` : ''}`;
      if (picked.length > 3) { picked.at(-1).checked = false; alert('You can offer up to 3 times.'); update(); }
    };
    $$('input[name=slots], input[name=mode], [name=duration]').forEach((i) => i.addEventListener('change', update));
    update();
  }

  // Share records: count selected reports
  const shareBtn = $('[data-share-count]');
  if (shareBtn) {
    const upd = () => {
      const n = $$('input[name=report_ids]:checked').length;
      shareBtn.textContent = n ? `Share ${n} report${n > 1 ? 's' : ''}` : 'Select reports to share';
      shareBtn.disabled = !n;
      const lbl = $('[data-share-label]');
      if (lbl) lbl.textContent = `${n} report${n === 1 ? '' : 's'} selected. Doctors never see your full history.`;
    };
    $$('input[name=report_ids]').forEach((c) => c.addEventListener('change', upd));
    upd();
  }

  // Reading form: show the second value only for blood pressure, context only for sugar
  const kind = $('[data-reading-kind]');
  if (kind) {
    const upd = () => {
      $$('[data-for]').forEach((el) => { el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(kind.value)); });
      const u = $('[data-unit]');
      if (u) u.textContent = { bp: 'Systolic (top number)', sugar: 'mmol/L', weight: 'kg', pulse: 'beats per minute', spo2: '%' }[kind.value];
    };
    kind.addEventListener('change', upd);
    upd();
  }

  // Chat: keep the newest message in view
  const chat = $('.chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
  const chatForm = $('[data-chat-form]');
  if (chatForm) chatForm.addEventListener('submit', () => { const b = chatForm.querySelector('button'); b.disabled = true; b.textContent = 'Thinking…'; });
  $$('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
    const f = $('[data-chat-form]');
    f.querySelector('textarea, input[name=message]').value = b.dataset.suggest;
    f.requestSubmit();
  }));


  // ---------- New features ----------
  const csrfToken = ($('meta[name=csrf]') || {}).content || '';

  // Find a doctor: example chips fill the description
  $$('[data-example]').forEach((b) => b.addEventListener('click', () => {
    const ta = b.closest('form').querySelector('textarea');
    ta.value = b.dataset.example; ta.focus();
  }));

  // Quantity steppers and auto-submit controls
  $$('[data-qty]').forEach((b) => b.addEventListener('click', () => {
    const inp = b.parentElement.querySelector('input');
    inp.value = Math.max(Number(inp.min || 0), Math.min(Number(inp.max || 999), Number(inp.value || 0) + Number(b.dataset.qty)));
    if (inp.hasAttribute('data-autosubmit')) inp.form.requestSubmit();
  }));
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.requestSubmit()));
  $$('[data-go]').forEach((el) => el.addEventListener('change', () => { location.href = el.dataset.go; }));

  // Search-as-you-type filter for lists (tests picker)
  $$('[data-filter-list]').forEach((inp) => inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase();
    $$(`${inp.dataset.filterList} [data-name]`).forEach((el) => { el.style.display = el.dataset.name.includes(q) ? '' : 'none'; });
  }));
  // Test chips: highlight when selected and count them
  const picked = $('[data-picked]');
  $$('.test-chip input').forEach((c) => c.addEventListener('change', () => {
    c.closest('.test-chip').classList.toggle('on', c.checked);
    if (picked) picked.textContent = $$('.test-chip input:checked').length;
  }));
  $$('.seg input[name=sort]').forEach((r) => { if (!r.dataset.go) r.addEventListener('change', () => r.form && r.form.requestSubmit()); });

  // Ambulance: per-card request forms reuse the pickup details from the main form
  $$('form[data-copy-from]').forEach((f) => f.addEventListener('submit', () => {
    const src = document.getElementById(f.dataset.copyFrom);
    ['lat', 'lng', 'pickup_address', 'destination', 'phone', 'note'].forEach((n) => {
      if (!src || !src.elements[n]) return;
      const h = document.createElement('input'); h.type = 'hidden'; h.name = n; h.value = src.elements[n].value; f.appendChild(h);
    });
  }));

  // Pages that should refresh themselves (ambulance dashboard) unless the user is typing
  const auto = $('[data-auto-refresh]');
  if (auto) setInterval(() => { if (!document.activeElement || !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) location.reload(); }, Number(auto.dataset.autoRefresh));

  // Checkout: payment panels and delivery fee
  const co = $('[data-checkout]');
  if (co) {
    const panels = () => { const v = (co.querySelector('input[name=payment]:checked') || {}).value; $$('[data-pay]', co).forEach((p) => p.classList.toggle('hidden', p.dataset.pay !== v)); };
    const fee = () => {
      const r = co.querySelector('input[name=order_type]:checked');
      const f = Number(r.dataset.fee), sub = Number($('[data-total]', co).dataset.total);
      $('[data-fee-out]', co).textContent = `BDT ${f.toLocaleString()}`;
      $('[data-total]', co).textContent = `BDT ${(sub + f).toLocaleString()}`;
    };
    $$('input[name=payment]', co).forEach((r) => r.addEventListener('change', panels));
    $$('input[name=order_type]', co).forEach((r) => r.addEventListener('change', fee));
    const cn = co.querySelector('input[name=card_number]');
    if (cn) cn.addEventListener('input', () => { cn.value = cn.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); });
    const ce = co.querySelector('input[name=card_expiry]');
    if (ce) ce.addEventListener('input', () => { const d = ce.value.replace(/\D/g, '').slice(0, 4); ce.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
    panels();
  }

  // Reminder form: show as many time fields as doses per day
  const perDay = $('[data-per-day]');
  if (perDay) {
    const upd = () => $$('[data-time-slot]').forEach((el) => { const on = Number(el.dataset.timeSlot) <= Number(perDay.value); el.classList.toggle('hidden', !on); el.querySelector('input').disabled = !on; });
    perDay.addEventListener('change', upd); upd();
  }

  // ---- Voice + device notifications for medicine reminders (patients) ----
  function speak(text, lang) {
    if (!window.speechSynthesis) return false;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const bn = voices.find((v) => /^bn/i.test(v.lang));
    if (lang === 'bn' && bn) { u.voice = bn; u.lang = bn.lang; } else if (lang === 'bn') { return speak(text.en || 'It is time to take your medicine.', 'en'); } else u.lang = 'en-US';
    u.rate = 0.95;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
    return true;
  }
  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 880, 990].forEach((f, i) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22); g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.22 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.2);
        o.start(ctx.currentTime + i * 0.22); o.stop(ctx.currentTime + i * 0.22 + 0.22); });
    } catch (e) { /* audio blocked until the user interacts with the page */ }
  }
  function voiceFor(d) {
    const bnText = `এখন আপনার ${d.medicine_name} ওষুধ খাওয়ার সময় হয়েছে। ডোজ: ${d.dose || 'এক'}।`;
    const t = new String(bnText); t.en = `It is time to take your medicine, ${d.medicine_name}. Dose: ${d.dose || 'one'}.`;
    const bn = window.speechSynthesis && speechSynthesis.getVoices().some((v) => /^bn/i.test(v.lang));
    speak(bn ? bnText : t.en, bn ? 'bn' : 'en');
  }
  const testVoice = $('[data-test-voice]');
  if (testVoice) testVoice.addEventListener('click', () => { chime(); voiceFor({ medicine_name: 'Napa', dose: '1 tablet' }); });
  const askNotify = $('[data-ask-notify]');
  if (askNotify && window.Notification) {
    if (Notification.permission === 'granted') askNotify.textContent = 'Notifications allowed ✓';
    askNotify.addEventListener('click', () => Notification.requestPermission().then((p) => { askNotify.textContent = p === 'granted' ? 'Notifications allowed ✓' : 'Blocked in browser settings'; }));
  }
  function showDoseAlert(d) {
    const wrap = document.createElement('div'); wrap.className = 'dose-alert';
    const box = document.createElement('div'); box.className = 'box';
    box.innerHTML = '<div class="ring-ic"><svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M4 4 2 6M20 4l2 2"/></svg></div>';
    const h = document.createElement('h2'); h.textContent = 'ওষুধ খাওয়ার সময় হয়েছে'; box.appendChild(h);
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = `${d.medicine_name} · ${d.dose || '1'} · ${d.time}`; box.appendChild(p);
    const row = document.createElement('div'); row.className = 'row'; row.style.justifyContent = 'center'; row.style.marginTop = '18px';
    [['taken', 'Taken', 'btn green'], ['skipped', 'Skip', 'btn ghost']].forEach(([st, label, cls]) => {
      const f = document.createElement('form'); f.method = 'post'; f.action = `/patient/reminders/dose/${d.id}/${st}`;
      const c = document.createElement('input'); c.type = 'hidden'; c.name = '_csrf'; c.value = csrfToken; f.appendChild(c);
      const b = document.createElement('button'); b.className = cls; b.textContent = label; f.appendChild(b); row.appendChild(f);
    });
    const later = document.createElement('button'); later.className = 'btn ghost'; later.textContent = 'Later'; later.type = 'button'; later.addEventListener('click', () => wrap.remove()); row.appendChild(later);
    box.appendChild(row); wrap.appendChild(box); document.body.appendChild(wrap);
  }
  if (document.body.dataset.role === 'patient') {
    const seenKey = 'mc-dose-alerted';
    const seen = () => { try { return JSON.parse(localStorage.getItem(seenKey) || '[]'); } catch (e) { return []; } };
    const remember = (id) => { try { localStorage.setItem(seenKey, JSON.stringify([...seen(), id].slice(-200))); } catch (e) { /* storage off */ } };
    const check = () => fetch('/patient/reminders/due', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : { doses: [] })).then(({ doses }) => {
      doses.filter((d) => !seen().includes(d.id)).slice(0, 1).forEach((d) => {
        remember(d.id);
        chime();
        if (d.notify_push && window.Notification && Notification.permission === 'granted') {
          try { new Notification('ওষুধ খাওয়ার সময় · Medicine time', { body: `${d.medicine_name} – ${d.dose || '1'} (${d.time})`, icon: '/favicon.svg', tag: `dose-${d.id}` }); } catch (e) { /* some browsers need a service worker */ }
        }
        if (d.notify_voice) setTimeout(() => voiceFor(d), 900);
        showDoseAlert(d);
      });
    }).catch(() => {});
    if (window.speechSynthesis) speechSynthesis.getVoices();
    setTimeout(check, 2500);
    setInterval(check, 30000);
  }

  // ---- Live doctor chat ----
  const live = $('[data-live-chat]');
  if (live) {
    let last = Number(live.dataset.last || 0);
    const meId = Number(document.body.dataset.user);
    const add = (p) => {
      if ($(`[data-post="${p.id}"]`)) return;
      const m = document.createElement('div'); m.className = `msg ${p.mine || p.sender_id === meId ? 'me' : ''}`; m.dataset.post = p.id;
      const b = document.createElement('div'); b.className = 'bubble'; b.textContent = p.body; m.appendChild(b);
      const t = document.createElement('small'); t.textContent = p.time || ''; m.appendChild(t);
      live.insertBefore(m, $('#end', live)); live.scrollTop = live.scrollHeight;
      last = Math.max(last, p.id);
    };
    const poll = () => fetch(`/messages/${live.dataset.liveChat}/poll?after=${last}`, { headers: { accept: 'application/json' } }).then((r) => r.json()).then((d) => (d.posts || []).forEach(add)).catch(() => {});
    setInterval(poll, 4000);
    live.scrollTop = live.scrollHeight;
    const sendF = $('[data-live-send]');
    if (sendF) sendF.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = sendF.elements.body;
      const body = inp.value.trim();
      if (!body) return;
      inp.value = '';
      fetch(sendF.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrfToken, body }) })
        .then(() => poll()).catch(() => { inp.value = body; });
    });
  }

  // ---- Pharmacy: live stock numbers ----
  const ls = $('[data-live-stock]');
  if (ls) setInterval(() => fetch('/pharmacy/stock/live', { headers: { accept: 'application/json' } }).then((r) => r.json()).then(({ rows }) => rows.forEach((r) => {
    const cell = $(`[data-stock-row="${r.id}"]`);
    if (!cell) return;
    const q = $('[data-qty]', cell);
    if (q && q.textContent !== String(r.quantity)) { q.textContent = r.quantity; cell.classList.remove('flash-up'); void cell.offsetWidth; cell.classList.add('flash-up'); }
    const s = $(`[data-sold="${r.id}"]`); if (s) s.textContent = r.sold;
  })).catch(() => {}), 10000);

  // ---- Count-up numbers on stat cards ----
  $$('.stat .num').forEach((el) => {
    const m = el.textContent.trim().match(/^([^\d]*)([\d,]+)(.*)$/);
    if (!m) return;
    const target = Number(m[2].replace(/,/g, ''));
    if (!target || target > 100000) return;
    const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 900); const v = Math.round(target * (1 - Math.pow(1 - k, 3))); el.textContent = `${m[1]}${v.toLocaleString()}${m[3]}`; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  // Real-time notifications (Server-Sent Events)
  if (document.body.dataset.user && window.EventSource) {
    const toasts = $('#toasts');
    const es = new EventSource('/notifications/stream');
    es.addEventListener('notification', (e) => {
      const n = JSON.parse(e.data);
      const b = $('[data-bell]');
      if (b && !$('#unread-dot')) { const d = document.createElement('span'); d.className = 'dot'; d.id = 'unread-dot'; b.appendChild(d); }
      if (!toasts) return;
      const t = document.createElement('div');
      t.className = 'toast';
      const s = document.createElement('strong'); s.textContent = n.title; t.appendChild(s);
      if (n.body) { const p = document.createElement('div'); p.textContent = n.body; t.appendChild(p); }
      const a = document.createElement('a'); a.href = `/notifications/${n.id}/open`; a.textContent = 'Open'; t.appendChild(a);
      toasts.appendChild(t);
      setTimeout(() => t.remove(), 9000);
    });
  }
})();
