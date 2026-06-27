'use strict';
// ── Shared state (used by other gad-*.js files) ────────────────────────────
let gadCurrentUser  = null;
let gadSelectedJob  = null;
let gadSelectedUnit = null;
let gadSelectedArea = null;
let gadCurrentTask  = null; // task open in a review panel
let gadTreeData     = {};

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-mode');
  gadSetDate();
  gadInitUI();
  await Promise.all([initGADUser(), initGADTree()]);
});

async function initGADUser() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { window.location.href = '/index.html'; return; }
    gadCurrentUser = await res.json();
    document.querySelectorAll('.loggedUser').forEach(el => el.textContent = gadCurrentUser.name || '—');
    document.getElementById('topbarUserRole').textContent = gadCurrentUser.role || '';
    document.getElementById('tuDdRole').textContent = gadCurrentUser.role || '';
    gadApplyRoleVisibility();
  } catch(e) {
    window.location.href = '/index.html';
  }
}

function gadApplyRoleVisibility() {
  if (!gadCurrentUser) return;
  const role = (gadCurrentUser.role || '').toLowerCase();

  const isModeller = ['modeller','designer','piping engineer','engineer'].some(r => role.includes(r));
  const isChecker  = ['pc','mc','sc','process checker','material checker','stress checker','checker'].some(r => role.includes(r));
  const isGL       = role.includes('gl') && !role.includes('sgl');
  const isSGL      = role.includes('sgl');

  // Everyone can see upload + checker + GL notifications since role assignments
  // are per-project; show the buttons and let the server enforce access.
  document.getElementById('gad-upload-nav-group').style.display = '';
  const surfBtn = document.getElementById('gad-surface-upload-btn');
  if (surfBtn) surfBtn.style.display = '';
  document.getElementById('gad-modeller-notif-btn').style.display  = '';
  document.getElementById('gad-checker-notif-btn').style.display   = '';
  document.getElementById('gad-gl-notif-btn').style.display        = '';
  if (isSGL) document.getElementById('gad-sgl-notif-btn').style.display = '';
}

function gadSetDate() {
  const el = document.getElementById('hdDate');
  if (el) el.textContent = new Date().toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}

// ── Panel switching ─────────────────────────────────────────────────────────
function showGADPanel(id) {
  document.querySelectorAll('#viewContainer > .view-panel').forEach(p => p.classList.remove('active-panel'));
  const p = document.getElementById(id);
  if (p) { p.classList.add('active-panel'); p.scrollTop = 0; }
}

// ── Tree ───────────────────────────────────────────────────────────────────
async function initGADTree() {
  try {
    const res = await fetch('/api/gad/tree');
    if (!res.ok) return;
    const data = await res.json();
    gadTreeData = data.projects || data || {};
    renderGADTree();
  } catch(e) { console.error('GAD tree error:', e); }
}

function renderGADTree() {
  const container = document.getElementById('gad-tree');
  if (!container) return;
  container.innerHTML = '';
  const jobs = Object.keys(gadTreeData).sort();
  if (!jobs.length) {
    container.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#94a3b8;">No GADs uploaded yet</div>';
    return;
  }
  for (const job of jobs) container.appendChild(buildJobNode(job, gadTreeData[job]));
  if (gadSelectedJob && gadSelectedUnit) autoExpandTreePath(gadSelectedJob, gadSelectedUnit);
}

function autoExpandTreePath(job, unit) {
  const container = document.getElementById('gad-tree');
  if (!container) return;
  const jobNode = [...container.querySelectorAll('.gad-tree-job')].find(n => n.dataset.job === job);
  if (!jobNode) return;
  jobNode.classList.add('open');
  const jobChildren = jobNode.querySelector('.gad-tree-children');
  if (jobChildren) jobChildren.style.display = 'block';
  const unitNode = [...jobNode.querySelectorAll('.gad-tree-unit')].find(n => n.dataset.unit === String(unit));
  if (!unitNode) return;
  unitNode.classList.add('open');
  const unitChildren = unitNode.querySelector('.gad-tree-children');
  if (unitChildren) unitChildren.style.display = 'block';
}

function buildJobNode(job, units) {
  const wrap = makeTreeWrap('gad-tree-job');
  wrap.dataset.job = job;
  const row  = makeTreeRow(`
    <span class="gad-tree-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>
    <span class="gad-tree-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></span>
    <span class="gad-tree-label">${job}</span>
  `);
  const children = makeTreeChildren();
  row.addEventListener('click', () => toggleTreeNode(wrap, children));
  Object.keys(units).sort().forEach(u => children.appendChild(buildUnitNode(job, u, units[u])));
  wrap.appendChild(row); wrap.appendChild(children);
  return wrap;
}

