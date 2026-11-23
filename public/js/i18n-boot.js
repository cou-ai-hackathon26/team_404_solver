/* Runs before the page paints: if the user chose Bangla, hide the page until it is translated (max 1.5 s). */
(function () {
  var l = null;
  try { l = localStorage.getItem('mc_lang'); } catch (e) { /* ignore */ }
  if (!l) { var m = document.cookie.match(/(?:^|;\s*)mc_lang=(\w+)/); l = m ? m[1] : 'en'; }
  if (l === 'bn') {
    var r = document.documentElement;
    r.classList.add('i18n-wait', 'lang-bn'); r.lang = 'bn';
    setTimeout(function () { r.classList.remove('i18n-wait'); }, 1500);
  }
})();
