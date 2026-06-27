
/* ── Slideshow ── */
const slides = document.querySelectorAll('.bg-slide');
const pips = document.querySelectorAll('.slide-pip');
let cur = 0, timer;

function goTo(n) {
    slides[cur].classList.remove('active');
    pips[cur]?.classList.remove('active');
    cur = (n + slides.length) % slides.length;
    slides[cur].classList.add('active');
    pips[cur]?.classList.add('active');
}

timer = setInterval(() => goTo(cur + 1), 8000);

pips.forEach(pip => {
    pip.addEventListener('click', () => {
        clearInterval(timer);
        goTo(+pip.dataset.index);
        timer = setInterval(() => goTo(cur + 1), 8000);
    });
});

/* ── Eye toggle ── */
const pwInput = document.getElementById('password');
const eyeToggle = document.getElementById('eyeToggle');
const eyeSvg = document.getElementById('eyeSvg');

const EYE_OPEN = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />`;
const EYE_CLOSED = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />`;

eyeToggle.addEventListener('click', () => {
    const show = pwInput.type === 'password';
    pwInput.type = show ? 'text' : 'password';
    eyeSvg.innerHTML = show ? EYE_CLOSED : EYE_OPEN;
});

/* ── Form handling (fallback if login.js absent) ── */
document.getElementById('loginForm').addEventListener('submit', function (e) {
    if (typeof window.__pimsLoginHandled === 'undefined') return;
    e.preventDefault();

    const errEl = document.getElementById('loginError');
    const errText = document.getElementById('errorText');
    errEl.classList.remove('show');

    fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            employeeId: document.getElementById('employeeId').value,
            password: document.getElementById('password').value
        })
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                window.location.href = data.redirect || '/dashboard';
            } else {
                errText.textContent = data.message || 'Invalid credentials. Please try again.';
                errEl.classList.add('show');
            }
        })
        .catch(() => {
            errText.textContent = 'Unable to reach server. Check your connection.';
            errEl.classList.add('show');
        });
});

['employeeId', 'password'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
        document.getElementById('loginError').classList.remove('show');
    });
});