function buildUnitNode(job, unit, areas) {
  const wrap = makeTreeWrap('gad-tree-unit');
  wrap.dataset.unit = unit;
  const row  = makeTreeRow(`
    <span class="gad-tree-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>
    <span class="gad-tree-label">Unit ${unit}</span>
  `);
  const children = makeTreeChildren();
  row.addEventListener('click', () => toggleTreeNode(wrap, children));
  Object.keys(areas).sort((a,b) => Number(a) - Number(b)).forEach(area => {
    children.appendChild(buildAreaNode(job, unit, area, areas[area]));
  });
  wrap.appendChild(row); wrap.appendChild(children);
  return wrap;
}

function buildAreaNode(job, unit, area, gads) {
  const item = makeTreeWrap('gad-tree-area');
  item.dataset.job  = job;
  item.dataset.unit = unit;
  item.dataset.area = area;

  const total  = gads.length;
  const finals = gads.filter(g => g.status === 'Final').length;
  const badge  = finals > 0
    ? `<span class="gad-area-badge gad-area-badge-final">${finals}F / ${total}</span>`
    : `<span class="gad-area-badge">${total}</span>`;

  item.innerHTML = `<div class="gad-tree-row gad-tree-area-row">
    <span class="gad-area-dot"></span>
    <span class="gad-tree-label">Area ${area}</span>
    ${badge}
  </div>`;

  item.addEventListener('click', () => {
    document.querySelectorAll('.gad-tree-area').forEach(el => el.classList.remove('active'));
    item.classList.add('active');
    gadSelectedJob  = job;
    gadSelectedUnit = unit;
    gadSelectedArea = area;
    loadGADSurface(job, unit, area);
  });
  return item;
}

// Helper DOM builders
function makeTreeWrap(cls) {
  const d = document.createElement('div');
  d.className = `gad-tree-item ${cls}`;
  return d;
}
function makeTreeRow(html) {
  const d = document.createElement('div');
  d.className = 'gad-tree-row';
  d.innerHTML = html;
  return d;
}
function makeTreeChildren() {
  const d = document.createElement('div');
  d.className = 'gad-tree-children';
  d.style.display = 'none';
  return d;
}
function toggleTreeNode(wrap, children) {
  const isOpen = wrap.classList.toggle('open');
  children.style.display = isOpen ? 'block' : 'none';
}

// ── GAD Surface ────────────────────────────────────────────────────────────
async function loadGADSurface(job, unit, area) {
  showGADPanel('gad-surface');
  document.getElementById('gad-surface-eyebrow').textContent = `${job} › Unit ${unit}`;
  document.getElementById('gad-surface-title').innerHTML = `Area ${area} <em>GADs</em>`;

  const tbody = document.getElementById('gad-list-body');
  tbody.innerHTML = '<tr><td colspan="8" class="no-data">Loading…</td></tr>';

  try {
    const res  = await fetch(`/api/gads?project=${encodeURIComponent(job)}&unit=${encodeURIComponent(unit)}&area=${encodeURIComponent(area)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const gads = data.gads || [];

    if (!gads.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="no-data">No GADs in this area yet</td></tr>';
      return;
    }

    tbody.innerHTML = gads.map(g => {
      const sc  = gadStatusClass(g.status);
      const lot = g.issued_lot_number  ? `L${g.issued_lot_number}` :
                  g.planned_lot_number ? `(P) L${g.planned_lot_number}` : '—';
      const safeG = encodeURIComponent(JSON.stringify(g));
      return `<tr class="clickable-row" onclick="openGADFromSurface(JSON.parse(decodeURIComponent('${safeG}')))">
        <td><strong>${g.gad_no}</strong></td>
        <td>${g.rev_no || 'R0-1'}</td>
        <td><span class="gad-status ${sc}">${g.status}</span></td>
        <td>${g.by_name      || '—'}</td>
        <td>${g.checked_name || '—'}</td>
        <td>${g.gl_name      || '—'}</td>
        <td>${lot}</td>
        <td><button class="back-btn" style="padding:4px 10px;font-size:11.5px;" onclick="event.stopPropagation();openGADFromSurface(JSON.parse(decodeURIComponent('${safeG}')))">Open</button></td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" class="no-data">Failed to load GADs</td></tr>';
  }
}

function gadStatusClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'uploaded')                      return 'gad-status-uploaded';
  if (s.includes('review') || s === 'under review') return 'gad-status-review';
  if (s.includes('supporting'))              return 'gad-status-supporting';
  if (s.includes('for gl') || s.includes('ready for gl')) return 'gad-status-gl';
  if (s.includes('for sgl') || s.includes('ready for sgl')) return 'gad-status-sgl';
  if (s === 'final')                         return 'gad-status-final';
  if (s.includes('hold'))                    return 'gad-status-hold';
  return 'gad-status-uploaded';
}

