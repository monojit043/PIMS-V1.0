// PIMS Dashboard JS

document.addEventListener('DOMContentLoaded', async () => {

  // ── Auth check ──
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { window.location.href = '/index.html'; return; }
    const user = await res.json();
    setUserInfo(user);
  } catch {
    window.location.href = '/index.html';
    return;
  }

  // ── Load stats ──
  loadStats();

  // ── Load projects table ──
  loadProjects();

  // ── Load stored line lists ──
  loadStoredLinelists();


  // ── Mobile menu ──
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  document.getElementById('mobMenuBtn')?.addEventListener('click', () => {
    sidebar.classList.toggle('mob-open');
    overlay.classList.toggle('visible');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('mob-open');
    overlay.classList.remove('visible');
  });

  // ── User dropdown + logout + change password ──
  (function () {
    async function doLogout() {
      try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
      window.location.href = '/index.html';
    }
    document.getElementById('tuSignOutBtn')?.addEventListener('click', doLogout);

    // Dropdown toggle (position: fixed anchored to button)
    const tuWrap = document.getElementById('tuWrap');
    const tuBtn  = document.getElementById('tuBtn');
    const tuDd   = document.getElementById('tuDropdown');
    if (tuBtn && tuDd) {
      tuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const isOpen = tuWrap.classList.toggle('open');
        tuDd.classList.toggle('open', isOpen);
        if (isOpen) {
          const rect = tuBtn.getBoundingClientRect();
          tuDd.style.top   = (rect.bottom + 8) + 'px';
          tuDd.style.right = (window.innerWidth - rect.right) + 'px';
        }
      });
      document.addEventListener('click', function () {
        tuWrap.classList.remove('open');
        tuDd.classList.remove('open');
      });
      tuDd.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    // Change Password modal
    const cpwBg     = document.getElementById('cpwModalBg');
    const cpwClose  = document.getElementById('cpwClose');
    const cpwCancel = document.getElementById('cpwCancel');
    const cpwForm   = document.getElementById('cpwForm');
    const cpwMsg    = document.getElementById('cpwMsg');
    const cpwBtn    = document.getElementById('changePasswordBtn');

    function openCpw() {
      tuDd?.classList.remove('open');
      tuWrap?.classList.remove('open');
      cpwForm.reset();
      cpwMsg.textContent = ''; cpwMsg.className = 'cpw-msg';
      cpwBg.classList.add('open');
    }
    function closeCpw() { cpwBg.classList.remove('open'); }

    cpwBtn?.addEventListener('click', openCpw);
    cpwClose?.addEventListener('click', closeCpw);
    cpwCancel?.addEventListener('click', closeCpw);
    cpwBg?.addEventListener('click', function (e) { if (e.target === cpwBg) closeCpw(); });

    cpwForm?.addEventListener('submit', async function (e) {
      e.preventDefault();
      const cur  = document.getElementById('cpwCurrent').value.trim();
      const nw   = document.getElementById('cpwNew').value;
      const conf = document.getElementById('cpwConfirm').value;
      cpwMsg.textContent = ''; cpwMsg.className = 'cpw-msg';
      if (!cur || !nw || !conf) {
        cpwMsg.textContent = 'All fields are required.'; cpwMsg.className = 'cpw-msg err'; return;
      }
      if (nw !== conf) {
        cpwMsg.textContent = 'New passwords do not match.'; cpwMsg.className = 'cpw-msg err'; return;
      }
      if (nw.length < 6) {
        cpwMsg.textContent = 'Password must be at least 6 characters.'; cpwMsg.className = 'cpw-msg err'; return;
      }
      try {
        const res  = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: cur, newPassword: nw })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          cpwMsg.textContent = 'Password changed. Redirecting to login…'; cpwMsg.className = 'cpw-msg ok';
          setTimeout(() => { window.location.href = '/index.html'; }, 1600);
        } else {
          cpwMsg.textContent = data.message || 'Failed to change password.'; cpwMsg.className = 'cpw-msg err';
        }
      } catch (_) {
        cpwMsg.textContent = 'Network error. Please try again.'; cpwMsg.className = 'cpw-msg err';
      }
    });
  })();

  // ── Search shortcut ──
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('globalSearch')?.focus();
    }
  });


});

// ── Set user info in the UI ──
function setUserInfo(user) {
  const displayName = user.name || 'User';
  const firstName = displayName.split(' ')[0];
  const role = user.isHod ? 'Head of Department' : user.isSgl ? 'Senior Group Leader' : 'Engineer';

  document.querySelectorAll('.loggedUser').forEach(el => { el.textContent = displayName; });
  document.getElementById('topbarUserRole').textContent = role;
  document.getElementById('tuDdRole').textContent = role;
  document.getElementById('welcomeName').textContent = firstName;
}

