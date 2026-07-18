'use strict';
// ── GAD review workflow: checker, modeller, GL, SGL ────────────────────────

// ─── Shared ────────────────────────────────────────────────────────────────

function _fmtDate(d) {
  return d ? new Date(d).toLocaleString('en-GB') : '—';
}

function _fileLink(path, label) {
  if (!path) return '—';
  const url = path.startsWith('/') ? path : `/${path}`;
  return `<a href="${url}" target="_blank" style="color:#2563eb;font-weight:600;text-decoration:none;">${label || 'Open PDF'}</a>`;
}

async function _loadGADHistory(gadNo, jobNo, unitNo, tbodyId, gadId) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = '<tr><td colspan="6" class="no-data">Loading…</td></tr>';
  try {
    const url = gadId
      ? `/api/gad/task-history?gadId=${encodeURIComponent(gadId)}`
      : `/api/gad/task-history?gadNo=${encodeURIComponent(gadNo)}&jobNo=${encodeURIComponent(jobNo)}`;
    const res  = await fetch(url);
    const data = await res.json();
    const rows = data.history || [];
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="no-data">No history yet</td></tr>'; return; }
    tbody.innerHTML = rows.map(r => {
      const commentCell = r.comment
        ? `<span style="display:inline-block;max-width:260px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#1e293b;">${r.comment}</span>`
        : '—';
      return `<tr>
        <td>${r.file_name ? _fileLink(r.file_path || '', r.file_name) : '—'}</td>
        <td>${r.rev_no ?? '—'}</td>
        <td>${r.performed_by_name || r.from_name || '—'}</td>
        <td>${r.comment_type || '—'}</td>
        <td>${commentCell}</td>
        <td>${_fmtDate(r.created_at)}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="6" class="no-data">Failed to load history</td></tr>';
  }
}

async function _loadModellerPool(selectId, jobNo, unitNo) {
  try {
    const res  = await fetch(`/api/gad/process-checkers?project=${encodeURIComponent(jobNo)}&unit=${encodeURIComponent(unitNo)}&role=PC`);
    const data = await res.json();
    const users = data.checkers || data.users || [];
    const sel   = document.getElementById(selectId);
    if (!sel) return;
    const existing = [...sel.options].map(o => o.value);
    users.forEach(u => {
      if (!existing.includes(String(u.id))) {
        const o = document.createElement('option');
        o.value = u.id; o.textContent = u.name;
        sel.appendChild(o);
      }
    });
  } catch(e) {}
}

async function _loadSCPool(selectId, jobNo, unitNo) {
  try {
    const res  = await fetch(`/api/gad/process-checkers?project=${encodeURIComponent(jobNo)}&unit=${encodeURIComponent(unitNo)}&role=SC`);
    const data = await res.json();
    const users = data.checkers || data.users || [];
    const sel   = document.getElementById(selectId);
    if (!sel) return;
    const existing = [...sel.options].map(o => o.value);
    users.forEach(u => {
      if (!existing.includes(String(u.id))) {
        const o = document.createElement('option');
        o.value = u.id; o.textContent = u.name;
        sel.appendChild(o);
      }
    });
  } catch(e) {}
}

// ─── CHECKER REVIEW PANEL ──────────────────────────────────────────────────

function openGADCheckerPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-checker-panel');

  document.getElementById('gcrp-gad-no').textContent  = gad.gad_no  || '—';
  document.getElementById('gcrp-area').textContent    = `Area ${gad.area_no || '—'}`;
  document.getElementById('gcrp-rev').textContent     = gad.rev_no  ?? '—';
  document.getElementById('gcrp-status').textContent  = gad.status  || '—';
  document.getElementById('gcrp-file-link').innerHTML = gad.mainFile ? _fileLink(gad.mainFile, 'Open Current PDF') : '—';

  // GL Commented panel visibility
  const glPanel = document.getElementById('gcrp-gl-commented-panel');
  glPanel.style.display = (gad.status === 'GL Commented') ? 'block' : 'none';

  // Reset comment type
  document.querySelectorAll('[name="gcrp-comment-type"]').forEach(r => r.checked = false);
  document.getElementById('gcrp-text-input').disabled  = true;
  document.getElementById('gcrp-text-input').value     = '';
  document.getElementById('gcrp-file-input').disabled  = true;
  document.getElementById('gcrp-file-input').value     = '';
  document.getElementById('gcrp-nc-checklist').style.display = 'none';
  document.querySelectorAll('.gcrp-nc-check').forEach(c => c.checked = false);
  document.getElementById('gcrp-post-btn').disabled    = true;
  document.getElementById('gcrp-annotation-info').textContent = '';

  // Good for Supporting (PC only)
  const role = (gadCurrentUser?.role || '').toLowerCase();
  const isPC = role.includes('pc') || role === 'process checker';
  document.getElementById('gcrp-gfs-section').style.display = isPC ? 'block' : 'none';

  // Wire radio change
  document.querySelectorAll('[name="gcrp-comment-type"]').forEach(radio => {
    radio.onchange = () => onGCRPCommentTypeChange(radio.value);
  });

  // Wire checklist
  document.querySelectorAll('.gcrp-nc-check').forEach(chk => {
    chk.onchange = updateGCRPPostBtn;
  });

  // Load history and pools
  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gcrp-history-body', gad.id);
  _loadModellerPool('gcrp-modeller-dropdown', gad.job_no, gad.unit_no);
  _loadSCPool('gcrp-sc-dropdown', gad.job_no, gad.unit_no);
}

function onGCRPCommentTypeChange(type) {
  document.getElementById('gcrp-text-input').disabled  = type !== 'text';
  document.getElementById('gcrp-file-input').disabled  = type !== 'file';
  document.getElementById('gcrp-open-annotator').disabled = type !== 'annotation';
  document.getElementById('gcrp-nc-checklist').style.display = type === 'none' ? 'block' : 'none';
  if (type === 'text')   { document.getElementById('gcrp-text-input').focus(); }
  if (type === 'none')   { document.querySelectorAll('.gcrp-nc-check').forEach(c => c.checked = false); }
  updateGCRPPostBtn();
}

function updateGCRPPostBtn() {
  const type = document.querySelector('[name="gcrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text')       ready = !!document.getElementById('gcrp-text-input').value.trim();
  if (type === 'file')       ready = !!document.getElementById('gcrp-file-input').files[0];
  if (type === 'annotation') ready = !!(window._gadAnnotationFile);
  if (type === 'none') {
    const checks = document.querySelectorAll('.gcrp-nc-check');
    const ticked = [...checks].filter(c => c.checked).length;
    ready = (ticked === checks.length);
    document.getElementById('gcrp-nc-hint').textContent =
      ready ? 'All verified — POST enabled.' : `Tick all ${checks.length} items to enable POST`;
  }
  document.getElementById('gcrp-post-btn').disabled = !type || !ready;
}

// Wire text/file inputs to update button
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('gcrp-text-input')?.addEventListener('input', updateGCRPPostBtn);
  document.getElementById('gcrp-file-input')?.addEventListener('change', updateGCRPPostBtn);
  document.getElementById('gglrp-text-input')?.addEventListener('input', updateGGLRPCommentBtn);
  document.getElementById('gglrp-file-input')?.addEventListener('change', updateGGLRPCommentBtn);
  document.getElementById('gsglrp-text-input')?.addEventListener('input', updateGSGLRPCommentBtn);
  document.getElementById('gsglrp-file-input')?.addEventListener('change', updateGSGLRPCommentBtn);
  document.querySelectorAll('[name="gglrp-comment-type"]').forEach(r => r.addEventListener('change', () => onGGLRPCommentTypeChange(r.value)));
  document.querySelectorAll('[name="gsglrp-comment-type"]').forEach(r => r.addEventListener('change', () => onGSGLRPCommentTypeChange(r.value)));
  // New 4-stage workflow panels
  document.getElementById('gbrp-text-input')?.addEventListener('input',   updateGBRPPostBtn);
  document.getElementById('gbrp-file-input')?.addEventListener('change',  updateGBRPPostBtn);
  document.getElementById('gbchrp-text-input')?.addEventListener('input',  updateGBCHRPPostBtn);
  document.getElementById('gbchrp-file-input')?.addEventListener('change', updateGBCHRPPostBtn);
  document.getElementById('gchrp-text-input')?.addEventListener('input',   updateGCHRPPostBtn);
  document.getElementById('gchrp-file-input')?.addEventListener('change',  updateGCHRPPostBtn);
  document.getElementById('gnglrp-text-input')?.addEventListener('input',   updateGNGLRPCommentBtn);
  document.getElementById('gnglrp-file-input')?.addEventListener('change',  updateGNGLRPCommentBtn);
});

async function postGADCheckerComments() {
  const gad  = gadCurrentTask;
  if (!gad) return;
  const type = document.querySelector('[name="gcrp-comment-type"]:checked')?.value;
  if (!type) return;

  const btn = document.getElementById('gcrp-post-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadNo',   gad.gad_no);
  fd.append('jobNo',   gad.job_no);
  fd.append('unitNo',  gad.unit_no);
  fd.append('commentType', type);

  if (type === 'text') {
    fd.append('comment', document.getElementById('gcrp-text-input').value.trim());
  } else if (type === 'file') {
    fd.append('file', document.getElementById('gcrp-file-input').files[0]);
  } else if (type === 'annotation' && window._gadAnnotationFile) {
    fd.append('file', window._gadAnnotationFile);
  }

  const modellerSel = document.getElementById('gcrp-modeller-dropdown');
  if (modellerSel.value) fd.append('targetModellerId', modellerSel.value);

  try {
    const res  = await fetch('/api/gad/submit-checker-comments', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'POST';
  }
}

async function gadSubmitGoodForSupporting() {
  const gad = gadCurrentTask;
  if (!gad) return;
  const btn = document.getElementById('gcrp-gfs-btn');
  btn.disabled = true; btn.textContent = 'Sending…';

  const scUserId = document.getElementById('gcrp-sc-dropdown').value || null;
  try {
    const res  = await fetch('/api/gad/send-for-supporting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gadNo: gad.gad_no, jobNo: gad.job_no, unitNo: gad.unit_no, assignedScUserId: scUserId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    btn.textContent = '✓ Sent';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'Good for Supporting ✓';
  }
}

function gadToggleGLEditPanel() {
  const p = document.getElementById('gcrp-gl-edit-panel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

async function gadForwardGLToModeller(mode) {
  const gad = gadCurrentTask;
  if (!gad) return;

  const fd = new FormData();
  fd.append('gadNo',       gad.gad_no);
  fd.append('jobNo',       gad.job_no);
  fd.append('unitNo',      gad.unit_no);
  fd.append('forwardType', mode);
  if (mode === 'edit') {
    fd.append('comment', document.getElementById('gcrp-gl-edit-comment').value.trim());
    const f = document.getElementById('gcrp-gl-edit-file').files[0];
    if (f) fd.append('file', f);
  }

  try {
    const res  = await fetch('/api/gad/forward-gl-to-modeller', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    loadGADMyTasks();
  } catch(e) { alert(e.message); }
}

// ─── MODELLER RESUBMIT PANEL ───────────────────────────────────────────────

let _gmrpFile = null;

function openGADModellerPanel(gad) {
  gadCurrentTask = gad;
  _gmrpFile = null;
  showGADPanel('gad-modeller-panel');

  document.getElementById('gmrp-gad-no').textContent = gad.gad_no || '—';
  document.getElementById('gmrp-area').textContent   = `Area ${gad.area_no || '—'}`;
  document.getElementById('gmrp-rev').textContent    = gad.rev_no ?? '—';
  document.getElementById('gmrp-status').textContent = gad.status || '—';

  document.getElementById('gmrp-drop-label').innerHTML = 'Drag &amp; drop revised GAD here, or <span class="mrp-browse-link">browse</span>';
  document.getElementById('gmrp-comment-input').value  = '';
  document.getElementById('gmrp-status-msg').textContent = '';
  document.getElementById('gmrp-post-btn').disabled = true;
  document.getElementById('gmrp-file-input').value  = '';

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gmrp-history-body', gad.id);
}

function _gmrpHandleFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    document.getElementById('gmrp-status-msg').style.color = '#dc2626';
    document.getElementById('gmrp-status-msg').textContent = 'Only PDF files allowed.';
    return;
  }
  _gmrpFile = file;
  document.getElementById('gmrp-drop-label').textContent = `✓ ${file.name}`;
  document.getElementById('gmrp-status-msg').textContent = '';
  document.getElementById('gmrp-post-btn').disabled = false;
}

async function submitGADModellerResubmit() {
  const gad = gadCurrentTask;
  if (!gad || !_gmrpFile) return;

  const btn = document.getElementById('gmrp-post-btn');
  const msg = document.getElementById('gmrp-status-msg');
  btn.disabled = true; btn.textContent = 'Uploading…';

  const fd = new FormData();
  fd.append('gadNo',   gad.gad_no);
  fd.append('jobNo',   gad.job_no);
  fd.append('unitNo',  gad.unit_no);
  fd.append('areaNno', gad.area_no);
  fd.append('comment', document.getElementById('gmrp-comment-input').value.trim());
  fd.append('file',    _gmrpFile);

  try {
    const res  = await fetch('/api/gad/modeller-resubmit', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    msg.style.color = '#16a34a'; msg.textContent = '✓ Re-submitted successfully.';
    btn.textContent = '✓ Done';
    setTimeout(() => { loadGADModellerTasks(); refreshGADTree(); }, 1200);
  } catch(e) {
    msg.style.color = '#dc2626'; msg.textContent = e.message;
    btn.disabled = false; btn.textContent = 'POST';
  }
}

// ─── GL REVIEW PANEL ───────────────────────────────────────────────────────

function openGADGLPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-gl-panel');

  document.getElementById('gglrp-gad-no').textContent  = gad.gad_no || '—';
  document.getElementById('gglrp-area').textContent    = `Area ${gad.area_no || '—'}`;
  document.getElementById('gglrp-rev').textContent     = gad.rev_no ?? '—';
  document.getElementById('gglrp-status').textContent  = gad.status || '—';
  document.getElementById('gglrp-file-link').innerHTML = gad.mainFile ? _fileLink(gad.mainFile, 'Open PDF') : '—';

  document.querySelectorAll('[name="gglrp-comment-type"]').forEach(r => r.checked = false);
  document.getElementById('gglrp-text-input').disabled = true;
  document.getElementById('gglrp-text-input').value    = '';
  document.getElementById('gglrp-file-input').disabled = true;
  document.getElementById('gglrp-file-input').value    = '';
  document.getElementById('gglrp-comment-btn').disabled = true;
  document.getElementById('gglrp-route-to-section').style.display = 'none';

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gglrp-history-body', gad.id);
}

function onGGLRPCommentTypeChange(type) {
  document.getElementById('gglrp-text-input').disabled = type !== 'text';
  document.getElementById('gglrp-file-input').disabled = type !== 'file';
  document.getElementById('gglrp-route-to-section').style.display = type ? 'block' : 'none';
  if (type === 'text') document.getElementById('gglrp-text-input').focus();
  updateGGLRPCommentBtn();
}

function updateGGLRPCommentBtn() {
  const type = document.querySelector('[name="gglrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text') ready = !!document.getElementById('gglrp-text-input').value.trim();
  if (type === 'file') ready = !!document.getElementById('gglrp-file-input').files[0];
  const routeLabel = document.querySelector('[name="gglrp-route-to"]:checked')?.value === 'sc' ? 'SC' : 'PC';
  const btn = document.getElementById('gglrp-comment-btn');
  btn.disabled = !ready;
  btn.textContent = `POST Comments → ${routeLabel}`;
}

async function postGADGLComments() {
  const gad  = gadCurrentTask;
  if (!gad) return;
  const type  = document.querySelector('[name="gglrp-comment-type"]:checked')?.value;
  const route = document.querySelector('[name="gglrp-route-to"]:checked')?.value || 'pc';

  const btn = document.getElementById('gglrp-comment-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadNo',   gad.gad_no);
  fd.append('jobNo',   gad.job_no);
  fd.append('unitNo',  gad.unit_no);
  fd.append('commentType', type);
  fd.append('routeToSC', route === 'sc' ? 'true' : 'false');
  if (type === 'text') fd.append('comment', document.getElementById('gglrp-text-input').value.trim());
  if (type === 'file') fd.append('file', document.getElementById('gglrp-file-input').files[0]);

  try {
    const res  = await fetch('/api/gad/submit-gl-comments', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADGLTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = `POST Comments → ${route.toUpperCase()}`;
  }
}

async function approveGADGL() {
  const gad = gadCurrentTask;
  if (!gad) return;
  if (!confirm(`Approve GAD ${gad.gad_no} → Final?`)) return;

  try {
    const res  = await fetch('/api/gad/submit-gl-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gadNo: gad.gad_no, jobNo: gad.job_no, unitNo: gad.unit_no, commentType: 'approve' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('gglrp-approve-btn').textContent = '✓ Approved';
    setTimeout(() => { loadGADGLTasks(); refreshGADTree(); }, 1000);
  } catch(e) { alert(e.message); }
}

async function sendGADToSGL() {
  const gad = gadCurrentTask;
  if (!gad) return;
  if (!confirm(`Escalate GAD ${gad.gad_no} to SGL?`)) return;

  try {
    const res  = await fetch('/api/gad/submit-gl-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gadNo: gad.gad_no, jobNo: gad.job_no, unitNo: gad.unit_no, commentType: 'sgl' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('gglrp-sgl-btn').textContent = '✓ Sent to SGL';
    setTimeout(() => { loadGADGLTasks(); refreshGADTree(); }, 1000);
  } catch(e) { alert(e.message); }
}

// ─── SGL REVIEW PANEL ──────────────────────────────────────────────────────

function openGADSGLPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-sgl-panel');

  document.getElementById('gsglrp-gad-no').textContent  = gad.gad_no || '—';
  document.getElementById('gsglrp-area').textContent    = `Area ${gad.area_no || '—'}`;
  document.getElementById('gsglrp-rev').textContent     = gad.rev_no ?? '—';
  document.getElementById('gsglrp-status').textContent  = gad.status || '—';
  document.getElementById('gsglrp-file-link').innerHTML = gad.mainFile ? _fileLink(gad.mainFile, 'Open PDF') : '—';

  document.querySelectorAll('[name="gsglrp-comment-type"]').forEach(r => r.checked = false);
  document.getElementById('gsglrp-text-input').disabled = true;
  document.getElementById('gsglrp-text-input').value    = '';
  document.getElementById('gsglrp-file-input').disabled = true;
  document.getElementById('gsglrp-file-input').value    = '';
  document.getElementById('gsglrp-comment-btn').disabled = true;

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gsglrp-history-body', gad.id);
}

function onGSGLRPCommentTypeChange(type) {
  document.getElementById('gsglrp-text-input').disabled = type !== 'text';
  document.getElementById('gsglrp-file-input').disabled = type !== 'file';
  if (type === 'text') document.getElementById('gsglrp-text-input').focus();
  updateGSGLRPCommentBtn();
}

function updateGSGLRPCommentBtn() {
  const type = document.querySelector('[name="gsglrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text') ready = !!document.getElementById('gsglrp-text-input').value.trim();
  if (type === 'file') ready = !!document.getElementById('gsglrp-file-input').files[0];
  document.getElementById('gsglrp-comment-btn').disabled = !ready;
}

async function postGADSGLComments() {
  const gad  = gadCurrentTask;
  if (!gad) return;
  const type = document.querySelector('[name="gsglrp-comment-type"]:checked')?.value;

  const btn = document.getElementById('gsglrp-comment-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadNo',       gad.gad_no);
  fd.append('jobNo',       gad.job_no);
  fd.append('unitNo',      gad.unit_no);
  fd.append('commentType', type);
  fd.append('roles',       JSON.stringify(['SGL']));
  if (type === 'text') fd.append('comment', document.getElementById('gsglrp-text-input').value.trim());
  if (type === 'file') fd.append('file', document.getElementById('gsglrp-file-input').files[0]);

  try {
    const res  = await fetch('/api/gad/submit-sgl-comments', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'POST Comments → PC';
  }
}

async function approveGADSGL() {
  const gad = gadCurrentTask;
  if (!gad) return;
  if (!confirm(`Approve GAD ${gad.gad_no} → Final?`)) return;

  try {
    const res  = await fetch('/api/gad/submit-sgl-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gadNo: gad.gad_no, jobNo: gad.job_no, unitNo: gad.unit_no, commentType: 'approve', roles: ['SGL'] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('gsglrp-approve-btn').textContent = '✓ Approved';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) { alert(e.message); }
}

// ─── BY REVIEW PANEL ─────────────────────────────────────────────────────

function openGADByPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-by-panel');

  document.getElementById('gbrp-gad-no').textContent  = gad.gad_no  || '—';
  document.getElementById('gbrp-area').textContent    = `Area ${gad.area_no || '—'}`;
  document.getElementById('gbrp-rev').textContent     = gad.rev_no  ?? '—';
  document.getElementById('gbrp-status').textContent  = gad.status  || '—';
  document.getElementById('gbrp-file-link').innerHTML = gad.mainFile ? _fileLink(gad.mainFile, 'Open Current PDF') : '—';

  document.querySelectorAll('[name="gbrp-comment-type"]').forEach(r => { r.checked = false; r.onchange = () => onGBRPCommentTypeChange(r.value); });
  document.getElementById('gbrp-text-input').disabled = true;
  document.getElementById('gbrp-text-input').value    = '';
  document.getElementById('gbrp-file-input').disabled = true;
  document.getElementById('gbrp-file-input').value    = '';
  document.getElementById('gbrp-nc-checklist').style.display = 'none';
  document.querySelectorAll('.gbrp-nc-check').forEach(c => { c.checked = false; c.onchange = updateGBRPPostBtn; });
  document.getElementById('gbrp-post-btn').disabled   = true;

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gbrp-history-body', gad.id);
}

function onGBRPCommentTypeChange(type) {
  document.getElementById('gbrp-text-input').disabled = type !== 'text';
  document.getElementById('gbrp-file-input').disabled = type !== 'file';
  document.getElementById('gbrp-nc-checklist').style.display = type === 'none' ? 'block' : 'none';
  if (type === 'text')  document.getElementById('gbrp-text-input').focus();
  if (type === 'none')  document.querySelectorAll('.gbrp-nc-check').forEach(c => c.checked = false);
  updateGBRPPostBtn();
}

function updateGBRPPostBtn() {
  const type = document.querySelector('[name="gbrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text') ready = !!document.getElementById('gbrp-text-input').value.trim();
  if (type === 'file') ready = !!document.getElementById('gbrp-file-input').files[0];
  if (type === 'none') {
    const checks = document.querySelectorAll('.gbrp-nc-check');
    const ticked = [...checks].filter(c => c.checked).length;
    ready = (ticked === checks.length);
    document.getElementById('gbrp-nc-hint').textContent =
      ready ? 'All verified — POST enabled.' : `Tick all ${checks.length} items to enable POST`;
  }
  document.getElementById('gbrp-post-btn').disabled = !type || !ready;
}

async function submitByReview() {
  const gad  = gadCurrentTask;
  if (!gad) return;
  const type = document.querySelector('[name="gbrp-comment-type"]:checked')?.value;
  if (!type) return;

  const btn = document.getElementById('gbrp-post-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadId',       gad.id);
  fd.append('commentType', type);
  if (type === 'text') fd.append('comment', document.getElementById('gbrp-text-input').value.trim());
  if (type === 'file') fd.append('file', document.getElementById('gbrp-file-input').files[0]);

  try {
    const res  = await fetch('/api/gad/submit-by-review', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'POST';
  }
}

// ─── BY+CHECK UNIFIED REVIEW PANEL ──────────────────────────────────────

function openGADByCheckPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-bycheckrp-panel');

  document.getElementById('gbchrp-gad-no').textContent  = gad.gad_no  || '—';
  document.getElementById('gbchrp-area').textContent    = `Area ${gad.area_no || '—'}`;
  document.getElementById('gbchrp-rev').textContent     = gad.rev_no  ?? '—';
  document.getElementById('gbchrp-status').textContent  = gad.status  || '—';
  document.getElementById('gbchrp-file-link').innerHTML = gad.mainFile ? _fileLink(gad.mainFile, 'Open Current PDF') : '—';

  document.querySelectorAll('[name="gbchrp-comment-type"]').forEach(r => { r.checked = false; r.onchange = () => onGBCHRPCommentTypeChange(r.value); });
  document.getElementById('gbchrp-text-input').disabled = true;
  document.getElementById('gbchrp-text-input').value    = '';
  document.getElementById('gbchrp-file-input').disabled = true;
  document.getElementById('gbchrp-file-input').value    = '';
  document.getElementById('gbchrp-nc-checklist').style.display = 'none';
  document.querySelectorAll('.gbchrp-nc-check').forEach(c => { c.checked = false; c.onchange = updateGBCHRPPostBtn; });
  document.getElementById('gbchrp-post-btn').disabled   = true;

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gbchrp-history-body', gad.id);
}

function onGBCHRPCommentTypeChange(type) {
  document.getElementById('gbchrp-text-input').disabled = type !== 'text';
  document.getElementById('gbchrp-file-input').disabled = type !== 'file';
  document.getElementById('gbchrp-nc-checklist').style.display = type === 'none' ? 'block' : 'none';
  if (type === 'text') document.getElementById('gbchrp-text-input').focus();
  if (type === 'none') document.querySelectorAll('.gbchrp-nc-check').forEach(c => c.checked = false);
  updateGBCHRPPostBtn();
}

function updateGBCHRPPostBtn() {
  const type = document.querySelector('[name="gbchrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text') ready = !!document.getElementById('gbchrp-text-input').value.trim();
  if (type === 'file') ready = !!document.getElementById('gbchrp-file-input').files[0];
  if (type === 'none') {
    const checks = document.querySelectorAll('.gbchrp-nc-check');
    const ticked = [...checks].filter(c => c.checked).length;
    ready = (ticked === checks.length);
    document.getElementById('gbchrp-nc-hint').textContent =
      ready ? 'All verified — POST enabled.' : `Tick all ${checks.length} items to enable POST`;
  }
  document.getElementById('gbchrp-post-btn').disabled = !type || !ready;
}

async function submitByCheckReview() {
  const gad  = gadCurrentTask;
  if (!gad) return;
  const type = document.querySelector('[name="gbchrp-comment-type"]:checked')?.value;
  if (!type) return;

  const btn = document.getElementById('gbchrp-post-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadId',       gad.id);
  fd.append('commentType', type);
  if (type === 'text') fd.append('comment', document.getElementById('gbchrp-text-input').value.trim());
  if (type === 'file') fd.append('file', document.getElementById('gbchrp-file-input').files[0]);

  try {
    const res  = await fetch('/api/gad/submit-bycheckReview', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'POST';
  }
}

// ─── CHECK REVIEW PANEL ──────────────────────────────────────────────────

function openGADCheckPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-check-panel');

  document.getElementById('gchrp-gad-no').textContent  = gad.gad_no  || '—';
  document.getElementById('gchrp-area').textContent    = `Area ${gad.area_no || '—'}`;
  document.getElementById('gchrp-rev').textContent     = gad.rev_no  ?? '—';
  document.getElementById('gchrp-status').textContent  = gad.status  || '—';
  document.getElementById('gchrp-file-link').innerHTML = gad.mainFile ? _fileLink(gad.mainFile, 'Open Current PDF') : '—';

  const isCombined = gad.by_user_id && gad.checked_user_id &&
                     String(gad.by_user_id) === String(gad.checked_user_id);
  document.getElementById('gchrp-combined-badge').style.display = isCombined ? '' : 'none';

  document.querySelectorAll('[name="gchrp-comment-type"]').forEach(r => { r.checked = false; r.onchange = () => onGCHRPCommentTypeChange(r.value); });
  document.getElementById('gchrp-text-input').disabled = true;
  document.getElementById('gchrp-text-input').value    = '';
  document.getElementById('gchrp-file-input').disabled = true;
  document.getElementById('gchrp-file-input').value    = '';
  document.getElementById('gchrp-nc-checklist').style.display = 'none';
  document.querySelectorAll('.gchrp-nc-check').forEach(c => { c.checked = false; c.onchange = updateGCHRPPostBtn; });
  document.getElementById('gchrp-post-btn').disabled   = true;

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gchrp-history-body', gad.id);
}

function onGCHRPCommentTypeChange(type) {
  document.getElementById('gchrp-text-input').disabled = type !== 'text';
  document.getElementById('gchrp-file-input').disabled = type !== 'file';
  document.getElementById('gchrp-nc-checklist').style.display = type === 'none' ? 'block' : 'none';
  if (type === 'text')  document.getElementById('gchrp-text-input').focus();
  if (type === 'none')  document.querySelectorAll('.gchrp-nc-check').forEach(c => c.checked = false);
  updateGCHRPPostBtn();
}

function updateGCHRPPostBtn() {
  const type = document.querySelector('[name="gchrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text') ready = !!document.getElementById('gchrp-text-input').value.trim();
  if (type === 'file') ready = !!document.getElementById('gchrp-file-input').files[0];
  if (type === 'none') {
    const checks = document.querySelectorAll('.gchrp-nc-check');
    const ticked = [...checks].filter(c => c.checked).length;
    ready = (ticked === checks.length);
    document.getElementById('gchrp-nc-hint').textContent =
      ready ? 'All verified — POST enabled.' : `Tick all ${checks.length} items to enable POST`;
  }
  document.getElementById('gchrp-post-btn').disabled = !type || !ready;
}

async function submitCheckReview() {
  const gad  = gadCurrentTask;
  if (!gad) return;
  const type = document.querySelector('[name="gchrp-comment-type"]:checked')?.value;
  if (!type) return;

  const btn = document.getElementById('gchrp-post-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadId',       gad.id);
  fd.append('commentType', type);
  if (type === 'text') fd.append('comment', document.getElementById('gchrp-text-input').value.trim());
  if (type === 'file') fd.append('file', document.getElementById('gchrp-file-input').files[0]);

  try {
    const res  = await fetch('/api/gad/submit-check-review', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADMyTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'POST';
  }
}

// ─── NEW GL REVIEW PANEL ─────────────────────────────────────────────────

function openGADNewGLPanel(gad) {
  gadCurrentTask = gad;
  showGADPanel('gad-new-gl-panel');

  document.getElementById('gnglrp-gad-no').textContent   = gad.gad_no       || '—';
  document.getElementById('gnglrp-area').textContent     = `Area ${gad.area_no || '—'}`;
  document.getElementById('gnglrp-rev').textContent      = gad.rev_no        ?? '—';
  document.getElementById('gnglrp-status').textContent   = gad.status        || '—';
  document.getElementById('gnglrp-file-link').innerHTML  = gad.mainFile ? _fileLink(gad.mainFile, 'Open PDF') : '—';
  document.getElementById('gnglrp-by-name').textContent  = gad.by_name       || '—';
  document.getElementById('gnglrp-check-name').textContent = gad.checked_name || '—';

  document.querySelectorAll('[name="gnglrp-comment-type"]').forEach(r => { r.checked = false; r.onchange = () => onGNGLRPCommentTypeChange(r.value); });
  document.getElementById('gnglrp-text-input').disabled  = true;
  document.getElementById('gnglrp-text-input').value     = '';
  document.getElementById('gnglrp-file-input').disabled  = true;
  document.getElementById('gnglrp-file-input').value     = '';
  document.getElementById('gnglrp-comment-btn').disabled = true;
  document.getElementById('gnglrp-approve-btn').disabled = false;
  document.getElementById('gnglrp-approve-btn').textContent = '✓ Approve → Final';

  _loadGADHistory(gad.gad_no, gad.job_no, gad.unit_no, 'gnglrp-history-body', gad.id);
}

function onGNGLRPCommentTypeChange(type) {
  document.getElementById('gnglrp-text-input').disabled = type !== 'text';
  document.getElementById('gnglrp-file-input').disabled = type !== 'file';
  if (type === 'text') document.getElementById('gnglrp-text-input').focus();
  updateGNGLRPCommentBtn();
}

function updateGNGLRPCommentBtn() {
  const type = document.querySelector('[name="gnglrp-comment-type"]:checked')?.value;
  let ready  = false;
  if (type === 'text') ready = !!document.getElementById('gnglrp-text-input').value.trim();
  if (type === 'file') ready = !!document.getElementById('gnglrp-file-input').files[0];
  document.getElementById('gnglrp-comment-btn').disabled = !ready;
}

async function submitGLReview(mode) {
  const gad = gadCurrentTask;
  if (!gad) return;

  if (mode === 'approve') {
    if (!confirm(`Approve GAD ${gad.gad_no} → Final?`)) return;
    const btn = document.getElementById('gnglrp-approve-btn');
    btn.disabled = true; btn.textContent = 'Approving…';
    const fd = new FormData();
    fd.append('gadId', gad.id); fd.append('commentType', 'approve');
    try {
      const res  = await fetch('/api/gad/submit-gl-review', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Approve failed');
      btn.textContent = '✓ Approved → Final';
      setTimeout(() => { loadGADGLTasks(); refreshGADTree(); }, 1000);
    } catch(e) {
      alert(e.message); btn.disabled = false; btn.textContent = '✓ Approve → Final';
    }
    return;
  }

  const type = document.querySelector('[name="gnglrp-comment-type"]:checked')?.value;
  if (!type) return;
  const btn = document.getElementById('gnglrp-comment-btn');
  btn.disabled = true; btn.textContent = 'Posting…';

  const fd = new FormData();
  fd.append('gadId', gad.id); fd.append('commentType', type);
  if (type === 'text') fd.append('comment', document.getElementById('gnglrp-text-input').value.trim());
  if (type === 'file') fd.append('file', document.getElementById('gnglrp-file-input').files[0]);

  try {
    const res  = await fetch('/api/gad/submit-gl-review', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    btn.textContent = '✓ Posted';
    setTimeout(() => { loadGADGLTasks(); refreshGADTree(); }, 1000);
  } catch(e) {
    alert(e.message); btn.disabled = false; btn.textContent = 'POST Comments → Modeller';
  }
}

// ─── Annotation stub (wired to open the base-file annotator) ──────────────
function openGADAnnotator(prefix) {
  const gad = gadCurrentTask;
  if (!gad) return;
  const url = `/gad-annotator.html?gadNo=${encodeURIComponent(gad.gad_no)}&jobNo=${encodeURIComponent(gad.job_no)}&unitNo=${encodeURIComponent(gad.unit_no)}`;
  const w   = window.open(url, 'gadAnnotator', 'width=1200,height=800');
  if (!w) alert('Allow popups for the annotator to open.');
}
