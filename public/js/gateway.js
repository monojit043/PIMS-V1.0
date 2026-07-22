/* ══════════════════════════════════════════════
   PIMS — Piping Software Gateway — gateway.js
   ══════════════════════════════════════════════ */

// ─── AUTH (real PIMS session, same pattern as every other page) ──
// Redirects to the Gateway's own login (not PIMS's /index.html) — arriving
// here means the user entered through the Gateway, so an expired session or
// a manual sign-out should return them to the same front door, not the
// generic PIMS one. Every other PIMS page keeps redirecting to /index.html
// as before; this is the one page that's different, by design.
(async function () {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { window.location.href = '/gateway-login.html'; return; }
    const me = await res.json();
    const el = document.getElementById('sidebarUser');
    if (el && me && me.name) el.textContent = `${me.name} (${me.id})`.toUpperCase().slice(0, 24);
  } catch {
    window.location.href = '/gateway-login.html';
    return;
  }

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/gateway-login.html';
  });
})();

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

// ─── SIDEBAR TOGGLE ───────────────────────────
(function () {
  const layout   = document.getElementById('layout');
  const backdrop = document.getElementById('sidebarBackdrop');
  const toggleBtn = document.getElementById('sidebarToggle');
  const MOBILE_BP = 860;

  function isMobile() { return window.innerWidth <= MOBILE_BP; }

  toggleBtn.addEventListener('click', () => {
    if (isMobile()) {
      layout.classList.toggle('sidebar-open');
    } else {
      layout.classList.toggle('sidebar-collapsed');
    }
  });

  backdrop.addEventListener('click', () => {
    layout.classList.remove('sidebar-open');
  });

  // Clean up classes when viewport crosses breakpoint
  window.addEventListener('resize', () => {
    if (!isMobile()) {
      layout.classList.remove('sidebar-open');
    } else {
      layout.classList.remove('sidebar-collapsed');
    }
  });
})();

// ─── CLOCK ────────────────────────────────────
function updateClock() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  const ss  = String(now.getSeconds()).padStart(2, '0');
  document.getElementById('clock').textContent = `${hh}:${mm}:${ss}`;
}
updateClock();
setInterval(updateClock, 1000);

// ─── GLOBAL SEARCH (placeholder — no backend yet) ─────
// Opens the dropdown on focus/typing so the category layout (Lines / Line
// Items / MDS Documents) is visible and feels real, but each category just
// says "Not connected yet" — no fabricated results. Wire up one category
// at a time once a real search endpoint exists, same pattern as the KPIs.
(function () {
  const wrap  = document.getElementById('topbarSearch');
  const input = document.getElementById('globalSearchInput');
  if (!wrap || !input) return;

  input.addEventListener('focus', () => wrap.classList.add('active'));
  input.addEventListener('input', () => wrap.classList.add('active'));

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) wrap.classList.remove('active');
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { wrap.classList.remove('active'); input.blur(); }
  });
})();

// ─── LAUNCH APP ───────────────────────────────
// Every module (including PIMS itself) opens in a new tab — the Gateway
// stays open in the original tab so it acts as a persistent launcher. The
// sidebar SYSTEMS list is the only launcher now (no app-card grid on the
// page); items without data-url (PPMS, IPMCS, Add Application) get no
// click handler at all, per .sys-item--soon / .sys-item--add in gateway.css.
function launchApp(url, name) {
  if (!url || url === '#') return;

  const overlay = document.getElementById('launchOverlay');
  const msg     = document.getElementById('launchMsg');
  msg.textContent = `Connecting to ${name}…`;
  overlay.classList.add('active');

  setTimeout(() => { window.open(url, '_blank'); }, 800);
  setTimeout(() => { overlay.classList.remove('active'); }, 1500);
}