// ── Load dashboard stats ──
async function loadStats() {
  try {
    const [projectsRes, drawingsRes] = await Promise.all([
      fetch('/api/projects/assigned').catch(() => null),
      fetch('/api/drawings/stats').catch(() => null),
    ]);

    let totalLines = 0, stressLines = 0, pendingIsos = 0, lmsRecords = 0;

    if (drawingsRes?.ok) {
      const data = await drawingsRes.json();
      totalLines  = data.total_lines  ?? data.totalLines  ?? 0;
      stressLines = data.stress_lines ?? data.stressLines ?? 0;
      pendingIsos = data.pending_isos ?? data.pendingIsos ?? 0;
      lmsRecords  = data.lms_records  ?? data.lmsRecords  ?? 0;
    } else if (projectsRes?.ok) {
      const projects = await projectsRes.json();
      const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
      list.forEach(p => {
        totalLines  += Number(p.total_lines  ?? p.totalLines  ?? 0);
        stressLines += Number(p.stress_lines ?? p.stressLines ?? 0);
        pendingIsos += Number(p.pending_isos ?? p.pendingIsos ?? 0);
        lmsRecords  += Number(p.lms_records  ?? p.lmsRecords  ?? 0);
      });
    } else {
      // Fallback placeholder data
      totalLines = 12842; stressLines = 1287; pendingIsos = 320; lmsRecords = 9245;
    }

    animateCount('statTotalLines', totalLines);
    animateCount('statStressLines', stressLines);
    animateCount('statPendingIsos', pendingIsos);
    animateCount('statLmsRecords', lmsRecords);

  } catch {
    document.getElementById('statTotalLines').textContent = '—';
    document.getElementById('statStressLines').textContent = '—';
    document.getElementById('statPendingIsos').textContent = '—';
    document.getElementById('statLmsRecords').textContent = '—';
  }
}

// ── Animated counter ──
function animateCount(elId, target) {
  const el = document.getElementById(elId);
  if (!el) return;
  const duration = 900;
  const start = performance.now();
  const step = ts => {
    const progress = Math.min((ts - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(eased * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Load recent projects table ──
async function loadProjects() {
  const tbody = document.getElementById('projectsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/projects/assigned');
    if (!res.ok) throw new Error('Failed to load');

    const data = await res.json();
    const projects = Array.isArray(data) ? data : (data.projects ?? []);

    if (!projects.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No projects found.</td></tr>';
      return;
    }

    tbody.innerHTML = projects.slice(0, 8).map(p => {
      const name       = p.project_name ?? p.name ?? p.project_id ?? '—';
      const id         = p.project_id ?? '';
      const total      = Number(p.total_lines  ?? p.totalLines  ?? 0).toLocaleString();
      const critical   = Number(p.stress_lines ?? p.stressLines ?? 0).toLocaleString();
      const pending    = Number(p.pending_isos ?? p.pendingIsos ?? 0).toLocaleString();
      const lms        = Number(p.lms_records  ?? p.lmsRecords  ?? 0).toLocaleString();
      const pct        = Number(p.progress ?? p.completion_pct ?? 0);
      const status     = p.status ?? 'Active';
      const statusClass = status.toLowerCase() === 'active'  ? 'status-badge--active'
                        : status.toLowerCase() === 'pending' ? 'status-badge--pending'
                        : 'status-badge--closed';
      const label = id ? `${id} – ${name}` : name;

      return `<tr>
        <td><span class="proj-name">${escHtml(label)}</span></td>
        <td>${escHtml(total)}</td>
        <td><span class="proj-critical">${escHtml(critical)}</span></td>
        <td><span class="proj-pending">${escHtml(pending)}</span></td>
        <td>${escHtml(lms)}</td>
        <td>
          <div class="progress-wrap">
            <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(pct,100)}%"></div></div>
            <span class="progress-pct">${pct}%</span>
          </div>
        </td>
        <td><span class="status-badge ${statusClass}">${escHtml(status)}</span></td>
        <td>
          <button class="row-dots-btn" title="Options">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
            </svg>
          </button>
        </td>
      </tr>`;
    }).join('');

  } catch {
    tbody.innerHTML = `<tr>
      <td colspan="8" class="table-loading">
        Unable to load projects. <a href="#" onclick="loadProjects();return false;" style="color:var(--blue)">Retry</a>
      </td>
    </tr>`;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Load stored line lists from PIMS DB ──
async function loadStoredLinelists() {
  const tbody = document.getElementById('linelistTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/linelist/jobs');
    if (!res.ok) throw new Error('Failed');
    const jobs = await res.json();

    if (!jobs.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No line lists stored yet. <a href="ll-normalize.html" target="_blank">Upload one →</a></td></tr>';
      return;
    }

    tbody.innerHTML = jobs.map(j => {
      const units = Array.isArray(j.units) ? j.units.join(', ') : (j.units || '—');
      const files = Array.isArray(j.source_files) ? j.source_files.length : (j.source_files ? JSON.parse(j.source_files).length : 0);
      const date  = j.uploaded_at ? new Date(j.uploaded_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';

      return `<tr>
        <td><span class="proj-name">${escHtml(j.job_no)}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${escHtml(units)}</td>
        <td>${Number(j.row_count ?? 0).toLocaleString()}</td>
        <td><span class="status-badge status-badge--active">Rev ${escHtml(String(j.rev_no ?? 0))}</span></td>
        <td style="font-size:12px">${escHtml(j.uploaded_by ?? '—')}</td>
        <td style="font-size:12px;color:var(--text-muted)">${date}</td>
        <td style="font-size:12px;color:var(--text-muted)">${files} file${files !== 1 ? 's' : ''}</td>
        <td>
          <a class="row-dots-btn" href="ll-search.html?job=${encodeURIComponent(j.job_no)}" title="View lines" style="text-decoration:none;font-size:11px;color:var(--blue);">View →</a>
        </td>
      </tr>`;
    }).join('');

  } catch {
    tbody.innerHTML = `<tr><td colspan="8" class="table-loading">Unable to load. <a href="#" onclick="loadStoredLinelists();return false;" style="color:var(--blue)">Retry</a></td></tr>`;
  }
}
