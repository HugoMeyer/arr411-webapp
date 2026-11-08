(function () {
  'use strict';
  const form = document.getElementById('form');
  const user = document.getElementById('u');
  const pass = document.getElementById('p');
  const go = document.getElementById('go');
  const err = document.getElementById('err');
  const eye = document.getElementById('eye');

  // Same rule as the server: only a local path (printable ASCII, no "//" or "/\" at the start), never the login or API routes.
  function destination() {
    const v = new URLSearchParams(location.search).get('next') || '/';
    return /^\/(?![/\\])[\x21-\x7e]*$/.test(v) && !/^\/(login|api)(\/|\?|$)/i.test(v) && v.length <= 2000 ? v : '/';
  }

  function show(msg) {
    err.textContent = msg;
    err.hidden = !msg;
  }

  function busy(on) {
    go.disabled = on;
    go.classList.toggle('busy', on);
  }

  async function failure(r) {
    let data = null;
    try {
      data = await r.json();
    } catch (e) {
      /* not JSON (proxy error page, for instance) */
    }
    if (r.status === 401) return 'Identifiant ou mot de passe incorrect.';
    if (data && data.message) return data.message;
    return 'Connexion impossible (erreur ' + r.status + ').';
  }

  eye.addEventListener('click', () => {
    const reveal = pass.type === 'password';
    pass.type = reveal ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(reveal));
    eye.setAttribute('aria-label', reveal ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    pass.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const username = user.value.trim();
    const password = pass.value;
    if (!username || !password) {
      show('Saisis ton identifiant et ton mot de passe.');
      (username ? pass : user).focus();
      return;
    }
    show('');
    busy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'arr411' },
        body: JSON.stringify({ username, password })
      });
      if (r.ok) return location.replace(destination());
      show(await failure(r));
      pass.value = '';
      pass.focus();
    } catch (e) {
      show('Serveur injoignable. Vérifie ta connexion puis réessaie.');
    }
    busy(false);
  });

  // The page can come back from the back/forward cache with the button still locked.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) busy(false);
  });

  if (window.matchMedia && matchMedia('(hover: hover)').matches) user.focus();
})();