// ─── SIDEBAR SYSTEM LAUNCH ────────────────────
const launchableItems = Array.from(document.querySelectorAll('.sys-item[data-url]'));
launchableItems.forEach(item => {
  item.addEventListener('click', () => {
    launchApp(item.dataset.url, item.dataset.name || item.querySelector('.sys-code')?.textContent.trim());
    if (window.innerWidth <= 860) {
      document.getElementById('layout').classList.remove('sidebar-open');
    }
  });
});

// ─── KEYBOARD SHORTCUTS ───────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const idx = parseInt(e.key) - 1;
  if (idx >= 0 && idx < launchableItems.length) {
    launchableItems[idx].click();
  }

  if (e.key === 'Escape') {
    document.getElementById('launchOverlay').classList.remove('active');
    document.getElementById('layout').classList.remove('sidebar-open');
  }
});

// ─── PROGRESS SUMMARY — DEMO DATA REVEAL ──────
// Arbitrary illustrative numbers, not a real feed. Populated 2s after load
// so the mosaic reads as a working dashboard for presentation purposes —
// see KPI-connection plan in project memory for the real, one-at-a-time
// backend wiring this will eventually be replaced with.
function setGauge(tileId, percent, circumference, mainText, smallText, captionId, captionText) {
  const tile = document.getElementById(tileId);
  if (!tile) return;
  const sweep = tile.querySelector('.kpi-ring-sweep');
  if (sweep) {
    const arc = +(circumference * percent / 100).toFixed(1);
    const rest = +(circumference - arc).toFixed(1);
    sweep.style.animation = 'none';
    sweep.style.transition = 'none';
    sweep.setAttribute('stroke-dasharray', `${arc} ${rest}`);
  }
  const valueEl = tile.querySelector('.kpi-gauge-value');
  if (valueEl && mainText != null) {
    valueEl.firstChild.textContent = mainText;
    const small = valueEl.querySelector('small');
    if (small && smallText) small.textContent = smallText;
  }
  if (captionId && captionText) {
    const cap = document.getElementById(captionId);
    if (cap) cap.textContent = captionText;
  }
}

