'use strict';
// Notification claiming, my tasks, final GADs, GL tasks

// ── My Tasks ───────────────────────────────────────────────────────────────
async function loadGADMyTasks() {
  showGADPanel('gad-my-tasks');
  const tbody = document.getElementById('gad-my-tasks-body');
  tbody.innerHTML = '<tr><td colspan="9" class="no-data">Loading…</td></tr>';
  try {
    const res  = await fetch('/api/gad/my-claimed-tasks');
    const data = await res.json();
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="no-data">No claimed tasks</td></tr>';
      return;
    }
    tbody.innerHTML = tasks.map(t => {
      const role = t.claimed_role
        || (Array.isArray(t.claimed_roles) ? t.claimed_roles.join(', ') : (t.claimed_roles || '—'));
      const lot  = t.planned_lot_number ? `(P) L${t.planned_lot_number}` : '—';
      const time = t.uploaded_on ? new Date(t.uploaded_on).toLocaleString() : '—';
      const safeT = encodeURIComponent(JSON.stringify(t));
      return `<tr class="clickable-row" onclick="openMyGADTask(JSON.parse(decodeURIComponent('${safeT}')))">
        <td>${t.job_no}</td><td>${t.unit_no}</td><td>${t.area_no}</td>
        <td><strong>${t.gad_no}</strong></td>
        <td>${t.rev_no || 'R0-1'}</td>
        <td><span class="gad-status ${gadStatusClass(t.status)}">${t.status}</span></td>
        <td>${role}</td><td>${time}</td><td>${lot}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">Failed to load tasks</td></tr>';
  }
}

function openMyGADTask(task) {
  const status = (task.status || '').toLowerCase();
  const role   = task.claimed_role || '';
  if (role === 'By+Check' || status === 'by+check review')  return openGADByCheckPanel(task);
  if (role === 'By'       || status === 'by review')        return openGADByPanel(task);
  if (role === 'Check'    || status === 'check review')     return openGADCheckPanel(task);
  if (role === 'GL'       || status === 'gl review')        return openGADNewGLPanel(task);
  if (role === 'Modeller' || status.startsWith('returned')) return openGADModellerPanel(task);
  // old-workflow fallback
  openGADCheckerPanel(task);
}

function filterGADTasks(q) {
  document.querySelectorAll('#gad-my-tasks-body tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ── Final GADs ─────────────────────────────────────────────────────────────
async function loadGADFinalList() {
  showGADPanel('gad-final-panel');
  const tbody = document.getElementById('gad-final-body');
  const issueBtn = document.getElementById('gad-issue-lot-btn');
  tbody.innerHTML = '<tr><td colspan="7" class="no-data">Loading…</td></tr>';
  if (issueBtn) { issueBtn.disabled = true; issueBtn.style.opacity = '.5'; }
  const chkAll = document.getElementById('gad-final-check-all');
  if (chkAll) chkAll.checked = false;

  try {
    const res  = await fetch('/api/gads/final');
    const data = await res.json();
    const gads = data.gads || data || [];
    if (!gads.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="no-data">No final GADs yet</td></tr>';
      return;
    }
    tbody.innerHTML = gads.map(g => {
      const lotCell = g.plannedLotNumber
        ? `<span style="background:#7c3aed;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;">(P) L${g.plannedLotNumber}</span>`
        : '—';
      return `<tr>
        <td><input type="checkbox" class="gad-final-cb" data-id="${g.id}" data-job="${g.job_no}" data-unit="${g.unit_no}"
            onchange="syncGADIssueLotBtn()"></td>
        <td>${g.job_no}</td><td>${g.unit_no}</td><td>${g.area_no}</td>
        <td><a href="/${g.mainFile || ''}" target="_blank" style="color:#2563eb;text-decoration:none;font-weight:600;">${g.gad_no}</a></td>
        <td>${g.rev_no}</td>
        <td>${lotCell}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="7" class="no-data">Failed to load</td></tr>';
  }
}

function toggleAllGADFinalChecks(checked) {
  document.querySelectorAll('.gad-final-cb:not(:disabled)').forEach(c => c.checked = checked);
  syncGADIssueLotBtn();
}

function syncGADIssueLotBtn() {
  const checked = [...document.querySelectorAll('.gad-final-cb:checked')];
  const btn     = document.getElementById('gad-issue-lot-btn');
  if (!btn) return;
  const jobs  = new Set(checked.map(c => c.dataset.job));
  const units = new Set(checked.map(c => c.dataset.unit));
  const ok    = checked.length > 0 && jobs.size === 1 && units.size === 1;
  btn.disabled    = !ok;
  btn.style.opacity = ok ? '1' : '.5';
}

// ── Modeller Tasks ─────────────────────────────────────────────────────────
async function loadGADModellerTasks() {
  showGADPanel('gad-my-tasks');
  const tbody = document.getElementById('gad-my-tasks-body');
  tbody.innerHTML = '<tr><td colspan="9" class="no-data">Loading…</td></tr>';
  try {
    const res  = await fetch('/api/gad/my-modeller-tasks');
    const data = await res.json();
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="no-data">No modeller tasks</td></tr>';
      return;
    }
    tbody.innerHTML = tasks.map(t => {
      const safeT = encodeURIComponent(JSON.stringify(t));
      return `<tr class="clickable-row" onclick="openGADModellerPanel(JSON.parse(decodeURIComponent('${safeT}')))">
        <td>${t.job_no}</td><td>${t.unit_no}</td><td>${t.area_no}</td>
        <td><strong>${t.gad_no}</strong></td>
        <td>${t.rev_no}</td>
        <td><span class="gad-status ${gadStatusClass(t.status)}">${t.status}</span></td>
        <td>Modeller</td><td>${t.uploaded_on ? new Date(t.uploaded_on).toLocaleString() : '—'}</td><td>—</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">Failed to load</td></tr>';
  }
}

// ── Checker / Pool Notifications ───────────────────────────────────────────
async function loadGADCheckerNotif(forceRole) {
  showGADPanel('gad-notif-panel');
  document.getElementById('gad-notif-eyebrow').textContent = forceRole === 'SGL' ? 'SGL' : 'Notifications';
  document.getElementById('gad-notif-title').innerHTML = 'Available <em>GADs</em>';
  const tbody = document.getElementById('gad-notif-body');
  tbody.innerHTML = '<tr><td colspan="9" class="no-data">Loading…</td></tr>';

  try {
    const url    = forceRole === 'SGL' ? '/api/gad/notifications-by-role?role=SGL' : '/api/gad/notifications';
    const res    = await fetch(url);
    const data   = await res.json();
    const notifs = data.notifications || data || [];

    document.getElementById('gad-notif-count').textContent = `(${notifs.length} available)`;

    if (!notifs.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="no-data">No available notifications</td></tr>';
      return;
    }

    tbody.innerHTML = notifs.map((n, i) => {
      const date   = n.created_at ? new Date(n.created_at).toLocaleString() : '—';
      const status = (n.status || '').toLowerCase();
      const claimCell = status === 'ready for check'
        ? `<span style="background:#7c3aed;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.3px;">CHECK</span>`
        : `<span style="display:inline-flex;gap:4px;">
             <span class="gad-claim-badge selected" data-idx="${i}" data-type="By"
               onclick="selectGADClaimBadge(this)"
               style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;cursor:pointer;letter-spacing:.3px;background:#2563eb;color:#fff;border:1.5px solid #2563eb;">BY</span>
             <span class="gad-claim-badge" data-idx="${i}" data-type="By+Check"
               onclick="selectGADClaimBadge(this)"
               style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;cursor:pointer;letter-spacing:.3px;background:transparent;color:#7c3aed;border:1.5px solid #7c3aed;">BY+CHK</span>
           </span>`;
      return `<tr>
        <td><input type="checkbox" class="gad-notif-chk" data-idx="${i}"></td>
        <td>${n.job_no}</td><td>${n.unit_no}</td><td>${n.area_no}</td>
        <td><strong>${n.gad_no}</strong></td>
        <td>${n.rev_no || 'R0-1'}</td>
        <td>${n.from_name || '—'}</td>
        <td>${date}</td>
        <td>${claimCell}</td>
      </tr>`;
    }).join('');

    window._gadPendingNotifs = notifs;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">Failed to load notifications</td></tr>';
  }
}

function selectGADClaimBadge(badge) {
  const idx = badge.dataset.idx;
  // Reset all badges for this row
  document.querySelectorAll(`.gad-claim-badge[data-idx="${idx}"]`).forEach(b => {
    b.classList.remove('selected');
    if (b.dataset.type === 'By') {
      b.style.background = 'transparent';
      b.style.color      = '#2563eb';
    } else {
      b.style.background = 'transparent';
      b.style.color      = '#7c3aed';
    }
  });
  // Highlight clicked badge
  badge.classList.add('selected');
  badge.style.color = '#fff';
  badge.style.background = badge.dataset.type === 'By' ? '#2563eb' : '#7c3aed';
}

async function claimGADNotifications() {
  const notifs  = window._gadPendingNotifs || [];
  const checked = [...document.querySelectorAll('.gad-notif-chk:checked')];
  if (!checked.length) { alert('Select at least one notification to claim.'); return; }

  const claims = checked.map(chk => {
    const idx        = parseInt(chk.dataset.idx);
    const notif      = notifs[idx];
    const badge      = document.querySelector(`.gad-claim-badge.selected[data-idx="${idx}"]`);
    const claimType  = badge ? badge.dataset.type : 'By';
    return { gadId: notif.gad_id, gadNo: notif.gad_no, jobNo: notif.job_no, unitNo: notif.unit_no, areaNno: notif.area_no, claimType, roles: [] };
  });

  try {
    const res  = await fetch('/api/gad/claim-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Claim failed');
    await loadGADMyTasks();
  } catch(e) {
    alert(e.message || 'Failed to claim notifications.');
  }
}

// ── GL Tasks ───────────────────────────────────────────────────────────────
async function loadGADGLTasks() {
  showGADPanel('gad-gl-tasks');
  const tbody = document.getElementById('gad-gl-tasks-body');
  tbody.innerHTML = '<tr><td colspan="8" class="no-data">Loading…</td></tr>';
  try {
    const res  = await fetch('/api/gad/my-gl-tasks');
    const data = await res.json();
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="no-data">No GL tasks</td></tr>';
      return;
    }
    tbody.innerHTML = tasks.map((t, i) => {
      const safeT = encodeURIComponent(JSON.stringify(t));
      // New-workflow GL tasks have by_user_id set (went through By/Check stages)
      const openFn = t.by_user_id ? 'openGADNewGLPanel' : 'openGADGLPanel';
      return `<tr>
        <td><input type="checkbox" class="gad-gl-chk" data-idx="${i}"></td>
        <td>${t.job_no}</td><td>${t.unit_no}</td><td>${t.area_no}</td>
        <td class="clickable-row" onclick="${openFn}(JSON.parse(decodeURIComponent('${safeT}')))" style="cursor:pointer;color:#2563eb;font-weight:600;">${t.gad_no}</td>
        <td>${t.rev_no || 'R0-1'}</td>
        <td><span class="gad-status ${gadStatusClass(t.status)}">${t.status}</span></td>
        <td>${t.uploaded_on ? new Date(t.uploaded_on).toLocaleString() : '—'}</td>
      </tr>`;
    }).join('');
    window._gadGLTasks = tasks;
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" class="no-data">Failed to load</td></tr>';
  }
}

async function claimGADGLTasks() {
  const tasks   = window._gadGLTasks || [];
  const checked = [...document.querySelectorAll('.gad-gl-chk:checked')];
  if (!checked.length) { alert('Select at least one GAD to claim.'); return; }

  const claims = checked.map(chk => {
    const t = tasks[parseInt(chk.dataset.idx)];
    return { gadId: t.id, gadNo: t.gad_no, jobNo: t.job_no, unitNo: t.unit_no, roles: ['GL'] };
  });

  try {
    const res = await fetch('/api/gad/claim-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Claim failed');
    if (claims.length === 1) {
      const t = tasks[parseInt(checked[0].dataset.idx)];
      t.by_user_id ? openGADNewGLPanel(t) : openGADGLPanel(t);
    } else {
      loadGADGLTasks();
    }
  } catch(e) {
    alert(e.message || 'Failed to claim.');
  }
}