function openGADFromSurface(gad) {
  const status = (gad.status || '').toLowerCase();
  const userId = String(gadCurrentUser?.id || '');
  const role   = (gadCurrentUser?.role || '').toLowerCase();

  // ── New 4-stage workflow ──────────────────────────────────────────────────
  if (status === 'by+check review' && String(gad.by_user_id || '') === userId)
    return openGADByCheckPanel(gad);

  if (status === 'by review' && String(gad.by_user_id || '') === userId)
    return openGADByPanel(gad);

  if (status === 'check review' && String(gad.checked_user_id || '') === userId)
    return openGADCheckPanel(gad);

  if ((status === 'gl review' || status === 'ready for gl') &&
      String(gad.gl_user_id || '') === userId)
    return openGADNewGLPanel(gad);

  if (['returned (by)', 'returned (check)', 'returned (gl)'].includes(status) &&
      String(gad.uploaded_by || '') === userId)
    return openGADModellerPanel(gad);

  // GL from pool (new workflow — by_user_id present → went through By/Check)
  if ((status === 'ready for gl' || status === 'gl review') &&
      gad.by_user_id && role.includes('gl') && !role.includes('sgl'))
    return openGADNewGLPanel(gad);

  // ── Legacy old-workflow ───────────────────────────────────────────────────
  if (gad.notify_modeller && String(gad.uploaded_by || '') === userId)
    return openGADModellerPanel(gad);

  if ((status.includes('for gl') || status === 'gl hold') &&
      role.includes('gl') && !role.includes('sgl'))
    return openGADGLPanel(gad);

  if ((status.includes('for sgl') || status === 'ready for sgl') && role.includes('sgl'))
    return openGADSGLPanel(gad);

  openGADCheckerPanel(gad);
}

// ── Refresh tree silently after upload ─────────────────────────────────────
async function refreshGADTree() {
  try {
    const res  = await fetch('/api/gad/tree');
    if (!res.ok) return;
    const data = await res.json();
    gadTreeData = data.projects || data || {};
    renderGADTree();
    if (gadSelectedJob && gadSelectedUnit && gadSelectedArea) {
      loadGADSurface(gadSelectedJob, gadSelectedUnit, gadSelectedArea);
    }
  } catch(e) {}
}

// ── UI: sidebar, theme, user dropdown ─────────────────────────────────────
function gadInitUI() {
  // Sidebar collapse
  document.getElementById('sbCollapseBtn')?.addEventListener('click', () => {
    document.getElementById('shell').classList.toggle('sidebar-collapsed');
  });

  // Mobile menu
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  document.getElementById('mobMenuBtn')?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('show');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
  });
  document.getElementById('mobLogoutBtn')?.addEventListener('click', gadSignOut);

  // Nav group expand/collapse
  document.querySelectorAll('.nav-group-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav-group');
      if (group) group.classList.toggle('open');
    });
  });
  // Open inbox + projects by default
  ['gad-inbox', 'gad-projects'].forEach(groupId => {
    const group = document.querySelector(`.nav-group[data-group="${groupId}"]`);
    if (group) group.classList.add('open');
  });

  // Theme
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
  });

  // User dropdown
  const tuBtn      = document.getElementById('tuBtn');
  const tuDropdown = document.getElementById('tuDropdown');
  tuBtn?.addEventListener('click', e => { e.stopPropagation(); tuDropdown.classList.toggle('open'); });
  document.addEventListener('click', e => { if (!tuWrap?.contains(e.target)) tuDropdown?.classList.remove('open'); });

  // Change password
  document.getElementById('changePasswordBtn')?.addEventListener('click', () => {
    document.getElementById('changePasswordModal').style.display = 'flex';
    tuDropdown?.classList.remove('open');
  });

  // Search (highlight in surface)
  document.getElementById('gadSearch')?.addEventListener('input', e => filterGADSurface(e.target.value));
}

function filterGADSurface(q) {
  const rows = document.querySelectorAll('#gad-list-body tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}

async function gadSignOut() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/index.html';
}

async function submitChangePassword() {
  const oldPass = document.getElementById('cpOldPass').value.trim();
  const newPass = document.getElementById('cpNewPass').value;
  const confirm = document.getElementById('cpConfirmPass').value;
  const msg     = document.getElementById('cpMsg');
  if (!oldPass || !newPass || !confirm) { msg.style.color='#dc2626'; msg.textContent='All fields required.'; return; }
  if (newPass !== confirm) { msg.style.color='#dc2626'; msg.textContent='New passwords do not match.'; return; }
  try {
    const res  = await fetch('/api/change-password', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ currentPassword: oldPass, newPassword: newPass }) });
    const data = await res.json();
    if (res.ok) {
      msg.style.color='#16a34a'; msg.textContent='Password changed.';
      setTimeout(() => { document.getElementById('changePasswordModal').style.display='none'; msg.textContent=''; }, 1500);
    } else { msg.style.color='#dc2626'; msg.textContent = data.error || 'Failed.'; }
  } catch(e) { msg.style.color='#dc2626'; msg.textContent='Network error.'; }
}
