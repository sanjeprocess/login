// Aitken Spence sign-in UI. Talks to server/server.js, which checks WorkHub24 and issues the OTP.
(() => {
  const MAX_ATTEMPTS = 3;

  const $ = (id) => document.getElementById(id);
  const steps = { id: $('step-id'), otp: $('step-otp'), done: $('step-done') };
  const tabs = document.querySelectorAll('.tabs [role="tab"]');
  const empInput = $('emp-id');
  const phoneInput = $('phone');
  const btnSend = $('btn-send');
  const btnVerify = $('btn-verify');
  const otpWrap = document.querySelector('.otp');
  const boxes = [...otpWrap.querySelectorAll('input')];

  let mode = 'emp';
  let attempts = MAX_ATTEMPTS;
  let challengeId = null;

  // --- API ------------------------------------------------------------------
  async function post(url, body) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw { code: 'NETWORK', message: 'Can’t reach the server. Check your connection and try again.' };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { status: res.status, ...data };
    return data;
  }
  const requestOtp = ({ mode, value }) => post('/api/auth/request-otp', { mode, value });
  const verifyOtp = (code) => post('/api/auth/verify-otp', { challengeId, code });

  // --- helpers --------------------------------------------------------------
  function show(name) {
    Object.entries(steps).forEach(([k, el]) => (el.hidden = k !== name));
  }
  function setError(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  function setLoading(btn, on) {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }
  function phoneDigits() {
    return phoneInput.value.replace(/\D/g, '').replace(/^0/, '');
  }
  function idValid() {
    if (mode === 'emp') return /^[A-Za-z0-9-]{3,20}$/.test(empInput.value.trim());
    return /^7\d{8}$/.test(phoneDigits());
  }
  function refreshSend() {
    btnSend.disabled = !idValid();
  }
  function code() {
    return boxes.map((b) => b.value).join('');
  }
  function refreshVerify() {
    btnVerify.disabled = code().length !== 6 || attempts === 0;
  }
  function clearOtp() {
    boxes.forEach((b) => (b.value = ''));
    refreshVerify();
  }

  // --- step 1: identifier ---------------------------------------------------
  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode;
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      $('field-emp').hidden = mode !== 'emp';
      $('field-phone').hidden = mode !== 'phone';
      setError($('id-error'));
      document.querySelectorAll('.input-wrap').forEach((w) => w.classList.remove('invalid'));
      (mode === 'emp' ? empInput : phoneInput).focus();
      refreshSend();
    })
  );

  empInput.addEventListener('input', () => {
    empInput.value = empInput.value.toUpperCase();
    refreshSend();
  });
  phoneInput.addEventListener('input', () => {
    const d = phoneInput.value.replace(/\D/g, '').slice(0, 10);
    // Format as 77 123 4567 (keeps an optional leading 0)
    const lead = d.startsWith('0') ? '0' : '';
    const n = d.slice(lead.length);
    phoneInput.value = lead + [n.slice(0, 2), n.slice(2, 5), n.slice(5, 9)].filter(Boolean).join(' ');
    refreshSend();
  });

  async function sendCode() {
    const value = mode === 'emp' ? empInput.value.trim() : phoneDigits();
    const r = await requestOtp({ mode, value });
    challengeId = r.challengeId;
    $('emp-name').textContent = r.fullName || '—';
    $('emp-code').textContent = r.employeeID;
    $('sent-to').textContent = r.maskedPhone;
    $('emp-initials').textContent = (r.fullName || r.employeeID)
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    attempts = MAX_ATTEMPTS;
    clearOtp();
    otpWrap.classList.remove('invalid');
    setError($('otp-error'));
  }

  $('form-id').addEventListener('submit', async (e) => {
    e.preventDefault();
    const wrap = (mode === 'emp' ? empInput : phoneInput).closest('.input-wrap');
    if (!idValid()) {
      wrap.classList.add('invalid');
      setError($('id-error'), mode === 'emp' ? 'Enter a valid User ID.' : 'Enter a valid Sri Lankan mobile number, e.g. 77 123 4567.');
      return;
    }
    wrap.classList.remove('invalid');
    setError($('id-error'));
    setLoading(btnSend, true);
    try {
      await sendCode();
      show('otp');
      boxes[0].focus();
    } catch (err) {
      if (err.code === 'NOT_FOUND') wrap.classList.add('invalid');
      setError($('id-error'), err.message || 'We couldn’t send the code. Please try again.');
    } finally {
      setLoading(btnSend, false);
      refreshSend();
    }
  });

  // --- step 2: OTP ----------------------------------------------------------
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      otpWrap.classList.remove('invalid');
      refreshVerify();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => {
      const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
      if (!t) return;
      e.preventDefault();
      boxes.forEach((b, j) => (b.value = t[j] || ''));
      boxes[Math.min(t.length, 5)].focus();
      refreshVerify();
    });
  });

  $('form-otp').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (code().length !== 6) return;
    setLoading(btnVerify, true);
    setError($('otp-error'));
    let session;
    try {
      session = await verifyOtp(code());
    } catch (err) {
      setLoading(btnVerify, false);
      if (err.code === 'OTP_INCORRECT' || err.code === 'OTP_LOCKED' || err.code === 'OTP_EXPIRED') {
        attempts = err.code === 'OTP_INCORRECT' ? err.attemptsLeft : 0;
        otpWrap.classList.add('invalid', 'shake');
        setTimeout(() => otpWrap.classList.remove('shake'), 400);
      }
      setError(
        $('otp-error'),
        err.code === 'OTP_INCORRECT'
          ? `That code is not correct. ${attempts} attempt${attempts === 1 ? '' : 's'} left.`
          : err.message || 'The code could not be checked. Please try again.'
      );
      clearOtp();
      boxes.forEach((b) => (b.disabled = attempts === 0));
      if (attempts > 0) boxes[0].focus();
      return;
    }
    setLoading(btnVerify, false);
    try {
      sessionStorage.setItem('as_session', session.token);
    } catch {}
    $('t-done').textContent = `Welcome, ${session.employee.fullName || session.employee.employeeID}`;
    show('done');
    setTimeout(() => location.assign(session.redirectUrl || '/dashboard.html'), 1200);
  });

  $('btn-resend').addEventListener('click', async () => {
    const btn = $('btn-resend');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await sendCode();
      boxes.forEach((b) => (b.disabled = false));
      boxes[0].focus();
      btn.textContent = 'Code sent ✓';
      setTimeout(() => (btn.textContent = 'Resend code'), 2000);
    } catch (err) {
      btn.textContent = 'Resend code';
      setError($('otp-error'), err.message || 'We couldn’t send a new code. Please try again.');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-back').addEventListener('click', () => {
    show('id');
    (mode === 'emp' ? empInput : phoneInput).focus();
  });

  empInput.focus();
})();
