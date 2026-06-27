'use strict';

var _currentGADLotId = null;

// ── Issue Lot from Final GADs panel ───────────────────────────────────────
async function createGADLotFromSelection() {
  const checked = [...document.querySelectorAll('.gad-final-cb:checked')];
  if (!checked.length) return;

  const jobNo  = checked[0].dataset.job;
  const unitNo = checked[0].dataset.unit;
  const gadIds = checked.map(c => parseInt(c.dataset.id));

  const btn = document.getElementById('gad-issue-lot-btn');
  btn.disabled = true;
  btn.textContent = 'Issuing…';

  try {
    const res  = await fetch('/api/gad/lots/issue-selected', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jobNo, unitNo, gadIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    _showGADLotToast(data);
    await loadGADFinalList();
    loadGADLotsTree();
  } catch(e) {
    alert(e.message || 'Failed to issue lot');
    btn.disabled    = false;
    btn.textContent = 'Issue Lot';
  }
}

function _showGADLotToast(data) {
  let toast = document.getElementById('gad-lot-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'gad-lot-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1e293b;color:#f8fafc;padding:14px 20px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.3);min-width:240px;';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `
    <div style="font-weight:700;font-size:14px;margin-bottom:6px;">✓ Lot ${data.lotNumber} Issued</div>
    <div style="color:#94a3b8;">${data.gadCount} GAD(s) issued${data.carryForwardCount ? ` · ${data.carryForwardCount} carried forward` : ''}</div>`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ── Lots sidebar tree ─────────────────────────────────────────────────────
async function loadGADLotsTree() {
  const container = document.getElementById('gad-lots-sidebar-tree');
  if (!container) return;
  container.innerHTML = '<span style="font-size:12px;color:#94a3b8;padding:4px 8px;">Loading…</span>';

  try {
    const res  = await fetch('/api/gad/lots');
    const data = await res.json();
    const tree = data.tree || {};

    if (!Object.keys(tree).length) {
      container.innerHTML = '<span style="font-size:12px;color:#94a3b8;padding:4px 8px;">No lots yet</span>';
      return;
    }

    let html = '';
    for (const job of Object.keys(tree).sort()) {
      html += `<div style="padding:3px 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">${job}</div>`;
      for (const unit of Object.keys(tree[job]).sort()) {
        html += `<div style="padding:2px 8px 2px 16px;font-size:11px;color:#94a3b8;">Unit ${unit}</div>`;
        for (const lot of tree[job][unit]) {
          const issuedLabel = lot.issued
            ? `<span style="background:#16a34a;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:4px;">ISSUED</span>`
            : `<span style="background:#7c3aed;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:4px;">PLANNED</span>`;
          html += `<button class="nav-child" style="padding:4px 8px 4px 24px;font-size:12px;"
            onclick="openGADLotDetail(${lot.id},'${job}','${unit}',${lot.lotNumber},${lot.issued})">
            <span class="nav-child-dot"></span>Lot ${lot.lotNumber} ${issuedLabel}
            <span style="color:#94a3b8;font-size:10px;margin-left:4px;">(${lot.gadCount})</span>
          </button>`;
        }
      }
    }
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<span style="font-size:12px;color:#ef4444;padding:4px 8px;">Failed to load</span>';
  }
}

// ── Lot detail panel ──────────────────────────────────────────────────────
async function openGADLotDetail(lotId, jobNo, unitNo, lotNumber, issued) {
  _currentGADLotId = lotId;
  showGADPanel('gad-lot-detail-panel');

  document.getElementById('gad-lot-eyebrow').textContent = `${jobNo} · Unit ${unitNo}`;
  document.getElementById('gad-lot-title').innerHTML     = `Lot <em>${lotNumber}</em>`;

  // Show action buttons only for issued lots
  const exportWrap  = document.getElementById('gad-lot-export-wrap');
  const engdmsBtn   = document.getElementById('gad-lot-engdms-btn');
  const exportMenu  = document.getElementById('gad-lot-export-menu');
  if (exportWrap) exportWrap.style.display = issued ? 'block' : 'none';
  if (engdmsBtn)  engdmsBtn.style.display  = issued ? 'flex'  : 'none';
  if (exportMenu) exportMenu.style.display = 'none';

  const badge = document.getElementById('gad-lot-status-badge');
  badge.innerHTML = issued
    ? `<span style="background:#16a34a;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px;">ISSUED</span>`
    : `<span style="background:#7c3aed;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px;">PLANNED</span>`;

  const tbody = document.getElementById('gad-lot-lines-body');
  tbody.innerHTML = '<tr><td colspan="6" class="no-data">Loading…</td></tr>';

  try {
    const res  = await fetch(`/api/gad/lots/${lotId}/lines`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    if (!data.gads.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="no-data">No GADs in this lot</td></tr>';
      return;
    }

    tbody.innerHTML = data.gads.map(g => `<tr>
      <td>${g.areaNno || '—'}</td>
      <td><strong>${g.gadNo}</strong></td>
      <td>${g.revNo}</td>
      <td>${g.stressCritical === 'Y' ? '<span style="color:#dc2626;font-weight:700;">Y</span>' : 'N'}</td>
      <td>${g.approvedBy || '—'}</td>
      <td>${g.filePath
        ? `<a href="/${g.filePath}" target="_blank" style="color:#2563eb;font-size:11.5px;">Open PDF</a>`
        : '—'}</td>
    </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" class="no-data">${e.message || 'Failed to load'}</td></tr>`;
  }
}

// ── Export menu ───────────────────────────────────────────────────────────
function toggleGADLotExportMenu() {
  const menu = document.getElementById('gad-lot-export-menu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function triggerGADLotExport(format) {
  const menu = document.getElementById('gad-lot-export-menu');
  if (menu) menu.style.display = 'none';
  if (!_currentGADLotId) return;
  const btn  = document.getElementById('gad-lot-export-btn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.textContent = 'Preparing…'; btn.disabled = true; }
  const a = document.createElement('a');
  a.href = `/api/gad/lots/${_currentGADLotId}/export?format=${format}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => { if (btn) { btn.innerHTML = orig; btn.disabled = false; } }, 2000);
}

// Close menu when clicking outside
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('gad-lot-export-wrap');
  const menu = document.getElementById('gad-lot-export-menu');
  if (wrap && menu && !wrap.contains(e.target)) menu.style.display = 'none';
});
