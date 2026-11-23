// Live demo: a role button fills in its demo account and logs in at once.
(() => {
  const form = document.querySelector('[data-login-form]');
  if (!form) return;
  document.querySelectorAll('[data-demo]').forEach((btn) => btn.addEventListener('click', () => {
    form.querySelector('input[name="email"]').value = btn.dataset.demo;
    form.querySelector('input[name="password"]').value = 'Password123';
    btn.textContent = 'Logging in...';
    form.submit();
  }));
})();
