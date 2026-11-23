/* MediConnect language switch (English <-> বাংলা).
 * The pages are written in English. When a user picks Bangla, this script
 * translates every visible text, placeholder and tooltip in the browser using
 * the dictionary in /js/i18n-bn.js, and keeps translating content that appears
 * later (notifications, chat, live updates). The choice is saved in the browser
 * (localStorage + cookie) so every page opens in the same language.
 * Nothing on the server changes, so every feature works the same in both languages.
 */
(() => {
  const KEY = 'mc_lang';
  const DICT = window.MC_BN || {};
  const root = document.documentElement;

  const getLang = () => {
    try { const v = localStorage.getItem(KEY); if (v) return v; } catch (e) { /* ignore */ }
    const m = document.cookie.match(/(?:^|;\s*)mc_lang=(\w+)/);
    return m ? m[1] : 'en';
  };
  const setLang = (v) => {
    try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ }
    document.cookie = `mc_lang=${v}; path=/; max-age=31536000; SameSite=Lax`;
  };

  let lang = getLang();

  // ---------- translation helpers ----------
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Fragment keys for partial matches (text mixed with names, numbers, dates).
  // Short everyday words ("and", "to", "day"…) are only used for whole-text matches, never inside sentences.
  const fragKeys = Object.keys(DICT)
    .filter((k) => /[A-Za-z]/.test(k) && /[A-Za-z]{2,}.*\s.*[A-Za-z]{2,}/.test(k))
    .sort((a, b) => b.length - a.length);
  const fragRe = fragKeys.length
    ? new RegExp(`(?<![A-Za-z])(?:${fragKeys.map(esc).join('|')})(?![A-Za-z])`, 'g')
    : null;

  const PATTERNS = [
    [/^(\d+)\s*(?:min|mins|minutes?) ago$/i, (m) => `${m[1]} মিনিট আগে`],
    [/^(\d+)\s*(?:h|hr|hrs|hours?) ago$/i, (m) => `${m[1]} ঘণ্টা আগে`],
    [/^(\d+)\s*(?:d|days?) ago$/i, (m) => `${m[1]} দিন আগে`],
    [/^(\d+)\s*(?:weeks?) ago$/i, (m) => `${m[1]} সপ্তাহ আগে`],
    [/^(\d+)\s*(?:months?) ago$/i, (m) => `${m[1]} মাস আগে`],
    [/^Unread (\d+)$/, (m) => `অপঠিত ${m[1]}`],
  ];

  // Word-level rules used inside mixed text (dates, money, units, counts, common verbs).
  const M = { jan: 'জানু', feb: 'ফেব্রু', mar: 'মার্চ', apr: 'এপ্রি', may: 'মে', jun: 'জুন', jul: 'জুলাই', aug: 'আগ', sep: 'সেপ্টে', sept: 'সেপ্টে', oct: 'অক্টো', nov: 'নভে', dec: 'ডিসে' };
  const D = { mon: 'সোম', tue: 'মঙ্গল', wed: 'বুধ', thu: 'বৃহস্পতি', fri: 'শুক্র', sat: 'শনি', sun: 'রবি' };
  const UNIT = { minute: 'মিনিট', min: 'মিনিট', hour: 'ঘণ্টা', day: 'দিন', week: 'সপ্তাহ', month: 'মাস', year: 'বছর',
    medicine: 'টি ওষুধ', item: 'টি আইটেম', reading: 'টি রিডিং', appointment: 'টি অ্যাপয়েন্টমেন্ট', request: 'টি অনুরোধ',
    account: 'টি অ্যাকাউন্ট', report: 'টি রিপোর্ট', test: 'টি টেস্ট', order: 'টি অর্ডার', patient: 'জন রোগী', doctor: 'জন ডাক্তার',
    donor: 'জন রক্তদাতা', dose: 'টি ডোজ', slot: 'টি স্লট', review: 'টি রিভিউ', trip: 'টি ট্রিপ', tablet: 'টি ট্যাবলেট', capsule: 'টি ক্যাপসুল' };
  // Only used when the text is short or already partly Bangla, so typed messages (chat, notes) are left as written.
  const WORDS = { Tablet: 'ট্যাবলেট', Capsule: 'ক্যাপসুল', Syrup: 'সিরাপ', Injection: 'ইনজেকশন', Drops: 'ড্রপ', Cream: 'ক্রিম',
    Suspension: 'সাসপেনশন', Inhaler: 'ইনহেলার', Sachet: 'স্যাশে', requested: 'অনুরোধ করেছেন', proposed: 'প্রস্তাব করেছেন',
    confirmed: 'নিশ্চিত', uploaded: 'আপলোড করেছে', shared: 'শেয়ার করেছেন', viewed: 'দেখেছেন', prefers: 'পছন্দ', stable: 'স্থিতিশীল',
    falling: 'কমছে', rising: 'বাড়ছে', better: 'ভালো', worse: 'খারাপ', same: 'একই', short: 'কম আছে', exp: 'মেয়াদ', average: 'গড়',
    normal: 'স্বাভাবিক', new: 'নতুন', pending: 'অপেক্ষমাণ', today: 'আজ', yesterday: 'গতকাল', tomorrow: 'আগামীকাল', to: 'থেকে', ago: 'আগে', Last: 'গত', Service: 'সেবা', Availability: 'প্রাপ্যতা',
    Price: 'দাম', Delivery: 'ডেলিভারি', Packaging: 'প্যাকেজিং', Quality: 'মান', Order: 'অর্ডার' };
  const tokenPass = (t) => {
    if (!/[A-Za-z]/.test(t)) return t;
    t = t.replace(/\bBDT\b/g, '৳');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s+(minute|min|hour|day|week|month|year|medicine|item|reading|appointment|request|account|report|test|order|patient|doctor|donor|dose|slot|review|trip|tablet|capsule)(?:e?s)?\b/gi,
      (m, n, u) => `${n} ${UNIT[u.toLowerCase()]}`);
    if (/\d/.test(t)) {
      t = t.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b/gi, (m) => M[m.toLowerCase()] || m);
      t = t.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/gi, (m) => D[m.toLowerCase()] || m);
    }
    const words = t.match(/[A-Za-z]+/g) || [];
    if (/[\u0980-\u09FF]/.test(t) || words.length <= 5) {
      t = t.replace(/\b[A-Za-z]+\b/g, (w) => (Object.prototype.hasOwnProperty.call(WORDS, w) ? WORDS[w] : w));
    }
    return t;
  };

  const translateString = (s) => {
    if (!s) return s;
    const trimmed = s.replace(/\s+/g, ' ').trim();
    if (!trimmed || !/[A-Za-z]/.test(trimmed)) return s;
    const lead = s.match(/^\s*/)[0];
    const tail = s.match(/\s*$/)[0];
    if (Object.prototype.hasOwnProperty.call(DICT, trimmed)) return lead + DICT[trimmed] + tail;
    for (const [re, fn] of PATTERNS) { const m = trimmed.match(re); if (m) return lead + fn(m) + tail; }
    let out = trimmed;
    if (fragRe) { fragRe.lastIndex = 0; out = out.replace(fragRe, (k) => DICT[k]); }
    out = tokenPass(out);
    return out === trimmed ? s : lead + out + tail;
  };

  // ---------- DOM walking ----------
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT']);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const ORIG_ATTR = new WeakMap(); // element -> {attr: original}
  let busy = false;

  const skipEl = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (SKIP.has(e.tagName) || e.isContentEditable || e.hasAttribute('data-no-i18n')) return true;
    }
    return false;
  };

  const doText = (node) => {
    if (node.__mcEn === undefined) node.__mcEn = node.nodeValue;
    const want = lang === 'bn' ? translateString(node.__mcEn) : node.__mcEn;
    if (node.nodeValue !== want) { node.nodeValue = want; node.__mcSet = want; }
    else node.__mcSet = want;
  };

  const doAttrs = (el) => {
    let orig = ORIG_ATTR.get(el);
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      if (!orig) { orig = {}; ORIG_ATTR.set(el, orig); }
      if (!(a in orig)) orig[a] = el.getAttribute(a);
      const want = lang === 'bn' ? translateString(orig[a]) : orig[a];
      if (el.getAttribute(a) !== want) el.setAttribute(a, want);
    }
    // Button-style inputs without a name only (a named value is submitted with the form).
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && !el.name && el.value) {
      if (!orig) { orig = {}; ORIG_ATTR.set(el, orig); }
      if (!('value' in orig)) orig.value = el.value;
      el.value = lang === 'bn' ? translateString(orig.value) : orig.value;
    }
  };

  const walk = (start) => {
    if (!start) return;
    if (start.nodeType === 3) { if (!skipEl(start.parentElement)) doText(start); return; }
    if (start.nodeType !== 1 || skipEl(start)) return;
    doAttrs(start);
    start.querySelectorAll('[placeholder],[title],[aria-label],[alt],input[type=submit],input[type=button]').forEach((el) => { if (!skipEl(el)) doAttrs(el); });
    const tw = document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (skipEl(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n; while ((n = tw.nextNode())) doText(n);
  };

  const apply = () => {
    busy = true;
    root.lang = lang === 'bn' ? 'bn' : 'en';
    root.classList.toggle('lang-bn', lang === 'bn');
    if (document.title) {
      if (root.__mcTitle === undefined) root.__mcTitle = document.title;
      document.title = lang === 'bn' ? translateString(root.__mcTitle) : root.__mcTitle;
    }
    walk(document.body);
    updateButtons();
    busy = false;
    root.classList.remove('i18n-wait');
  };

  // Content added later by scripts (toasts, chat, notifications, live updates).
  const observer = new MutationObserver((muts) => {
    if (busy) return;
    busy = true;
    for (const m of muts) {
      if (m.type === 'characterData') {
        const n = m.target;
        if (n.nodeValue !== n.__mcSet) { n.__mcEn = n.nodeValue; if (!skipEl(n.parentElement)) doText(n); }
      } else if (m.type === 'attributes') {
        const el = m.target; const orig = ORIG_ATTR.get(el);
        const cur = el.getAttribute(m.attributeName);
        if (orig && lang === 'bn' && cur !== translateString(orig[m.attributeName])) { orig[m.attributeName] = cur; doAttrs(el); }
      } else {
        m.addedNodes.forEach((n) => { if (n.nodeType === 3) n.__mcEn = undefined; walk(n); });
      }
    }
    busy = false;
  });

  // ---------- the switch button ----------
  const GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
  // The button always shows the language the page is in now: "English" or "বাংলা".
  const updateButtons = () => {
    document.querySelectorAll('[data-lang-toggle]').forEach((b) => {
      b.setAttribute('data-no-i18n', '');
      if (!b.querySelector('.lt-label')) b.innerHTML = `<span class="lt-globe">${GLOBE}</span><span class="lt-label"></span><span class="lt-switch" aria-hidden="true"></span>`;
      const bn = lang === 'bn';
      b.classList.toggle('is-bn', bn);
      b.querySelector('.lt-label').textContent = bn ? 'বাংলা' : 'English';
      const tip = bn ? 'Switch to English' : 'বাংলায় দেখুন (Switch to Bangla)';
      b.title = tip; b.setAttribute('aria-label', tip); b.setAttribute('aria-pressed', bn ? 'true' : 'false');
    });
  };

  const ensureButton = () => {
    if (document.querySelector('[data-lang-toggle]')) return;
    // Any page without the button in its markup gets a floating one in the top-right corner.
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang-toggle floating';
    b.setAttribute('data-lang-toggle', '');
    document.body.prepend(b);
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang-toggle]');
    if (!b) return;
    e.preventDefault();
    lang = lang === 'bn' ? 'en' : 'bn';
    setLang(lang);
    apply();
  });

  const start = () => {
    ensureButton();
    apply();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.MC_I18N = { t: (s) => (lang === 'bn' ? translateString(s) : s), lang: () => lang };
})();