function setStackedBars(tileId, buckets) {
  // buckets: [[modelled, total], ...] — bar height reflects each bucket's
  // total (scaled against the largest bucket), split internally into a
  // bright "modelled" segment and a dim "remaining" segment.
  const maxTotal = Math.max(...buckets.map(b => b[1]));
  document.querySelectorAll(`#${tileId} .bar-col`).forEach((col, i) => {
    const bucket = buckets[i];
    if (!bucket) return;
    const [modelled, total] = bucket;
    const remaining = total - modelled;
    const stack = col.querySelector('.bar-stack');
    if (!stack) return;
    stack.style.height = Math.round((total / maxTotal) * 88) + '%';
    stack.querySelector('.bar-remaining').style.height = Math.round((remaining / total) * 100) + '%';
    stack.querySelector('.bar-modelled').style.height = Math.round((modelled / total) * 100) + '%';
    const val = document.createElement('span');
    val.className = 'bar-value';
    val.textContent = `${modelled}/${total}`;
    col.insertBefore(val, stack);
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function setComboChart(tileId, weeklyValues) {
  // Weekly bars scaled to the tallest week; an overlaid cumulative line
  // scaled independently to the running total, sharing the same baseline.
  const baseline = 140, barMaxH = 100, lineMaxH = 120;
  const maxWeekly = Math.max(...weeklyValues);
  let running = 0;
  const cumulative = weeklyValues.map(v => (running += v));
  const maxCumulative = cumulative[cumulative.length - 1];

  const bars = document.querySelectorAll(`#${tileId} #kpi-iso-bars .combo-bar`);
  const valuesGroup = document.getElementById('kpi-iso-bar-values');
  const dotsGroup = document.getElementById('kpi-iso-cum-dots');
  const points = [];

  // Real calendar week-ending dates, most recent = today.
  const today = new Date();
  const labelEls = document.querySelectorAll(`#${tileId} .kpi-combo-labels span`);
  labelEls.forEach((el, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - 7 * (labelEls.length - 1 - i));
    el.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  bars.forEach((bar, i) => {
    const v = weeklyValues[i];
    if (v == null) return;
    const h = Math.round((v / maxWeekly) * barMaxH);
    const x = parseFloat(bar.getAttribute('x'));
    const w = parseFloat(bar.getAttribute('width'));
    bar.setAttribute('y', baseline - h);
    bar.setAttribute('height', h);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'combo-bar-value');
    label.setAttribute('x', x + w / 2);
    label.setAttribute('y', baseline - h - 6);
    label.textContent = v;
    valuesGroup.appendChild(label);

    const cy = baseline - Math.round((cumulative[i] / maxCumulative) * lineMaxH);
    points.push(`${x + w / 2},${cy}`);

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'combo-dot');
    dot.setAttribute('cx', x + w / 2);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', 2.5);
    dotsGroup.appendChild(dot);
  });

  const pointsStr = points.join(' ');
  document.querySelector(`#${tileId} .kpi-combo-line-track`).setAttribute('points', pointsStr);
  document.getElementById('kpi-iso-cum-line').setAttribute('points', pointsStr);

  return { total: maxCumulative };
}

// STATUS_RULES: placeholder thresholds only — tune once real per-metric
// targets are agreed with the GL/HOD. Percent metrics: >=75 good, 50-74
// watch, <50 risk. "dept-hold" is a count where lower is better, so its
// scale is inverted (see setStatusStrip). Delete this + setStatusStrip()
// + #statusStrip in gateway.html/gateway.css to fully revert the strip.
function classifyPercent(pct) {
  if (pct >= 75) return 'good';
  if (pct >= 50) return 'watch';
  return 'risk';
}

function setStatusStrip() {
  const metrics = [
    ['iso-issued',      '77%', classifyPercent(77)],
    ['model-review',    '30%', classifyPercent(30)],
    ['line-modelling',  '65%', classifyPercent(65)],
    ['iso-worked',      '224', 'info'],
    ['ppms',            '64%', classifyPercent(64)],
    ['special-support', '64%', classifyPercent(64)],
    ['gad',             '72%', classifyPercent(72)],
    ['nozzle',          '91%', classifyPercent(91)],
    ['clip-drawings',   '58%', classifyPercent(58)],
    ['mds',             '74%', classifyPercent(74)],
    ['vendor-drawings', '47%', classifyPercent(47)],
    ['mr-released',     '61%', classifyPercent(61)],
    ['dept-hold',       '30',  30 >= 30 ? 'risk' : (30 >= 15 ? 'watch' : 'good')],
  ];
  metrics.forEach(([key, text, status]) => {
    const chip = document.querySelector(`.status-chip[data-metric="${key}"]`);
    if (!chip) return;
    chip.setAttribute('data-status', status);
    chip.querySelector('.status-chip-value').textContent = text;
  });
}

function setBarChart(tileId, values, captionId, captionText) {
  const max = Math.max(...values);
  document.querySelectorAll(`#${tileId} .bar-col`).forEach((col, i) => {
    const bar = col.querySelector('.bar');
    if (!bar || values[i] == null) return;
    bar.style.height = Math.round((values[i] / max) * 88) + '%';
    const val = document.createElement('span');
    val.className = 'bar-value';
    val.textContent = values[i];
    col.insertBefore(val, bar);
  });
  if (captionId && captionText) {
    const cap = document.getElementById(captionId);
    if (cap) cap.textContent = captionText;
  }
}

function revealDemoData() {
  setStatusStrip();
  const asOfToday = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  setGauge('kpi-ppms-progress', 64, 238.8, '14/22', 'completed', 'kpi-ppms-caption', `${asOfToday} · 64% complete`);
  setGauge('kpi-special-support', 64, 226.2, '9/14', 'issued', 'kpi-special-support-caption', '64% issued');
  setGauge('kpi-gad', 72, 226.2, '18/25', 'issued', 'kpi-gad-caption', '72% issued');
  setGauge('kpi-nozzle', 91, 226.2, '42/46', 'issued', 'kpi-nozzle-caption', '91% issued');
  setGauge('kpi-clip-drawings', 58, 226.2, '58%', null, 'kpi-clip-drawings-caption', '67 / 115 issued');
  setGauge('kpi-mds-availability', 74, 226.2, '74%', null, 'kpi-mds-availability-caption', '89 / 120 available');
  setGauge('kpi-vendor-drawings', 47, 226.2, '47%', null, 'kpi-vendor-drawings-caption', '38 / 81 received');
  setGauge('kpi-mr-released', 61, 226.2, '11/18', 'released', 'kpi-mr-released-caption', '61% released');

  // Model Review Status — milestone timeline
  const mrBar = document.querySelector('#kpi-model-review .kpi-milestone-bar');
  if (mrBar) {
    mrBar.querySelector('.done').style.width = '30%';
    mrBar.querySelector('.planned').style.width = '30%';
    mrBar.querySelector('.unplanned').style.width = '30%';
  }
  document.getElementById('kpi-mr-done-pct').textContent = '30%';
  document.getElementById('kpi-mr-done-dates').textContent = 'Jan 5 – Apr 18, 2026';
  document.getElementById('kpi-mr-planned-pct').textContent = '60%';
  document.getElementById('kpi-mr-planned-dates').textContent = 'Apr 19 – Sep 30, 2026';
  document.getElementById('kpi-mr-unplanned-pct').textContent = '90%';
  document.getElementById('kpi-mr-unplanned-dates').textContent = 'Dates not yet planned';

  // ISO Issued / Total ISO — revision-wise breakdown (Rev 0..Rev 4+)
  setBarChart('kpi-iso-issued', [41, 27, 12, 4, 2], 'kpi-iso-issued-caption', '86 of 112 total · 77% issued');

  // Line Modelling Status — modelled/total headline + per-size-range stacked bars
  document.getElementById('kpi-lm-fraction').textContent = '493 / 755';
  setStackedBars('kpi-line-modelling', [[93, 142], [203, 310], [134, 205], [63, 98]]);
  const lmCaption = document.getElementById('kpi-line-modelling-caption');
  if (lmCaption) lmCaption.textContent = '65% modelled overall';

  // ISO Worked On — weekly bars + cumulative achievement curve
  const { total: isoTotal } = setComboChart('kpi-iso-worked', [22, 28, 19, 34, 25, 31, 29, 36]);
  const isoWorkedCaption = document.getElementById('kpi-iso-worked-caption');
  if (isoWorkedCaption) isoWorkedCaption.textContent = `${isoTotal} ISOs issued over 8 weeks`;

  // Other Departments Hold — labels, counts, bar widths
  const deptData = [['Civil', 32, 6], ['Structural', 58, 11], ['Electrical', 20, 4], ['Instrumentation', 46, 9]];
  const deptMax = Math.max(...deptData.map(d => d[1]));
  document.querySelectorAll('#kpi-dept-hold .kpi-hbar-row').forEach((row, i) => {
    const [name, pct, count] = deptData[i] || [];
    if (!name) return;
    const label = document.createElement('span');
    label.className = 'kpi-hbar-label';
    label.textContent = name;
    row.insertBefore(label, row.firstChild);
    const fill = row.querySelector('.kpi-hbar-fill');
    if (fill) fill.style.width = Math.round((pct / deptMax) * 100) + '%';
    const countEl = document.createElement('span');
    countEl.className = 'kpi-hbar-count';
    countEl.textContent = count;
    row.appendChild(countEl);
  });
  const deptCaption = document.getElementById('kpi-dept-hold-caption');
  if (deptCaption) deptCaption.textContent = '30 lines on hold across 4 departments';
}

setTimeout(revealDemoData, 2000);
