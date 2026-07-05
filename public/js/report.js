/* ════════════════════════════════════════════════
   PIMS Report Module — report.js
════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────
let selectedJob = '';
let selectedUnits = [];
let allUnits = [];
let userProjects = [];
let allLineData = [];       // full dataset from API
let filteredData = [];      // after search/filter
let _lotsData = [];         // lot report data
let _activeLotTag = null;   // currently active tag filter
let sortCol = 'slNo';
let sortDir = 'asc';
let currentPage = 1;
let perPage = 50;

// Chart instances
let chartStatus = null, chartRev = null, chartFunnel = null, chartUnits = null;

// Status → CSS badge class mapping
const STATUS_BADGE = {
  'Uploaded':                 'badge-uploaded',
  'Under Review':             'badge-review',
  'Sent for Supporting Check':'badge-review',
  'GL Commented':             'badge-comment',
  'SGL Commented':            'badge-comment',
  'Ready for GL':             'badge-gl',
  'Ready for SGL':            'badge-gl',
  'Ready for EDMS':           'badge-final',
  'Final':                    'badge-final',
  'Superseded':               'badge-superseded',
};
function getStatusBadge(status) {
  if (status?.startsWith('Comments Received')) return 'badge-comment';
  return STATUS_BADGE[status] || 'badge-uploaded';
}

const STATUS_COLORS = {
  'Uploaded':                 '#8a9c7c',
  'Under Review':             '#c8922a',
  'Sent for Supporting Check':'#dfa83c',
  'GL Commented':             '#e07050',
  'SGL Commented':            '#e07050',
  'Ready for GL':             '#7b5ea7',
  'Ready for SGL':            '#9b7ec7',
  'Ready for EDMS':           '#3a7d44',
  'Final':                    '#2a5c34',
  'Superseded':               '#aaa',
};
function getStatusColor(status) {
  if (status?.startsWith('Comments Received')) return '#c9644a';
  return STATUS_COLORS[status] || '#aaa';
}

// ── Init ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initSidebar();
  initUnitPicker();
  initTableSort();
  await loadUser();
  await loadProjects();

  document.getElementById('tableSearch').addEventListener('input', applyFilters);
  document.getElementById('filterStatus').addEventListener('change', applyFilters);
  document.getElementById('filterCritical').addEventListener('change', applyFilters);
  document.getElementById('filterUnit').addEventListener('change', applyFilters);
  document.getElementById('perPageSelect').addEventListener('change', e => {
    perPage = parseInt(e.target.value);
    currentPage = 1;
    renderTable();
  });
});

// ── Sidebar collapse ──────────────────────────
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('collapseBtn');
  const overlay = document.getElementById('sidebarOverlay');
  const mobBtn = document.getElementById('mobMenuBtn');

  btn?.addEventListener('click', () => sidebar.classList.toggle('collapsed'));

  mobBtn?.addEventListener('click', () => {
    sidebar.classList.add('mob-open');
    overlay.classList.add('visible');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('mob-open');
    overlay.classList.remove('visible');
  });
}

function scrollToSection(id) {
  // Ensure the normal report sections are visible and batch is hidden
  ['sec-kpi','sec-charts','sec-register','sec-activity','sec-lots'].forEach(function(sid) {
    const el = document.getElementById(sid);
    if (el) el.style.display = 'block';
  });
  const batchSec = document.getElementById('sec-batch');
  if (batchSec) batchSec.style.display = 'none';

  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // update active nav btn
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const sectionMap = {
    'sec-kpi': 0, 'sec-charts': 1, 'sec-register': 2, 'sec-activity': 3, 'sec-lots': 4,
  };
  const idx = sectionMap[id];
  if (idx !== undefined) document.querySelectorAll('.nav-btn')[idx]?.classList.add('active');
}
window.scrollToSection = scrollToSection;

// ── Load user ─────────────────────────────────
async function loadUser() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) { window.location.href = '/index.html'; return; }
    const me = await res.json();
    document.getElementById('sbUserName').textContent = me.name || 'User';
    document.getElementById('sbUserRole').textContent = me.id || '';
    const initials = (me.name || 'U').split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase();
    document.getElementById('sbAvatar').textContent = initials;
  } catch { window.location.href = '/index.html'; }
}

// ── Load projects ─────────────────────────────
async function loadProjects() {
  try {
    const res = await fetch('/api/projects/assigned');
    if (!res.ok) return;
    const data = await res.json();
    userProjects = data.projects || [];
    const sel = document.getElementById('jobSelect');
    userProjects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.id} — ${p.name || p.id}`;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', onJobChange);
  } catch (e) { console.error(e); }
}

async function onJobChange() {
  selectedJob = document.getElementById('jobSelect').value;
  selectedUnits = [];
  allUnits = [];
  renderUnitList('');
  document.getElementById('unitTriggerLabel').textContent = '— Select Units —';
  if (!selectedJob) return;
  try {
    const res = await fetch(`/api/projects/${selectedJob}/units`);
    const data = await res.json();
    allUnits = [...new Set(Object.values(data.units || {}).flat())].sort();
    renderUnitList('');
  } catch (e) { console.error(e); }
}

// ── Unit multi-select ─────────────────────────
function initUnitPicker() {
  const trigger = document.getElementById('unitTrigger');
  const dropdown = document.getElementById('unitDropdown');
  const searchInput = document.getElementById('unitSearchInput');
  const okBtn = document.getElementById('unitOkBtn');
  const clearBtn = document.getElementById('unitClearBtn');

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    if (!selectedJob) { showToast('Select a Job No first'); return; }
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('unitPicker').contains(e.target)) dropdown.classList.remove('open');
  });
  searchInput.addEventListener('input', e => renderUnitList(e.target.value));
  okBtn.addEventListener('click', () => {
    selectedUnits = [...document.querySelectorAll('#unitList input:checked')].map(c => c.value);
    updateUnitLabel();
    dropdown.classList.remove('open');
  });
  clearBtn.addEventListener('click', () => {
    selectedUnits = [];
    document.querySelectorAll('#unitList input').forEach(c => c.checked = false);
    updateUnitLabel();
  });
}

function renderUnitList(search) {
  const list = document.getElementById('unitList');
  const filtered = allUnits.filter(u => u.toLowerCase().includes(search.toLowerCase()));
  list.innerHTML = filtered.length ? filtered.map(u => `
    <div class="unit-item">
      <input type="checkbox" id="u_${u}" value="${u}" ${selectedUnits.includes(u) ? 'checked' : ''}>
      <label for="u_${u}">${u}</label>
    </div>`).join('') : '<div style="padding:10px;color:var(--bark-muted);font-size:12px">No units found</div>';
}

function updateUnitLabel() {
  const lbl = document.getElementById('unitTriggerLabel');
  lbl.textContent = selectedUnits.length ? selectedUnits.join(', ') : '— Select Units —';
}

// ── Fetch report ──────────────────────────────
async function fetchReport() {
  if (!selectedJob) { showToast('Select a Job No'); return; }
  if (!selectedUnits.length) { showToast('Select at least one Unit'); return; }

  showToast('Fetching report…');

  try {
    const q = `jobNo=${encodeURIComponent(selectedJob)}&units=${selectedUnits.map(encodeURIComponent).join(',')}`;

    const [summaryRes, linesRes, activityRes, lotsRes] = await Promise.all([
      fetch(`/api/report/summary?${q}`),
      fetch('/api/report/all-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobNo: selectedJob, units: selectedUnits }),
      }),
      fetch(`/api/report/user-activity?${q}`),
      fetch(`/api/report/lots?${q}`),
    ]);

    const summaryData  = await summaryRes.json();
    const linesData    = await linesRes.json();
    const activityData = await activityRes.json();
    const lotsData     = await lotsRes.json();

    if (summaryData.ok) renderSummary(summaryData.summary);
    if (linesData.success) {
      allLineData = linesData.data || [];
      populateUnitFilter();
      applyFilters();
    }
    if (activityData.ok) renderActivity(activityData.activity, summaryData.summary);

    // Lots section — isolated so a failure here never breaks the rest of the report
    try {
      if (lotsData.ok) renderLotsReport(lotsData.lots || []);
    } catch (lotsErr) {
      console.error('renderLotsReport error:', lotsErr);
    }

    showToast(`✓ Report loaded — ${allLineData.length} lines`);
  } catch (err) {
    console.error(err);
    showToast('Failed to fetch report');
  }
}
window.fetchReport = fetchReport;

// ── KPI render ────────────────────────────────
function renderSummary(s) {
  const proj = userProjects.find(p => p.id === selectedJob);
  document.getElementById('kpiJobLabel').textContent = proj ? `${proj.id} · ${selectedUnits.join(', ')}` : selectedJob;
  document.getElementById('kpiGenTime').textContent = `Generated: ${new Date().toLocaleString()}`;

  document.getElementById('kpiTotal').textContent = s.total;
  document.getElementById('kpiTotalSub').textContent = `${s.completionPct}% overall completion`;

  document.getElementById('kpiCompleted').textContent = s.completed;
  document.getElementById('kpiCompletedSub').textContent = `${s.total ? Math.round(s.completed*100/s.total) : 0}% of total`;
  document.getElementById('kpiCompletedBar').style.width = (s.total ? s.completed*100/s.total : 0) + '%';

  document.getElementById('kpiInProgress').textContent = s.inProgress;
  document.getElementById('kpiInProgressSub').textContent = `${s.total ? Math.round(s.inProgress*100/s.total) : 0}% of total`;
  document.getElementById('kpiInProgressBar').style.width = (s.total ? s.inProgress*100/s.total : 0) + '%';

  document.getElementById('kpiPending').textContent = s.pending;
  document.getElementById('kpiPendingBar').style.width = (s.total ? s.pending*100/s.total : 0) + '%';

  document.getElementById('kpiCritical').textContent = s.stressCritical;

  renderCharts(s);
}

// ── Charts ────────────────────────────────────
function renderCharts(s) {
  renderStatusChart(s.statusDist);
  renderRevChart(s.revDist);
  renderFunnelChart(s.checkerActivity, s.total);
  renderUnitChart(s.unitBreakdown);
}

function renderStatusChart(statusDist) {
  const labels = Object.keys(statusDist);
  const data = labels.map(l => statusDist[l]);
  const colors = labels.map(l => getStatusColor(l));

  if (chartStatus) chartStatus.destroy();
  chartStatus = new Chart(document.getElementById('chartStatus'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#faf6ee' }] },
    options: {
      cutout: '62%',
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => ` ${ctx.label}: ${ctx.parsed} lines`
      }}},
      responsive: true, maintainAspectRatio: false,
    }
  });

  // Legend
  const leg = document.getElementById('legendStatus');
  leg.innerHTML = labels.map((l, i) => `
    <div class="leg-item">
      <div class="leg-dot" style="background:${colors[i]}"></div>
      <span>${l} (${data[i]})</span>
    </div>`).join('');
}

function renderRevChart(revDist) {
  const labels = Object.keys(revDist).sort();
  const data = labels.map(l => revDist[l]);
  const palette = ['#c8922a','#3a7d44','#2d5c8a','#7b5ea7','#c9644a','#8a9c7c'];

  if (chartRev) chartRev.destroy();
  chartRev = new Chart(document.getElementById('chartRev'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        borderRadius: 6, borderSkipped: false }]
    },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => ` ${ctx.parsed.y} lines`
      }}},
      scales: {
        x: { grid: { display: false }, ticks: { color: '#7a5430', font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(200,146,42,0.08)' },
          ticks: { color: '#7a5430', font: { size: 11 }, precision: 0 } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });

  const leg = document.getElementById('legendRev');
  leg.innerHTML = labels.map((l, i) => `
    <div class="leg-item">
      <div class="leg-dot" style="background:${palette[i % palette.length]}"></div>
      <span>${l}: ${revDist[l]}</span>
    </div>`).join('');
}

function renderFunnelChart(ca, total) {
  const labels = ['Total Lines', 'PC Checked', 'MC Checked', 'SC Checked', 'Incorporated', 'GL Reviewed', 'SGL Reviewed'];
  const values = [total, ca.pcChecked, ca.mcChecked, ca.scChecked, ca.incorporated, ca.glReviewed, ca.sglReviewed];
  const colors = ['#c8922a','#2d5c8a','#3a7d44','#c9644a','#7b5ea7','#687860','#dfa83c'];

  if (chartFunnel) chartFunnel.destroy();
  chartFunnel = new Chart(document.getElementById('chartFunnel'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderRadius: 6, borderSkipped: false, barThickness: 22 }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => ` ${ctx.parsed.x} lines`
      }}},
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(200,146,42,0.08)' },
          ticks: { color: '#7a5430', font: { size: 11 }, precision: 0 } },
        y: { grid: { display: false }, ticks: { color: '#3b2a1a', font: { size: 11.5 } } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });
}

function renderUnitChart(unitBreakdown) {
  const labels = unitBreakdown.map(u => `Unit ${u.unitNo}`);
  if (chartUnits) chartUnits.destroy();
  chartUnits = new Chart(document.getElementById('chartUnits'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Completed', data: unitBreakdown.map(u => u.completed), backgroundColor: '#3a7d44', borderRadius: 4 },
        { label: 'In Progress', data: unitBreakdown.map(u => u.inProgress), backgroundColor: '#c8922a', borderRadius: 4 },
        { label: 'Pending', data: unitBreakdown.map(u => u.pending), backgroundColor: '#2d5c8a', borderRadius: 4 },
      ]
    },
    options: {
      plugins: { legend: { position: 'top', labels: { color: '#3b2a1a', font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#7a5430', font: { size: 11 } } },
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(200,146,42,0.08)' },
          ticks: { color: '#7a5430', font: { size: 11 }, precision: 0 } }
      },
      responsive: true, maintainAspectRatio: false,
    }
  });
}

// ── Table filters + sort + paginate ──────────
function populateUnitFilter() {
  const sel = document.getElementById('filterUnit');
  const units = [...new Set(allLineData.map(r => r.unitNo))].sort();
  sel.innerHTML = '<option value="">All Units</option>' + units.map(u => `<option value="${u}">${u}</option>`).join('');
}

function applyFilters() {
  const search = document.getElementById('tableSearch').value.toLowerCase().trim();
  const statusF = document.getElementById('filterStatus').value;
  const criticalF = document.getElementById('filterCritical').value;
  const unitF = document.getElementById('filterUnit').value;

  filteredData = allLineData.filter(r => {
    if (statusF   && r.status !== statusF) return false;
    if (criticalF && r.critical !== criticalF) return false;
    if (unitF     && r.unitNo !== unitF) return false;
    if (search) {
      const hay = `${r.lineId} ${r.zone} ${r.status} ${r.uploadedBy} ${r.processCheckBy} ${r.materialCheckBy} ${r.pending}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  sortData();
  currentPage = 1;
  renderTable();
}

function sortData() {
  filteredData.sort((a, b) => {
    let av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
    if (typeof av === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });
}

function initTableSort() {
  document.querySelectorAll('.data-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = 'asc'; }
      document.querySelectorAll('.data-table th').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      sortData();
      renderTable();
    });
  });
}

function renderTable() {
  const tbody = document.getElementById('lineTableBody');
  document.getElementById('registerCount').textContent = `${filteredData.length} lines`;

  const total = filteredData.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * perPage;
  const pageData = filteredData.slice(start, start + perPage);

  if (!pageData.length) {
    tbody.innerHTML = `<tr><td colspan="22">
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p>No lines match the current filters</p>
      </div></td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(r => {
      const badgeClass = getStatusBadge(r.status);
      const critBadge = r.critical === 'YES'
        ? '<span class="badge badge-critical">CRITICAL</span>'
        : '<span class="badge badge-normal">—</span>';
      return `<tr>
        <td>${r.slNo}</td>
        <td>${r.unitNo}</td>
        <td>${r.zone}</td>
        <td><strong>${r.lineId}</strong></td>
        <td>${r.revNo}</td>
        <td>${critBadge}</td>
        <td><span class="badge ${badgeClass}">${r.status}</span></td>
        <td>${r.uploadedBy}</td>
        <td>${r.uploadedOn}</td>
        <td>${r.processCheckBy}</td>
        <td>${r.processCheckDate}</td>
        <td>${r.materialCheckBy}</td>
        <td>${r.materialCheckDate}</td>
        <td>${r.supportBy}</td>
        <td>${r.supportDate}</td>
        <td>${r.modellerIncorporation}</td>
        <td>${r.incorporatedDate}</td>
        <td>${r.glCheck}</td>
        <td>${r.glCheckDate}</td>
        <td>${r.sglCheck}</td>
        <td>${r.sglCheckDate}</td>
        <td><em style="color:var(--bark-muted);font-size:11px">${r.pending}</em></td>
      </tr>`;
    }).join('');
  }

  // Pagination info
  document.getElementById('pagInfo').textContent = total
    ? `Showing ${start + 1}–${Math.min(start + perPage, total)} of ${total} lines`
    : 'No lines';

  // Pagination buttons
  const pagBtns = document.getElementById('pagBtns');
  pagBtns.innerHTML = '';
  const makeBtn = (label, page, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'pag-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', () => { currentPage = page; renderTable(); });
    return btn;
  };
  pagBtns.appendChild(makeBtn('‹', currentPage - 1, currentPage === 1));
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, startPage + 4);
  for (let p = startPage; p <= endPage; p++) pagBtns.appendChild(makeBtn(p, p, false, p === currentPage));
  pagBtns.appendChild(makeBtn('›', currentPage + 1, currentPage === totalPages));
}

// ── Checker Activity ──────────────────────────
function renderActivity(activity, summary) {
  document.getElementById('activityCount').textContent = `${activity.length} engineers`;

  // Stage summary
  if (summary) {
    const ca = summary.checkerActivity;
    const total = summary.total || 1;
    const stages = [
      { name: 'PC Checked',      count: ca.pcChecked,    color: '#2d5c8a' },
      { name: 'MC Checked',      count: ca.mcChecked,    color: '#3a7d44' },
      { name: 'SC Checked',      count: ca.scChecked,    color: '#c9644a' },
      { name: 'Incorporated',    count: ca.incorporated, color: '#7b5ea7' },
      { name: 'GL Reviewed',     count: ca.glReviewed,   color: '#687860' },
      { name: 'SGL Reviewed',    count: ca.sglReviewed,  color: '#c8922a' },
    ];
    document.getElementById('stageSummaryBody').innerHTML = stages.map(s => {
      const pct = Math.round(s.count * 100 / total);
      return `<tr>
        <td>${s.name}</td>
        <td style="text-align:right;font-weight:700">${s.count}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <div class="mini-bar" style="flex:1">
              <div class="mini-bar-fill" style="width:${pct}%;background:${s.color}"></div>
            </div>
            <span style="font-size:10.5px;color:var(--bark-muted);width:28px;text-align:right">${pct}%</span>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // Per-user
  const tbody = document.getElementById('userActivityBody');
  if (!activity.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--bark-muted)">No activity data</td></tr>';
    return;
  }
  tbody.innerHTML = activity.map(a => {
    const rolePills = (a.roles || []).map(r => `<span class="role-pill role-${r}">${r}</span>`).join('');
    const pct = a.linesHandled ? Math.round(a.linesCompleted * 100 / a.linesHandled) : 0;
    return `<tr>
      <td><strong>${a.name}</strong></td>
      <td>${rolePills || '—'}</td>
      <td style="text-align:right">${a.linesHandled}</td>
      <td style="text-align:right">
        <span style="font-weight:700;color:var(--bark)">${a.linesCompleted}</span>
        <span style="font-size:10px;color:var(--bark-muted)"> (${pct}%)</span>
      </td>
      <td style="font-size:11.5px;color:var(--bark-muted)">${a.lastActivity}</td>
    </tr>`;
  }).join('');
}

// ── Export ────────────────────────────────────
async function exportAllLines() {
  if (!selectedJob || !selectedUnits.length) { showToast('Fetch a report first'); return; }
  showToast('Generating Excel…');
  try {
    const res = await fetch('/api/report/all-lines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobNo: selectedJob, units: selectedUnits }),
    });
    const data = await res.json();
    if (!data.success) { showToast('No data to export'); return; }
    generateExcel(data.data, 'AllLines');
    showToast('✓ Excel downloaded');
  } catch { showToast('Export failed'); }
}
window.exportAllLines = exportAllLines;

async function exportInProgress() {
  if (!selectedJob || !selectedUnits.length) { showToast('Fetch a report first'); return; }
  showToast('Generating Excel…');
  try {
    const res = await fetch('/api/report/under-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobNo: selectedJob, units: selectedUnits }),
    });
    const data = await res.json();
    if (!data.success) { showToast('No in-progress lines found'); return; }
    generateExcel(data.data, 'InProgress');
    showToast('✓ Excel downloaded');
  } catch { showToast('Export failed'); }
}
window.exportInProgress = exportInProgress;

function exportTable(type) {
  const src = type === 'all' ? filteredData : filteredData.filter(r => !['Final','Ready for EDMS'].includes(r.status));
  if (!src.length) { showToast('No data to export'); return; }
  generateExcel(src, type === 'all' ? 'Filtered' : 'InProgress');
  showToast('✓ Excel downloaded');
}
window.exportTable = exportTable;

function generateExcel(data, tag) {
  const headers = [
    'SL NO.','UNIT','ZONE','LINE ID','REV','CRITICAL','STATUS',
    'MODELLER','UPLOAD DATE',
    'PC BY','PC DATE','MC BY','MC DATE','SC BY','SC DATE',
    'INCORPORATED BY','INCORP. DATE',
    'GL BY','GL DATE','SGL BY','SGL DATE','PENDING ACTION'
  ];
  const rows = data.map(r => [
    r.slNo, r.unitNo, r.zone, r.lineId, r.revNo, r.critical, r.status,
    r.uploadedBy, r.uploadedOn,
    r.processCheckBy, r.processCheckDate,
    r.materialCheckBy, r.materialCheckDate,
    r.supportBy, r.supportDate,
    r.modellerIncorporation, r.incorporatedDate,
    r.glCheck, r.glCheckDate,
    r.sglCheck, r.sglCheckDate,
    r.pending,
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    {wch:7},{wch:8},{wch:8},{wch:20},{wch:6},{wch:10},{wch:26},
    {wch:16},{wch:12},
    {wch:16},{wch:12},{wch:16},{wch:12},{wch:16},{wch:12},
    {wch:18},{wch:12},
    {wch:16},{wch:12},{wch:16},{wch:12},
    {wch:22},
  ];

  // Style header row
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[addr]) continue;
    ws[addr].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '3B2A1A' } } };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, tag);
  const ts = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `PIMS_Report_${selectedJob}_${tag}_${ts}.xlsx`);
}

// ── Toast ─────────────────────────────────────
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ══════════════════════════════════════════════
// BATCH QUERY
// ══════════════════════════════════════════════

let _bqResults = [];

function showBatchQuery() {
  ['sec-kpi','sec-charts','sec-register','sec-activity','sec-lots'].forEach(function(sid) {
    const el = document.getElementById(sid);
    if (el) el.style.display = 'none';
  });
  document.getElementById('sec-batch').style.display = 'block';
  document.getElementById('sec-batch').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.nav-btn-batch')?.classList.add('active');
}

// Drag-and-drop support on the upload zone (DOM already ready — script is at bottom of body)
(function initBqDrop() {
  const zone = document.getElementById('bqUploadZone');
  if (!zone) return;
  zone.addEventListener('dragover', function (e) {
    e.preventDefault();
    zone.classList.add('bq-drag-over');
  });
  zone.addEventListener('dragleave', function () {
    zone.classList.remove('bq-drag-over');
  });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove('bq-drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleBatchFile(file);
  });
})();

function handleBatchFile(file) {
  if (!file) return;
  const hint = document.getElementById('bqUploadHint');
  hint.textContent = 'Reading file…';
  hint.style.color = 'var(--gold)';

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data  = new Uint8Array(e.target.result);
      const wb    = XLSX.read(data, { type: 'array' });
      const ws    = wb.Sheets[wb.SheetNames[0]];
      const rows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Detect header row — skip if first cell looks like a label
      let startRow = 0;
      if (rows.length > 0) {
        const firstCell = String(rows[0][0] || '').trim().toLowerCase();
        if (firstCell === 'line id' || firstCell === 'lineid' || firstCell === 'line no' || firstCell === 'line_no' || firstCell === 'lineno' || isNaN(firstCell) && !/^\d/.test(firstCell)) {
          startRow = 1; // skip header
        }
      }

      const lineIds = [];
      for (let i = startRow; i < rows.length; i++) {
        const val = String(rows[i][0] || '').trim();
        if (val) lineIds.push(val);
      }

      if (lineIds.length === 0) {
        hint.textContent = 'No line IDs found in the first column.';
        hint.style.color = '#c0392b';
        return;
      }

      hint.textContent = `Found ${lineIds.length} line IDs — querying…`;
      hint.style.color = 'var(--sage)';
      runBatchQuery(lineIds);
    } catch (err) {
      hint.textContent = 'Failed to read file: ' + err.message;
      hint.style.color = '#c0392b';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function runBatchQuery(lineIds) {
  const hint      = document.getElementById('bqUploadHint');
  const summary   = document.getElementById('bqSummary');
  const tableWrap = document.getElementById('bqTableWrap');
  const exportBtn = document.getElementById('batchExportBtn');
  const chip      = document.getElementById('batchChip');

  summary.style.display   = 'none';
  tableWrap.style.display = 'none';
  exportBtn.style.display = 'none';
  _bqResults = [];

  try {
    const resp = await fetch('/api/report/batch-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineIds }),
    });
    const data = await resp.json();
    if (!data.ok) { hint.textContent = 'Query error: ' + (data.error || 'Unknown'); hint.style.color = '#c0392b'; return; }

    _bqResults = data.results;

    // Update KPI tiles
    document.getElementById('bqTotal').textContent     = data.total;
    document.getElementById('bqCompleted').textContent = data.completed;
    document.getElementById('bqInProgress').textContent = data.inProgress;
    document.getElementById('bqNotFound').textContent  = data.notFound;
    chip.textContent = data.total + ' lines';

    // Build table
    const tbody = document.getElementById('bqTableBody');
    tbody.innerHTML = data.results.map(function (r, i) {
      if (!r.found) {
        return `<tr class="bq-row-missing">
          <td>${i + 1}</td>
          <td><span class="bq-lineid">${esc(r.lineId)}</span></td>
          <td colspan="8" style="color:#999;font-style:italic;">Not found in system</td>
        </tr>`;
      }
      const badgeClass = getStatusBadge(r.status);
      const rowClass   = r.isComplete ? 'bq-row-done' : '';
      return `<tr class="${rowClass}">
        <td>${i + 1}</td>
        <td><span class="bq-lineid">${esc(r.lineId)}</span></td>
        <td>${esc(r.jobNo)}</td>
        <td>${esc(r.unitNo)}</td>
        <td>${esc(r.revNo)}</td>
        <td><span class="${r.stressCritical === 'YES' ? 'bq-crit' : ''}">${esc(r.stressCritical)}</span></td>
        <td><span class="status-badge ${badgeClass}">${esc(r.status)}</span></td>
        <td>${esc(r.pendingLabel)}</td>
        <td>${esc(r.pendingWith)}</td>
        <td><span class="bq-role-tag">${esc(r.pendingRoles)}</span></td>
      </tr>`;
    }).join('');

    summary.style.display   = 'grid';
    tableWrap.style.display = 'block';
    exportBtn.style.display = '';
    hint.textContent = `Query complete — ${data.total} lines processed.`;
    hint.style.color = 'var(--sage)';
  } catch (err) {
    hint.textContent = 'Network error: ' + err.message;
    hint.style.color = '#c0392b';
  }
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ══════════════════════════════════════════════
// LOT & TAG STATUS SECTION
// ══════════════════════════════════════════════

// Tag colour — hash-based, matches the palette used in the main PIMS app
const _LOT_TAG_PALETTE = [
  { bg:'#dbeafe', text:'#1e40af' },
  { bg:'#dcfce7', text:'#166534' },
  { bg:'#fef3c7', text:'#92400e' },
  { bg:'#ede9fe', text:'#5b21b6' },
  { bg:'#ffedd5', text:'#9a3412' },
  { bg:'#fce7f3', text:'#9d174d' },
  { bg:'#e0f2fe', text:'#0369a1' },
  { bg:'#f0fdf4', text:'#15803d' },
];
function _tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h << 5) - h + tag.charCodeAt(i);
  return _LOT_TAG_PALETTE[Math.abs(h) % _LOT_TAG_PALETTE.length];
}

// Status colour — matches openLotStatusModal in left-bottom.js
function _lotStatusColor(status) {
  if (status === 'Uploaded')       return { bg:'#dbeafe', text:'#1d4ed8' };
  if (status === 'Claimed')        return { bg:'#fef3c7', text:'#92400e' };
  if (status === 'Checking')       return { bg:'#ede9fe', text:'#5b21b6' };
  if (status === 'Comment Issued') return { bg:'#ffedd5', text:'#9a3412' };
  if (status === 'Returned')       return { bg:'#fee2e2', text:'#991b1b' };
  if (status === 'Final')          return { bg:'#dcfce7', text:'#166534' };
  if (status === 'Approved')       return { bg:'#dcfce7', text:'#166534' };
  return { bg:'#f1f5f9', text:'#475569' };
}

function renderLotsReport(lots) {
  _lotsData = lots || [];
  _activeLotTag = null;

  const cardsList   = document.getElementById('lotCardsList');
  const tagCloud    = document.getElementById('lotTagCloud');
  const lotsCount   = document.getElementById('lotsCount');
  const exportBtn   = document.getElementById('lotsExportBtn');
  const tagPills    = document.getElementById('lotTagPills');
  const tagClearBtn = document.getElementById('lotTagClearBtn');

  if (!_lotsData.length) {
    lotsCount.textContent = '0 lots';
    tagCloud.style.display = 'none';
    exportBtn.style.display = 'none';
    cardsList.innerHTML = `
      <div class="lots-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        </svg>
        <p>No planned lots found for the selected project and units</p>
        <small>Lots appear here once an SGL assigns lines to a lot</small>
      </div>`;
    return;
  }

  const totalLines = _lotsData.reduce((s, l) => s + l.lines.length, 0);
  lotsCount.textContent = `${_lotsData.length} planned lot${_lotsData.length !== 1 ? 's' : ''} · ${totalLines} lines`;
  exportBtn.style.display = '';

  // Build tag counts across all lots
  const tagCounts = {};
  for (const lot of _lotsData) {
    for (const line of lot.lines) {
      for (const t of (line.tags || [])) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
  }
  const allTags = Object.keys(tagCounts).sort();

  if (allTags.length) {
    tagCloud.style.display = '';
    tagPills.innerHTML = allTags.map(t => {
      const c = _tagColor(t);
      return `<span class="lot-tag-pill" data-tag="${esc(t)}"
        style="background:${c.bg};color:${c.text};"
        onclick="applyLotTagFilter('${esc(t)}')"
        title="Filter to lines tagged '${esc(t)}'">
        ${esc(t)} <span class="tpc">×${tagCounts[t]}</span>
      </span>`;
    }).join('');
    tagClearBtn.style.display = 'none';
  } else {
    tagCloud.style.display = 'none';
  }

  // Render accordion cards
  cardsList.innerHTML = _lotsData.map((lot, idx) => {
    const total    = lot.lines.length;
    const doneCount = lot.lines.filter(l => l.status === 'Final' || l.status === 'Approved').length;
    const pct      = total ? Math.round(doneCount * 100 / total) : 0;

    // Status chip summary
    const statusCounts = {};
    for (const l of lot.lines) statusCounts[l.status] = (statusCounts[l.status] || 0) + 1;
    const statusChips = Object.entries(statusCounts).map(([s, n]) => {
      const c = _lotStatusColor(s);
      return `<span class="lot-status-chip" style="background:${c.bg};color:${c.text};">${n} ${s}</span>`;
    }).join('');

    const rowsHtml = lot.lines.map(line => {
      const sc = _lotStatusColor(line.status);
      const scBadge = line.stressCritical === 'Y'
        ? ' <span style="color:#ef4444;font-size:10px;font-weight:700;">SC</span>' : '';
      const claimerText = (line.claimers || []).length
        ? line.claimers.map(cl => `${esc(cl.name)} <span style="color:#94a3b8;font-size:10px;">(${(cl.roles||[]).join(', ')})</span>`).join('<br>')
        : '<span style="color:#cbd5e1;">—</span>';
      const tagsHtml = (line.tags || []).length
        ? line.tags.map(t => {
            const tc = _tagColor(t);
            return `<span class="lot-inline-tag" style="background:${tc.bg};color:${tc.text};">${esc(t)}</span>`;
          }).join('')
        : '<span style="color:#cbd5e1;">—</span>';
      const tagAttr = (line.tags || []).length ? `data-tags="${esc(JSON.stringify(line.tags))}"` : '';
      return `<tr ${tagAttr}>
        <td style="color:var(--bark-muted);">${esc(line.zone)}</td>
        <td><strong>${esc(line.lineNo)}</strong>${scBadge}</td>
        <td style="color:var(--bark-muted);">R${line.revNo}</td>
        <td><span class="lot-status-chip" style="background:${sc.bg};color:${sc.text};">${esc(line.status)}</span></td>
        <td style="font-size:12px;">${claimerText}</td>
        <td>${tagsHtml}</td>
      </tr>`;
    }).join('');

    return `
      <div class="lot-acc-card" id="lot-card-${idx}">
        <div class="lot-acc-header" onclick="toggleLotCard(${idx})">
          <div>
            <div class="lot-acc-num">Lot ${lot.lotNumber}</div>
            <div class="lot-acc-unit">${esc(lot.unitNo)}</div>
          </div>
          <div class="lot-acc-meta">${statusChips}</div>
          <div class="lot-acc-progress-wrap">
            <div class="lot-acc-prog-bar">
              <div class="lot-acc-prog-fill" style="width:${pct}%"></div>
            </div>
            <span class="lot-acc-pct">${pct}%</span>
          </div>
          <span class="lot-acc-creator">by ${esc(lot.createdBy)}</span>
          <button class="lot-acc-toggle" title="Expand/collapse" aria-label="Toggle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
        <div class="lot-acc-body">
          <div style="overflow-x:auto;">
            <table class="lot-inner-table">
              <thead>
                <tr>
                  <th>Zone</th>
                  <th>Line No</th>
                  <th>Rev</th>
                  <th>Status</th>
                  <th>Claimed By</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }).join('');
}
window.renderLotsReport = renderLotsReport;

function toggleLotCard(idx) {
  const card = document.getElementById('lot-card-' + idx);
  if (card) card.classList.toggle('open');
}
window.toggleLotCard = toggleLotCard;

function applyLotTagFilter(tag) {
  _activeLotTag = tag;
  const clearBtn = document.getElementById('lotTagClearBtn');
  if (clearBtn) clearBtn.style.display = '';

  // Mark active pill
  document.querySelectorAll('.lot-tag-pill').forEach(p => {
    p.classList.toggle('active-filter', p.dataset.tag === tag);
  });

  // Show/hide rows — also auto-open cards that have matching rows
  document.querySelectorAll('#lotCardsList .lot-acc-card').forEach(card => {
    const rows = card.querySelectorAll('tbody tr');
    let cardHasMatch = false;
    rows.forEach(row => {
      const rawTags = row.dataset.tags;
      let tags = [];
      try { tags = rawTags ? JSON.parse(rawTags) : []; } catch {}
      const match = tags.includes(tag);
      row.classList.toggle('lot-row-hidden', !match);
      if (match) cardHasMatch = true;
    });
    // Auto-open card if it has matching rows; leave it alone if it was already open
    if (cardHasMatch && !card.classList.contains('open')) card.classList.add('open');
  });
}
window.applyLotTagFilter = applyLotTagFilter;

function clearLotTagFilter() {
  _activeLotTag = null;
  const clearBtn = document.getElementById('lotTagClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';

  document.querySelectorAll('.lot-tag-pill').forEach(p => p.classList.remove('active-filter'));
  document.querySelectorAll('#lotCardsList tbody tr').forEach(r => r.classList.remove('lot-row-hidden'));
}
window.clearLotTagFilter = clearLotTagFilter;

function exportLotsExcel() {
  if (!_lotsData.length) { showToast('No lot data to export'); return; }

  const wb = XLSX.utils.book_new();

  for (const lot of _lotsData) {
    const headers = ['Zone','Line No','Rev','Status','Stress Critical','Claimed By','Claimed Roles','Tags'];
    const rows = lot.lines.map(l => {
      const claimerNames  = (l.claimers || []).map(c => c.name).join('; ');
      const claimerRoles  = (l.claimers || []).map(c => (c.roles || []).join('+')).join('; ');
      return [
        l.zone, l.lineNo, `R${l.revNo}`, l.status,
        l.stressCritical === 'Y' ? 'YES' : 'NO',
        claimerNames || '—', claimerRoles || '—',
        (l.tags || []).join(', ') || '—',
      ];
    });

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [{wch:8},{wch:22},{wch:6},{wch:18},{wch:12},{wch:20},{wch:18},{wch:20}];

    // Bold header row
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1E4A78' } } };
    }

    const sheetName = `Lot ${lot.lotNumber} (${lot.unitNo})`.slice(0, 31); // Excel tab limit
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const ts = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `PIMS_Lots_${selectedJob}_${ts}.xlsx`);
  showToast('✓ Lot report exported');
}
window.exportLotsExcel = exportLotsExcel;

function exportBatchResults() {
  if (!_bqResults.length) return;
  const headers = ['#','Line ID','Job No','Unit','Rev','Stress Critical','Status','Stage','Pending With','Role'];
  const rows = _bqResults.map(function (r, i) {
    if (!r.found) return [i+1, r.lineId, '-', '-', '-', '-', 'Not Found', '-', '-', '-'];
    return [i+1, r.lineId, r.jobNo, r.unitNo, r.revNo, r.stressCritical, r.status, r.pendingLabel, r.pendingWith, r.pendingRoles];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{wch:5},{wch:20},{wch:12},{wch:10},{wch:8},{wch:12},{wch:22},{wch:24},{wch:22},{wch:18}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Batch Query');
  const ts = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `PIMS_BatchQuery_${ts}.xlsx`);
}
