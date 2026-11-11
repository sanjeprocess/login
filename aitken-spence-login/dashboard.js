// Signed-in page. Sends the user back to sign in when there is no valid session.
(async () => {
  const $ = (id) => document.getElementById(id);
  let token = null;
  try {
    token = sessionStorage.getItem('as_session');
  } catch {}

  const toLogin = () => {
    try {
      sessionStorage.removeItem('as_session');
    } catch {}
    location.replace('/');
  };
  if (!token) return toLogin();

  let me;
  try {
    const res = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return toLogin();
    me = await res.json();
  } catch {
    return toLogin();
  }

  const name = me.fullName || me.employeeID;
  $('who-name').textContent = name;
  $('who-id').textContent = me.employeeID;
  $('greeting').textContent = `Welcome, ${name}`;
  $('initials').textContent = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  $('main').hidden = false;

  // Session countdown; returns to sign in when it runs out.
  const endsAt = Date.now() + me.expiresInSeconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    $('session-left').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (left === 0) toLogin();
  };
  tick();
  setInterval(tick, 1000);

  $('btn-signout').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    } catch {}
    toLogin();
  });
})();
