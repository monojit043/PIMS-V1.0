/* ══════════════════════════════════════════════
   PIMS — Piping Software Gateway — gateway-login.js
   Real auth against /api/login (same endpoint/session as the
   rest of PIMS) — always lands on gateway.html on success,
   regardless of the role-based redirect /api/login suggests,
   since arriving here means the user wants the launcher.
   ══════════════════════════════════════════════ */

// ─── THEME TOGGLE ─────────────────────────────
(function () {
  const root  = document.documentElement;
  const btn   = document.getElementById('themeToggle');
  const saved = localStorage.getItem('eil-theme');
  if (saved === 'light') root.setAttribute('data-theme', 'light');

  btn.addEventListener('click', () => {
    const isLight = root.getAttribute('data-theme') === 'light';
    if (isLight) {
      root.removeAttribute('data-theme');
      localStorage.setItem('eil-theme', 'dark');
    } else {
      root.setAttribute('data-theme', 'light');
      localStorage.setItem('eil-theme', 'light');
    }
  });
})();

// ─── FORM SUBMIT ──────────────────────────────
const form        = document.getElementById('loginForm');
const loginBtn     = document.getElementById('loginBtn');
const btnText      = document.getElementById('loginBtnText');
const errorBox     = document.getElementById('formError');
const errorText    = document.getElementById('formErrorText');
const employeeIdEl = document.getElementById('employeeId');
const passwordEl   = document.getElementById('password');

function showError(msg) {
  errorText.textContent = msg;
  errorBox.classList.add('visible');
  loginBtn.disabled = false;
  loginBtn.classList.remove('loading');
  btnText.textContent = 'AUTHENTICATE';
}

function clearError() {
  errorBox.classList.remove('visible');
}

employeeIdEl.addEventListener('input', clearError);
passwordEl.addEventListener('input', clearError);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const employeeId = employeeIdEl.value.trim();
  const password    = passwordEl.value;

  if (!employeeId) {
    employeeIdEl.focus();
    showError('Employee ID is required.');
    return;
  }
  if (!password) {
    passwordEl.focus();
    showError('Password is required.');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.classList.add('loading');
  btnText.textContent = 'CONNECTING';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, password })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showError(data.message || 'Invalid credentials. Please try again.');
      return;
    }

    window.location.href = '/gateway.html';
  } catch (err) {
    showError('Unable to reach server. Check your connection.');
  }
});

// Focus employee ID on load
employeeIdEl.focus();
