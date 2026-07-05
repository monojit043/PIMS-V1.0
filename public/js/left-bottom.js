// Example role check, must be set after fetching role info for this project/unit.
window.ISO_CAN_FORWARD = false; // true if logged-in user is modeller, GL, SGL for this project/unit/zone
window.ISO_CAN_CHECKBOX = false; // true if logged-in user is modeller, GL, SGL for this project/unit/zone
// Call an API to determine these and set accordingly upon loading zone/project info.

// left-bottom.js - Updated to remove last two columns and fix comments
let currentTreeData    = {};  // assigned projects
let otherTreeData      = {};  // unassigned projects (read-only)
let assignedProjectIds = [];
let selectedProject = null;
let selectedUnit = null;
let selectedZone = null;
let _zoneClaimsMap    = {};
let _isoActiveFilters = {};
let _inchUnitMap      = {};   // { lineNo: { ...rowData } } — loaded per unit


// Initialize tree functionality
document.addEventListener('DOMContentLoaded', function () {
  loadProjectTree();
  setupContextMenu();
  setupTreeDelegation();
  setupProjectsToggle();
  setupOtherProjectsToggle();
  setupInboxToggle();
});

function setupInboxToggle() {
  const group = document.querySelector('[data-group="inbox"]');
  if (!group) return;
  const btn      = group.querySelector('.nav-group-btn');
  const children = group.querySelector('.nav-children');
  if (!btn || !children) return;

  // Open inbox by default
  group.classList.add('open');

  btn.addEventListener('click', function (e) {
    e.stopImmediatePropagation(); // block user.js handler on this button
    group.classList.toggle('open');
  }, true); // capture phase
}

function setupProjectsToggle() {
  const group = document.querySelector('[data-group="projects"]');
  if (!group) return;
  const btn      = group.querySelector('.nav-group-btn');
  const children = group.querySelector('.nav-children');
  if (!btn || !children) return;

  // Direct toggle — bypasses the user.js nav handler entirely
  btn.addEventListener('click', function (e) {
    e.stopImmediatePropagation(); // block user.js handler on this button
    const isOpen = group.classList.contains('open');
    if (isOpen) {
      group.classList.remove('open');
    } else {
      group.classList.add('open');
    }
  }, true); // capture phase — fires before user.js bubble-phase handler
}


function setupOtherProjectsToggle() {
  const group = document.querySelector('[data-group="other-projects"]');
  if (!group) return;
  const btn = group.querySelector('.nav-group-btn');
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    e.stopImmediatePropagation();
    group.classList.toggle('open');
  }, true);
  // collapsed by default — do not add 'open' class
}

// Load project tree from API — split into assigned (My Projects) and others
async function loadProjectTree() {
  try {
    const [treeRes, assignedRes, allProjectsRes] = await Promise.all([
      fetch('/api/tree'),
      fetch('/api/projects/assigned'),
      fetch('/api/projects'),
    ]);
    const treeData        = await treeRes.json();
    const assignedData    = await assignedRes.json();
    const allProjectsData = await allProjectsRes.json();

    if (!treeData.ok) { console.error('Failed to load project tree'); return; }

    assignedProjectIds = (assignedData.projects || []).map(function (p) { return p.id; });
    window.assignedProjectIds = assignedProjectIds;

    // My Projects: assigned jobs that have uploads
    currentTreeData = {};
    Object.keys(treeData.projects).forEach(function (jobNo) {
      if (assignedProjectIds.includes(jobNo)) {
        currentTreeData[jobNo] = treeData.projects[jobNo];
      }
    });

    // Other Projects: ALL projects not assigned to the user
    // Use tree data if uploads exist, otherwise mark as empty
    otherTreeData = {};
    const allProjects = (allProjectsData.projects || allProjectsData || []);
    allProjects.forEach(function (p) {
      const jobNo = p.id;
      if (assignedProjectIds.includes(jobNo)) return; // skip assigned
      otherTreeData[jobNo] = treeData.projects[jobNo] || null; // null = no uploads yet
    });

    renderProjectTree();
    renderOtherProjectTree();
  } catch (error) {
    console.error('Error loading project tree:', error);
  }
}


function _buildTreeHTML(treeData, idPrefix) {
  const ICO = {
    folder: `<svg class="tree-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    unit:   `<svg class="tree-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`,
    zone:   `<svg class="tree-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    file:   `<svg class="tree-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  };
  let html = '';
  Object.keys(treeData).forEach(function (project) {
    html += `<div class="tree-project">
      <div class="tree-item project-item" data-action="project" data-project="${project}" data-prefix="${idPrefix}">
        ${ICO.folder}${project}
      </div>
      <div class="tree-children" id="${idPrefix}proj-${project}" style="display:none;">`;

    Object.keys(treeData[project]).forEach(function (unit) {
      html += `<div class="tree-unit">
        <div class="tree-item unit-item" data-action="unit" data-project="${project}" data-unit="${unit}" data-prefix="${idPrefix}">
          ${ICO.unit}Unit ${unit}
        </div>
        <div class="tree-children" id="${idPrefix}unit-${project}-${unit}" style="display:none;">`;

      Object.keys(treeData[project][unit]).forEach(function (zone) {
        const lines = treeData[project][unit][zone];
        html += `<div class="tree-zone">
          <div class="tree-item zone-item" data-action="zone"
               data-project="${project}" data-unit="${unit}" data-zone="${zone}" data-prefix="${idPrefix}">
            ${ICO.zone}Zone ${zone}<span class="tree-count">${lines.length}</span>
          </div>
          <div class="tree-children" id="${idPrefix}zone-${project}-${unit}-${zone}" style="display:none;">`;

        lines.forEach(function (line) {
          const cls = line.status === 'Completed' ? 'tree-line--done' :
                      line.status === 'Uploaded'  ? 'tree-line--uploaded' : 'tree-line--active';
          const sc  = line.stressCritical === 'Y' ? ' ⚡' : '';
          html += `<div class="tree-item line-item ${cls}" data-action="open-zone"
               data-project="${project}" data-unit="${unit}" data-zone="${zone}" data-prefix="${idPrefix}"
               title="${line.status}${sc ? ' · Stress Critical' : ''}">${ICO.file}${line.lineNo}${sc}</div>`;
        });

        html += '</div></div>';
      });
      html += '</div></div>';
    });
    html += '</div></div>';
  });
  return html;
}

function renderProjectTree() {
  const container = document.getElementById('mp-tree');
  if (!container) return;
  if (!currentTreeData || Object.keys(currentTreeData).length === 0) {
    container.innerHTML = '<div class="tree-empty">No assigned projects with uploads yet.</div>';
    return;
  }
  container.innerHTML = _buildTreeHTML(currentTreeData, '');
}

function renderOtherProjectTree() {
  const container = document.getElementById('mp-tree-other');
  if (!container) return;
  if (!otherTreeData || Object.keys(otherTreeData).length === 0) {
    container.innerHTML = '<div class="tree-empty">No other projects.</div>';
    return;
  }

  const ICO_FOLDER = `<svg class="tree-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

  // Separate into jobs with uploads and jobs without
  const withUploads = {};
  let noUploadHTML  = '';

  Object.keys(otherTreeData).forEach(function (jobNo) {
    if (otherTreeData[jobNo]) {
      withUploads[jobNo] = otherTreeData[jobNo];
    } else {
      noUploadHTML += `<div class="tree-project">
        <div class="tree-item project-item" style="color:#94a3b8;" data-action="project" data-project="${jobNo}" data-prefix="oth-">
          ${ICO_FOLDER}${jobNo}
        </div>
        <div class="tree-children" id="oth-proj-${jobNo}" style="display:none;">
          <div class="tree-empty" style="padding-left:1.4rem;">No uploads yet.</div>
        </div>
      </div>`;
    }
  });

  container.innerHTML = _buildTreeHTML(withUploads, 'oth-') + noUploadHTML;
}


// Single delegated handler — handles both My Projects and Other Projects trees
function setupTreeDelegation() {
  [{ id: 'mp-tree', readonly: false }, { id: 'mp-tree-other', readonly: true }].forEach(function (cfg) {
    const treeRoot = document.getElementById(cfg.id);
    if (!treeRoot) return;

    treeRoot.addEventListener('click', function (e) {
      e.stopPropagation();
      const item = e.target.closest('[data-action]');
      if (!item) return;

      const action  = item.dataset.action;
      const project = item.dataset.project;
      const unit    = item.dataset.unit;
      const zone    = item.dataset.zone;
      const prefix  = item.dataset.prefix || '';

      if (action === 'project') {
        const el = document.getElementById(prefix + 'proj-' + project);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';

      } else if (action === 'unit') {
        const el = document.getElementById(prefix + 'unit-' + project + '-' + unit);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';

      } else if (action === 'zone' || action === 'open-zone') {
        window._readOnlyJob = cfg.readonly;
        selectZone(project, unit, zone);
      }
    });
  });
}




async function selectZone(project, unit, zone) {
  selectedProject = project;
  selectedUnit = unit;
  selectedZone = zone;

  // Hide welcome and other tables
  hideWelcomeAndTables();

  // Check user roles for this project/unit from backend
  try {
    const roleResponse = await fetch(`/api/check-iso-roles?project=${project}&unit=${unit}`);
    const roleData = await roleResponse.json();
    console.log('Role check response:', roleData);
    if (roleData.ok) {
      window.ISO_CAN_FORWARD = roleData.canForward === true;
      window.ISO_CAN_CHECKBOX = roleData.canCheckbox === true;
      console.log('ISO_CAN_FORWARD:', window.ISO_CAN_FORWARD);
      console.log('ISO_CAN_CHECKBOX:', window.ISO_CAN_CHECKBOX);
    } else {
      window.ISO_CAN_FORWARD = false;
      window.ISO_CAN_CHECKBOX = false;
      console.error('Role check failed:', roleData.error);
    }
  } catch (error) {
    console.error('Error checking roles:', error);
    window.ISO_CAN_FORWARD = false;
    window.ISO_CAN_CHECKBOX = false;
  }

  // Show ISO surface — replace welcome screen
  const isoSurface = document.getElementById('iso-surface-panel');
  if (isoSurface) {
    isoSurface.style.display = 'block';
    isoSurface.classList.add('active-panel');
  }

  // Update breadcrumb
  const breadcrumb = document.getElementById('iso-breadcrumb');
  if (breadcrumb) {
    breadcrumb.textContent = `${project} > Unit ${unit} > Zone ${zone}`;
    // Show / remove View Only badge
    const prevBadge = document.getElementById('ro-badge');
    if (prevBadge) prevBadge.remove();
    if (window._readOnlyJob) {
      const badge = document.createElement('span');
      badge.id = 'ro-badge';
      badge.textContent = 'View Only';
      badge.style.cssText = 'margin-left:10px;padding:2px 10px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:12px;font-size:11.5px;color:#64748b;font-weight:600;vertical-align:middle;';
      breadcrumb.insertAdjacentElement('afterend', badge);
    }
    // Add/replace search bar below Upload Isometrics/Reports, aligned right of the breadcrumb
    let existingSearch = document.getElementById('iso-search-bar');
    if (!existingSearch) {
      let searchBar = document.createElement('input');
      searchBar.type = "text";
      searchBar.id = "iso-search-bar";
      searchBar.placeholder = "Search...";
      searchBar.style.cssText = "margin-left:auto; min-width:260px; padding:6px 10px; background-color:#f8f9fa; border-radius:6px; border:1px solid #dee2e6; box-shadow:0 2px 4px rgba(0,0,0,0.1); font-size:12px;"; // Adjust as needed
      breadcrumb.parentNode.appendChild(searchBar);
      searchBar.onkeyup = function () {
        let term = searchBar.value.toLowerCase();
        let tbody = document.querySelector('#iso-list-table tbody');
        let rows = tbody ? tbody.querySelectorAll('tr') : [];
        rows.forEach(row => {
          if (row.classList.contains('no-data')) return;
          row.style.display = [...row.children].some(td => td.textContent.toLowerCase().includes(term)) ? "" : "none";
        });
      };
    }

  }


  // Forward BUTTON, appears for allowed roles only
  // To check role from server, set this global based on logged-in user and unit/project/zone using an API (pseudo):
  // window.ISO_CAN_FORWARD = true/false; window.ISO_CAN_CHECKBOX = true/false;

  // Remove old forward if any
  let prevFwd = document.getElementById('forward-btn');
  if (prevFwd) prevFwd.remove();

  // Check global variable (should be set after user info/roles check from backend)
  if (window.ISO_CAN_FORWARD) {
    let btn = document.createElement('button');
    btn.innerText = "Assign Checkers";
    btn.id = "forward-btn";
    btn.style.cssText = "margin-left:25px; padding:6px 20px; background-color:#007bff; color:white; border:none; border-radius:4px; font-size:14px; cursor:pointer; font-weight:bold;";
    btn.onmouseover = function () { this.style.backgroundColor = '#0056b3'; };
    btn.onmouseout = function () { this.style.backgroundColor = '#007bff'; };

    btn.onclick = async function () {
      const checkboxes = document.querySelectorAll('.iso-multi-select:checked');
      if (checkboxes.length === 0) {
        alert('Please select at least one line to assign checkers.');
        return;
      }
      const selectedRows = Array.from(checkboxes).map(cb => ({
        lineNo: cb.dataset.line,
        row: cb.closest('tr')
      }));
      openGLSGLModal(selectedRows);
    };

    breadcrumb.parentNode.insertBefore(btn, breadcrumb.nextSibling);

    // Assign Lot button (GL/SGL only)
    let prevLot = document.getElementById('assign-lot-btn');
    if (prevLot) prevLot.remove();
    let lotBtn = document.createElement('button');
    lotBtn.id = 'assign-lot-btn';
    lotBtn.innerText = 'Assign Lot';
    lotBtn.style.cssText = 'margin-left:8px;padding:6px 16px;background:#6f42c1;color:white;border:none;border-radius:4px;font-size:14px;cursor:pointer;font-weight:bold;';
    lotBtn.onmouseover = function () { this.style.backgroundColor = '#5a32a3'; };
    lotBtn.onmouseout  = function () { this.style.backgroundColor = '#6f42c1'; };
    lotBtn.onclick = function () {
      const checkboxes = document.querySelectorAll('.iso-multi-select:checked');
      const selectedRows = Array.from(checkboxes).map(cb => ({ lineNo: cb.dataset.line, row: cb.closest('tr') }));
      openAssignLotModal(selectedRows);
    };
    breadcrumb.parentNode.insertBefore(lotBtn, breadcrumb.nextSibling);
  }




  // Load ISOs for this zone, then overlay claim badges
  await loadZoneISOs(project, unit, zone);
  loadAndApplyClaimBadges(project, unit, zone);
}


async function loadZoneISOs(project, unit, zone) {
  // Fetch INCH data map — awaited so values are present when table renders
  _inchUnitMap = {};
  try {
    const r = await fetch(`/api/inch/unit?project=${encodeURIComponent(project)}&unit=${encodeURIComponent(unit)}`);
    const d = await r.json();
    if (d.ok) _inchUnitMap = d.map || {};
  } catch (_) {}

  // Use already-loaded tree data first (avoids extra API round-trip)
  const treeLines = (currentTreeData[project] && currentTreeData[project][unit] &&
                     currentTreeData[project][unit][zone]) ||
                    (otherTreeData[project] && otherTreeData[project][unit] &&
                     otherTreeData[project][unit][zone]) || [];

  // Render immediately from cached tree data so the table appears without waiting.
  // holdSeverity is not in tree data, so the Hold column shows — on first paint.
  if (treeLines.length > 0) {
    const isos = treeLines.map(line => ({
      job_no:           project,
      unit_no:          unit,
      zone:             zone,
      line_no:          line.lineNo,
      rev_no:           line.revNo            || 0,
      critical:         line.stressCritical || 'N',
      status:           line.status || 'Uploaded',
      from:             line.uploadedBy || 'System',
      mainFile:         `uploads/${project}/${unit}/${zone}/${line.storedFile}`,
      drawingId:        line.drawingId        || null,
      issuedLotNumber:  line.issuedLotNumber  || null,
      plannedLotId:     line.plannedLotId     || null,
      plannedLotNumber: line.plannedLotNumber || null,
      tags:             line.tags             || [],
      holdSeverity:     null,
    }));
    renderISOTable(isos);
    // Fall through — always fetch from API so holdSeverity is populated.
  }

  // Always fetch from API to get holdSeverity (and as fallback when tree has no lines).
  try {
    const url = `/api/isos?project=${encodeURIComponent(project)}&unit=${encodeURIComponent(unit)}&zone=${encodeURIComponent(zone)}`;
    const res  = await fetch(url);
    const data = await res.json();
    renderISOTable(data.ok ? data.isos : []);
  } catch (err) {
    console.error('loadZoneISOs error:', err);
    if (treeLines.length === 0) renderISOTable([]);
  }
}

// Re-apply INCH values into the two dedicated cells after async map load
function _applyInchBadges() {
  const fmtNum = v => v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  document.querySelectorAll('#iso-list-table tbody tr.iso-row').forEach(row => {
    const lineNo = row.getAttribute('data-lineNo');
    if (!lineNo) return;
    const diaCell = row.querySelector('.iso-inch-dia');
    const mtrCell = row.querySelector('.iso-inch-mtr');
    if (!diaCell || !mtrCell) return;
    const inch = _inchUnitMap[lineNo] || {};
    const dia  = inch.inchDia   != null ? Number(inch.inchDia)   : null;
    const mtr  = inch.inchMeter != null ? Number(inch.inchMeter) : null;
    diaCell.textContent = fmtNum(dia);
    diaCell.style.color      = dia  != null ? 'var(--text-primary)' : 'var(--text-faint)';
    diaCell.style.fontWeight = dia  != null ? '500' : '';
    mtrCell.textContent = fmtNum(mtr);
    mtrCell.style.color      = mtr  != null ? '#0f766e' : 'var(--text-faint)';
    mtrCell.style.fontWeight = mtr  != null ? '600' : '';
  });
}

function extractRevFromFile(storedFile) {
  const m = (storedFile || '').match(/_R(\d+)-/);
  return m ? parseInt(m[1], 10) : 0;
}


function renderISOTable(isos) {
  const tbody = document.querySelector('#iso-list-table tbody');
  tbody.innerHTML = '';
  if (!tbody) return;


  // Clear existing content
  // Group all ISOs by line_no
  const grouped = {};
  isos.forEach(iso => {
    if (!grouped[iso.line_no]) grouped[iso.line_no] = [];
    grouped[iso.line_no].push(iso);
  });


  const lineNumbers = Object.keys(grouped);
  if (lineNumbers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="16" class="no-data">No files found in this zone</td></tr>';
    return;
  }


  lineNumbers.forEach(lineNo => {
    const isosForLine = grouped[lineNo];
    const rep = isosForLine[isosForLine.length - 1]; // show latest for revision
    const row = document.createElement('tr');
    row.className = 'iso-row';
    row.setAttribute('data-lineNo', lineNo);
    if (rep.issuedLotNumber) row.setAttribute('data-issued', '1');


        // Add Serial Number and (conditionally) checkbox as first cell
    let idx = lineNumbers.indexOf(lineNo) + 1;
    let showCheckbox = window.ISO_CAN_CHECKBOX === true;
    // Checkbox active for all non-issued lines; disabled only for lines already issued in a lot
    let canSelect = !rep.issuedLotNumber;
    let checkboxHtml = '';
    if (showCheckbox && canSelect) {
      checkboxHtml = `<input type="checkbox" class="iso-multi-select" data-line="${rep.line_no}" style="margin-right:4px;vertical-align:middle;"> `;
    } else if (showCheckbox && !canSelect) {
      checkboxHtml = `<input type="checkbox" class="iso-multi-select" data-line="${rep.line_no}" style="margin-right:4px;vertical-align:middle;" disabled> `;
    }
    let snCell = `<td>${checkboxHtml}${idx}</td>`;

    const isIssued = !!rep.issuedLotNumber;
    const statusText = isIssued                                     ? 'Issued'
      : (rep.rev_no > 0 && rep.status === 'Uploaded')              ? `Rev ${rep.rev_no} Open`
      : (rep.status || 'Uploaded');
    const statusStyle = isIssued ? 'color:#007bff;font-weight:600;'
      : statusText.startsWith('Comments Received') ? 'color:#c2410c;font-weight:600;'
      : '';
    const lotCell = isIssued
      ? `<span style="background:rgba(0,123,255,0.12);color:#007bff;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600;">Lot ${rep.issuedLotNumber}</span>`
      : '<span style="color:var(--text-faint);">—</span>';

    // Planned-lot badge — shown on Pipeline Name cell. data-job/unit/lotnumber drive
    // the delegated click handler in left-top.js that opens the lot status modal.
    const lotBadge = rep.plannedLotNumber
      ? `<span class="lot-plan-badge" data-lotnumber="${rep.plannedLotNumber}" data-job="${selectedProject}" data-unit="${selectedUnit}" data-lot="${rep.plannedLotNumber}" title="Planned: Lot ${rep.plannedLotNumber} — click to view status" style="cursor:pointer;">L${rep.plannedLotNumber}</span>`
      : '';

    // INCH data for this line
    const inchRow   = _inchUnitMap[rep.line_no] || {};
    const inchDia   = inchRow.inchDia   != null ? Number(inchRow.inchDia)   : null;
    const inchMeter = inchRow.inchMeter != null ? Number(inchRow.inchMeter) : null;
    const fmtNum    = v => v != null ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';

    // Hold severity badge
    const holdSev = rep.holdSeverity;
    const holdCell = holdSev === 'blocking'
      ? `<span title="Blocking hold — line parked" style="display:inline-block;padding:2px 8px;background:#fef2f2;color:#e53935;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;" onclick="if(window.showLineHoldsModal)showLineHoldsModal(null,'${rep.line_no}','${rep.job_no}','${rep.unit_no}')">Blocking</span>`
      : holdSev === 'minor'
      ? `<span title="Minor hold — workflow continues" style="display:inline-block;padding:2px 8px;background:#fffbeb;color:#f59e0b;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;" onclick="if(window.showLineHoldsModal)showLineHoldsModal(null,'${rep.line_no}','${rep.job_no}','${rep.unit_no}')">Minor</span>`
      : '<span style="color:var(--text-faint);">—</span>';

    row.innerHTML = snCell +
      `<td>${rep.job_no}</td>
      <td>${rep.unit_no}</td>
      <td>${rep.zone}</td>
      <td><span class="line-who-btn" data-job="${rep.job_no}" data-unit="${rep.unit_no}" data-line="${rep.line_no}" title="Click to see who holds this line">${rep.line_no}</span>${lotBadge}${renderTagPills(rep.tags)}</td>
      <td>${rep.rev_no}</td>
      <td>${rep.critical}</td>
      <td style="${statusStyle}">${statusText}</td>
      <td style="text-align:center;">${holdCell}</td>
      <td class="iso-pc-cell" style="font-size:12px;color:var(--text-faint);">—</td>
      <td class="iso-mc-cell" style="font-size:12px;color:var(--text-faint);">—</td>
      <td class="iso-sc-cell" style="font-size:12px;color:var(--text-faint);">—</td>
      <td>${lotCell}</td>
      <td class="iso-inch-dia"  style="text-align:right;font-size:12px;${inchDia   != null ? 'color:var(--text-primary);font-weight:500;' : 'color:var(--text-faint);'}">${fmtNum(inchDia)}</td>
      <td class="iso-inch-mtr"  style="text-align:right;font-size:12px;${inchMeter != null ? 'color:#0f766e;font-weight:600;'          : 'color:var(--text-faint);'}">${fmtNum(inchMeter)}</td>
      <td style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${rep.from || ''}">${rep.from || '—'}</td>`;



    // Attach both right-click and double-click below:
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showContextMenu(e, { ...rep, allVersions: isosForLine });
    });
    row.addEventListener('dblclick', function () {
      viewComments({ ...rep, allVersions: isosForLine });
    });


    tbody.appendChild(row);
  });



  // Update table headers to reflect removed columns
  updateTableHeaders();
  setupIsoTableFilters(isos);

}


function updateTableHeaders() {
  const thead = document.querySelector('#iso-list-table thead');
  if (!thead) return;

  thead.innerHTML = '';
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = `
    <th>#</th>
    <th>Job No.</th>
    <th>Unit</th>
    <th>Zone</th>
    <th>Pipeline Name</th>
    <th>Rev.</th>
    <th>Crit.</th>
    <th>Status</th>
    <th>Hold</th>
    <th>PC</th>
    <th>MC</th>
    <th>SC</th>
    <th>Lot</th>
    <th>Inch Dia</th>
    <th>Inch Mtr</th>
    <th>Uploaded By</th>
  `;
  thead.appendChild(headerRow);

  // Add resize handles after a tick so offsetWidths are available
  setTimeout(() => addColumnResizers(document.querySelector('#iso-list-table')), 0);
}

function addColumnResizers(table) {
  if (!table) return;
  const ths = Array.from(table.querySelectorAll('thead th'));

  ths.forEach((th) => {
    // Remove any existing handle to avoid duplicates on re-render
    th.querySelector('.col-resizer')?.remove();

    const handle = document.createElement('div');
    handle.className = 'col-resizer';
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Lock all column widths in px so table-layout:fixed works
      if (table.style.tableLayout !== 'fixed') {
        ths.forEach(t => { t.style.width = t.offsetWidth + 'px'; });
        table.style.width     = table.offsetWidth + 'px';
        table.style.minWidth  = 'unset';
        table.style.tableLayout = 'fixed';
      }

      const startX          = e.pageX;
      const startWidth      = th.offsetWidth;
      const startTableWidth = table.offsetWidth;
      handle.classList.add('active');

      const onMove = (e) => {
        const newColWidth = Math.max(40, startWidth + (e.pageX - startX));
        const diff        = newColWidth - startWidth;
        th.style.width    = newColWidth + 'px';
        // Grow or shrink the total table width by the same delta
        table.style.width = Math.max(200, startTableWidth + diff) + 'px';
      };

      const onUp = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}




function filterIsoTable() {
  const table = document.querySelector('#iso-list-table');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  tbody.querySelectorAll('tr').forEach(row => {
    if (row.classList.contains('no-data')) { row.style.display = ''; return; }
    let show = true;

    Object.entries(_isoActiveFilters).forEach(([colIdxStr, val]) => {
      if (!val || !show) return;
      const colIdx = parseInt(colIdxStr);
      if (colIdx >= 8 && colIdx <= 10) {
        // PC / MC / SC — compare against claims map
        const role = ['PC', 'MC', 'SC'][colIdx - 8];
        const lineNo = row.getAttribute('data-lineNo');
        const state = (_zoneClaimsMap[lineNo] || {})[role];
        if (val === 'pool' && state) show = false;
        else if (val !== 'pool' && state !== val) show = false;
      } else if (colIdx === 4) {
        // Document No. cell may contain a lot-badge span — use data attribute
        if (row.getAttribute('data-lineNo') !== val) show = false;
      } else if (colIdx === 7) {
        // Status — 'Comments Received' matches any 'Comments Received from ...' variant
        const cell = row.children[7];
        if (!cell) return;
        const cellText = cell.textContent.trim();
        if (val === 'Comments Received') {
          if (!cellText.startsWith('Comments Received')) show = false;
        } else {
          if (cellText !== val) show = false;
        }
      } else {
        const cell = row.children[colIdx];
        if (cell && cell.textContent.trim() !== val) show = false;
      }
    });

    row.style.display = show ? '' : 'none';
  });
}

function setupIsoTableFilters(isos) {
  const thead = document.querySelector('#iso-list-table thead');
  if (!thead) return;
  const headerRow = thead.querySelector('tr');
  if (!headerRow) return;

  headerRow.querySelectorAll('.col-filter-btn').forEach(b => b.remove());
  document.querySelectorAll('.col-filter-panel[data-iso-filter]').forEach(p => p.remove());
  _isoActiveFilters = {};

  const filterDefs = [
    { idx: 4,  dynField: iso => iso.line_no || '' },
    { idx: 5,  dynField: iso => iso.rev_no != null ? String(iso.rev_no) : '' },
    { idx: 6,  dynField: iso => iso.critical || iso.stress_critical || '' },
    { idx: 7,  dynField: iso => iso.issuedLotNumber ? 'Issued' : (iso.status || 'Uploaded') },
    { idx: 8,  staticVals: [{ label: 'In Review', value: 'active' }, { label: 'No Comments', value: 'no-comments' }, { label: 'In Pool', value: 'pool' }] },
    { idx: 9,  staticVals: [{ label: 'In Review', value: 'active' }, { label: 'No Comments', value: 'no-comments' }, { label: 'In Pool', value: 'pool' }] },
    { idx: 10, staticVals: [{ label: 'In Review', value: 'active' }, { label: 'No Comments', value: 'no-comments' }, { label: 'In Pool', value: 'pool' }] },
    { idx: 11, dynField: iso => iso.issuedLotNumber ? `Lot ${iso.issuedLotNumber}` : '—' },
  ];

  filterDefs.forEach(({ idx, staticVals, dynField }) => {
    const th = headerRow.children[idx];
    if (!th) return;

    const opts = staticVals || Array.from(new Set(isos.map(dynField).filter(Boolean))).sort().map(v => ({ label: v, value: v }));

    const btn = document.createElement('button');
    btn.className = 'col-filter-btn';
    btn.dataset.filterCol = idx;
    btn.title = 'Filter';
    btn.innerHTML = `<svg viewBox="0 0 10 9" fill="currentColor"><path d="M0 0h10L6.5 4.5V9l-3-1.5V4.5z"/></svg>`;
    th.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'col-filter-panel';
    panel.dataset.isoFilter = '1';
    panel.dataset.filterCol = idx;
    panel.style.display = 'none';

    [{ label: 'All', value: '' }, ...opts].forEach(({ label, value }) => {
      const opt = document.createElement('div');
      opt.className = 'col-filter-option' + (value === '' ? ' selected' : '');
      opt.dataset.value = value;
      opt.textContent = label;
      panel.appendChild(opt);
    });
    document.body.appendChild(panel);

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = panel.style.display !== 'none';
      closeAllFilterPanels();
      if (!isOpen) {
        const rect = btn.getBoundingClientRect();
        panel.style.top  = (rect.bottom + 2) + 'px';
        panel.style.left = rect.left + 'px';
        panel.style.display = 'block';
        btn.classList.add('open');
      }
    });

    panel.addEventListener('click', e => {
      const opt = e.target.closest('.col-filter-option');
      if (!opt) return;
      const val = opt.dataset.value;
      _isoActiveFilters[idx] = val;
      panel.querySelectorAll('.col-filter-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      btn.classList.toggle('active', val !== '');
      closeAllFilterPanels();
      filterIsoTable();
    });
  });

  if (!window._isoFilterCloseListenerAdded) {
    document.addEventListener('click', closeAllFilterPanels);
    window._isoFilterCloseListenerAdded = true;
  }
}




async function loadAndApplyClaimBadges(project, unit, zone) {
  try {
    const res = await fetch(
      `/api/zone-claims?project=${encodeURIComponent(project)}&unit=${encodeURIComponent(unit)}&zone=${encodeURIComponent(zone)}`
    );
    const data = await res.json();
    if (!data.ok) return;
    _zoneClaimsMap = data.claims || {};
    injectClaimBadges();
  } catch (e) {
    console.error('zone-claims error:', e);
  }
}

function injectClaimBadges() {
  const tbody = document.querySelector('#iso-list-table tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr.iso-row').forEach(row => {
    const lineNo     = row.getAttribute('data-lineNo');
    const isIssued   = row.getAttribute('data-issued') === '1';
    const roleStates = _zoneClaimsMap[lineNo] || {};

    ['PC', 'MC', 'SC'].forEach(role => {
      const cell = row.querySelector(`.iso-${role.toLowerCase()}-cell`);
      if (!cell) return;
      const state = roleStates[role];
      if (state === 'active')
        cell.innerHTML = `<span title="Under review" style="color:#2563eb;font-size:14px;font-weight:700;">✓</span>`;
      else if (state === 'no-comments')
        cell.innerHTML = `<span title="Checked — no comments" style="color:#16a34a;font-size:14px;font-weight:700;">✓</span>`;
      else if (state === 'done')
        cell.innerHTML = `<span title="Checked — with comments" style="color:#15803d;font-size:14px;font-weight:900;">✓</span>`;
      else if (isIssued)
        cell.innerHTML = `<span title="Issued" style="color:var(--text-faint);font-size:12px;">—</span>`;
      else
        cell.innerHTML = `<span title="In pool" style="color:var(--text-faint);font-size:11px;font-weight:600;">P</span>`;
    });
  });
}

function setupContextMenu() {
  const contextMenu = document.getElementById('iso-context');
  if (!contextMenu) return;


  // Hide context menu when clicking elsewhere
  document.addEventListener('click', function () {
    contextMenu.style.display = 'none';
  });


  // Handle context menu actions
  contextMenu.addEventListener('click', function (e) {
    const action = e.target.closest('[data-action]')?.getAttribute('data-action');
    const iso = contextMenu.currentISO;


    if (!action || !iso) return;

    switch (action) {
      case 'workflow-details':
        viewIsoWorkflowDetails(iso);
        break;
      case 'export':
        exportISO(iso);
        break;
      case 'comments':
        viewComments(iso);
        break;
      case 'remove-from-lot':
        removeLineFromLotPlan(iso);
        break;
      case 'tag-line':
        openTagModal(iso);
        break;
      case 'view-holds':
        if (window.showLineHoldsModal)
          showLineHoldsModal(null, iso.line_no, iso.job_no, iso.unit_no);
        break;
      case 'revision-history':
        viewIsoRevisionHistory(iso);
        break;
    }

    contextMenu.style.display = 'none';
  });
}


function showContextMenu(event, iso) {
  const contextMenu = document.getElementById('iso-context');
  if (!contextMenu) return;

  contextMenu.currentISO = iso;

  // Show/hide Remove from Lot Plan only when a planned lot exists on this line
  const removeItem = document.getElementById('ctx-remove-from-lot');
  if (removeItem) removeItem.style.display = iso.plannedLotNumber ? '' : 'none';

  contextMenu.style.left = event.pageX + 'px';
  contextMenu.style.top  = event.pageY + 'px';
  contextMenu.style.display = 'block';

  event.stopPropagation();
}


function exportISO(iso) {
  if (iso.mainFile) {
    // Create a download link
    const link = document.createElement('a');
    link.href = `/${iso.mainFile}`;
    link.download = iso.line_no + '.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } else {
    alert('File not found');
  }
}


// Replace existing viewComments and renderCommentsTable with these:

async function viewComments(iso) {
  console.log('viewComments called with (legacy iso):', iso);

  // Hide ISO surface, show comments surface
  const isoSurface = document.querySelector('.iso-surface');
  const commentsSurface = document.getElementById('comments-surface');

  if (isoSurface) isoSurface.style.display = 'none';
  if (commentsSurface) commentsSurface.style.display = 'block';

  // Update breadcrumb
  const breadcrumb = document.getElementById('comments-breadcrumb');
  if (breadcrumb) {
    breadcrumb.textContent = `Comments: ${iso.line_no || iso.lineNo || iso.lineNo || iso.line_no}`;
  }

  // Resolve jobNo (project) and lineNo for API call.
  const jobNo = iso.job_no || iso.jobNo || selectedProject;
  const lineNo = iso.line_no || iso.lineNo || iso.lineNo;

  if (!jobNo || !lineNo) {
    console.warn('viewComments: missing jobNo or lineNo, falling back to local versions');
    // Fallback to previous behavior if insufficient info
    let allUploads = [];
    if (iso.allVersions) {
      allUploads = iso.allVersions;
    } else {
      const res = await fetch(
        `/api/isos?project=${selectedProject}&unit=${selectedUnit}&zone=${selectedZone}`
      );
      const data = await res.json();
      if (data.ok) {
        allUploads = data.isos.filter(x => x.line_no === iso.line_no);
      }
    }
    renderCommentsTableFromISOs(allUploads);
    return;
  }

  try {
    // Use server-side task-history endpoint to get base + comment files (latest first)
    const resp = await fetch(`/api/task-history?lineNo=${encodeURIComponent(lineNo)}&jobNo=${encodeURIComponent(jobNo)}`);
    const json = await resp.json();
    if (json.ok && Array.isArray(json.history)) {
      // server already sorts latest first; but defensively sort by uploadedOn if present
      const history = json.history.slice().sort((a, b) => {
        const ta = a.uploadedOn ? new Date(a.uploadedOn).getTime() : 0;
        const tb = b.uploadedOn ? new Date(b.uploadedOn).getTime() : 0;
        return tb - ta;
      });
      renderCommentsTable(history);
    } else {
      console.warn('task-history returned no history, rendering empty table', json);
      renderCommentsTable([]);
    }
  } catch (err) {
    console.error('Error loading task history:', err);
    renderCommentsTable([]);
  }
}


async function loadCommentsData(iso) {
  try {
    // For now, show placeholder data
    // In a real implementation, you would fetch comments from the server
    const commentsData = [
      {
        revision: iso.rev_no,
        final: 'No',
        streamCounters: 'PC: 0, MC: 0, SC: 0',
        files: iso.mainFile ? `<a href="/${iso.mainFile}" target="_blank">${iso.line_no}.pdf</a>` : 'No file'
      }
    ];


    renderCommentsTable(commentsData);


  } catch (error) {
    console.error('Error loading comments:', error);
    renderCommentsTable([]);
  }
}



// New renderCommentsTable expecting history entries from /api/task-history
function renderCommentsTable(history) {
  const tbody = document.querySelector('#comments-table tbody');
  if (!tbody) {
    console.error('Could not find tbody for comments table.');
    return;
  }
  tbody.innerHTML = '';

  if (!history || history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6">No uploads available</td></tr>';
    return;
  }

  history.forEach((entry) => {
    // Expected fields from server.task-history: fileName, revNo, commentType, commentFrom, uploadedBy, uploadedOn, filePath, fileType
    const fileName = entry.fileName || (entry.filePath && entry.filePath.split('/').pop()) || 'Unknown.pdf';
    const revNo = entry.revNo || '';
    const commentType = entry.commentType || entry.commentType || (entry.fileType === 'base' ? 'Base Upload' : 'Comment');
    const commentFrom = entry.commentFrom || entry.role || '';
    const uploadedBy = entry.uploadedBy || entry.uploadedBy || entry.from || '';
    const uploadedOn = entry.uploadedOn ? new Date(entry.uploadedOn).toLocaleString() : '';
    const filePath = entry.filePath || entry.filePath || (`/uploads/${selectedProject || ''}/${selectedUnit || ''}/${selectedZone || ''}/${fileName}`);

    // Link safe: use filePath if it begins with '/' or 'uploads'
    const href = filePath.startsWith('/') ? filePath : (filePath.startsWith('uploads') ? ('/' + filePath) : filePath);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="${href}" target="_blank" rel="noopener noreferrer">${fileName}</a></td>
      <td>${revNo}</td>
      <td>${commentType}</td>
      <td>${commentFrom || '-'}</td>
      <td>${uploadedBy || '-'}</td>
      <td>${uploadedOn || '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}


// Backwards-compatible helper used only in fallback path above
function renderCommentsTableFromISOs(isos) {
  // Convert your iso objects into a minimal history-like array and reuse renderCommentsTable
  const history = (isos || []).map((up) => {
    const fullFilePath = up.storedFile || up.originalFile || up.mainFile || '';
    const fileName = fullFilePath.split(/[\\/]/).pop() || (up.originalFile || up.mainFile || 'unknown.pdf');
    return {
      fileName,
      revNo: up.rev_no ? `R${up.rev_no}` : '',
      commentType: 'Upload',
      commentFrom: up.from || up.uploadedBy || '',
      uploadedBy: up.from || up.uploadedBy || '',
      uploadedOn: up.uploaded_on || up.uploadedOn || '',
      filePath: up.mainFile || `/uploads/${up.job_no || ''}/${up.unit_no || ''}/${up.zone || ''}/${fileName}`
    };
  });

  // latest first by uploadedOn
  history.sort((a, b) => (new Date(b.uploadedOn || 0).getTime() - new Date(a.uploadedOn || 0).getTime()));
  renderCommentsTable(history);
}







function hideWelcomeAndTables() {
  // Hide ALL view panels (welcome, tasks, notifications, etc.)
  document.querySelectorAll('.view-panel').forEach(p => {
    p.classList.remove('active-panel');
    p.style.display = 'none';
  });

  // Final Isometrics and Lot Detail aren't tagged .view-panel, so the loop
  // above misses them — loadFinalIsometrics()/openLotDetail() in user.html
  // already special-case hide each other for this reason; do the same here
  // so switching to a Zone from either view actually hides it instead of
  // just rendering the zone table above it.
  const finalIso = document.getElementById('final-isometrics-table-container');
  if (finalIso) finalIso.style.display = 'none';
  const lotDetail = document.getElementById('lot-detail-panel');
  if (lotDetail) lotDetail.style.display = 'none';
}

// ===== GL/SGL MODAL =====
function _dead_openModellerModal(selectedRows) {
  const modal = document.createElement('div');
  modal.id = 'modeller-forward-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 8px;
    width: 90%;
    max-width: 600px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  `;

  let selectedLinesHTML = selectedRows.map(item => `
    <div style="padding: 8px; background-color: #f0f0f0; margin: 5px 0; border-radius: 4px;">
      <strong>${item.lineNo}</strong> - Status: ${item.status}
    </div>
  `).join('');

  content.innerHTML = `
    <h2 style="margin-top: 0; color: #333;">Mark Lines as Good for Engineering</h2>
    <p style="color: #666;">These lines will be forwarded for review. You can tell the checker that this line is ready to be checked.</p>
    
    <div style="background-color: #e8f4f8; padding: 15px; border-radius: 4px; margin: 20px 0;">
      <strong>Selected Lines (${selectedRows.length}):</strong>
      ${selectedLinesHTML}
    </div>

    <div style="display: flex; gap: 10px; margin-top: 30px;">
      <button id="modeller-cancel-btn" style="flex: 1; padding: 10px; background-color: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
        Cancel
      </button>
      <button id="modeller-submit-btn" style="flex: 1; padding: 10px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold;">
        Forward for Review
      </button>
    </div>
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  // Handle Cancel
  document.getElementById('modeller-cancel-btn').onclick = function () {
    modal.remove();
  };

  // Handle Submit
  document.getElementById('modeller-submit-btn').onclick = async function () {
    try {
      const linesToForward = selectedRows.map(row => ({
        lineNo: row.lineNo,
        project: selectedProject,
        unit: selectedUnit,
        zone: selectedZone
      }));

      // Call backend API to mark lines as "For Review"
      const response = await fetch('/api/forward-iso-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: linesToForward,
          forwardedBy: 'Modeller',
          uploadType: 'For Review'
        })
      });

      const result = await response.json();

      if (result.ok) {
        alert(`Successfully forwarded ${selectedRows.length} line(s) for review!`);
        modal.remove();

        // Uncheck the forwarded lines
        selectedRows.forEach(row => {
          const checkbox = row.row.querySelector('.iso-multi-select');
          if (checkbox) checkbox.checked = false;
        });
      } else {
        alert('Error: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error forwarding lines:', error);
      alert('Error forwarding lines');
    }
  };
}

// ===== GL/SGL MODAL =====
async function fetchCheckerEngineers(role) {
  try {
    const res = await fetch(`/api/process-checkers?project=${encodeURIComponent(selectedProject)}&unit=${encodeURIComponent(selectedUnit)}&role=${role}`);
    const data = await res.json();
    return data.checkers || [];
  } catch (e) { return []; }
}

async function openGLSGLModal(selectedRows) {
  document.getElementById('glsgl-forward-modal')?.remove();

  // Fetch engineers for all roles in parallel
  const [pcEng, mcEng, scEng] = await Promise.all([
    fetchCheckerEngineers('PC'),
    fetchCheckerEngineers('MC'),
    fetchCheckerEngineers('SC'),
  ]);

  // Current assignments table from _zoneClaimsMap
  const stateIcon = s => !s
    ? `<span style="color:#94a3b8;font-size:11px;">P</span>`
    : s === 'active'
      ? `<span style="color:#2563eb;font-weight:700;font-size:13px;">✓</span>`
      : `<span style="color:#16a34a;font-weight:700;font-size:13px;">✓</span>`;

  const currentRows = selectedRows.map(r => {
    const ln = r.row ? r.row.getAttribute('data-lineNo') : r.lineNo;
    const s = _zoneClaimsMap[ln] || {};
    return `<tr>
      <td style="padding:4px 8px;font-size:12px;font-weight:500;color:#0f172a;">${ln}</td>
      <td style="padding:4px 8px;text-align:center;">${stateIcon(s.PC)}</td>
      <td style="padding:4px 8px;text-align:center;">${stateIcon(s.MC)}</td>
      <td style="padding:4px 8px;text-align:center;">${stateIcon(s.SC)}</td>
    </tr>`;
  }).join('');

  // Radio group builder: Pool + optional "Not required" + specific engineers
  function buildRadios(role, engineers, withSkip) {
    const name = `fwd-${role.toLowerCase()}-assign`;
    const labelStyle = 'display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;font-size:13px;';
    let html = `<label style="${labelStyle}">
      <input type="radio" name="${name}" value="pool" checked style="width:13px;height:13px;">
      <span style="color:#334155;">Pool <span style="color:#94a3b8;font-size:11px;">(anyone can claim)</span></span>
    </label>`;
    if (withSkip) html += `<label style="${labelStyle}">
      <input type="radio" name="${name}" value="skip" style="width:13px;height:13px;">
      <span style="color:#94a3b8;">Not required</span>
    </label>`;
    engineers.forEach(e => {
      html += `<label style="${labelStyle}">
        <input type="radio" name="${name}" value="${e.id}" style="width:13px;height:13px;">
        <span style="color:#0f172a;">${e.name}</span>
      </label>`;
    });
    return html;
  }

  const blockStyle = 'margin-bottom:14px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:8px;';
  const blockTitle = (label, code) =>
    `<div style="font-weight:700;color:#0f172a;font-size:13px;margin-bottom:10px;">
       ${label} <span style="font-weight:400;color:#94a3b8;font-size:11px;">(${code})</span>
     </div>`;

  const modal = document.createElement('div');
  modal.id = 'glsgl-forward-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:10000;';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:92%;max-width:580px;max-height:88vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.18);font-family:inherit;">

      <div style="padding:20px 24px 14px;border-bottom:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Assign Checkers</div>
        <div style="font-size:16px;font-weight:700;color:#0f172a;">${selectedRows.length} line(s) selected</div>
      </div>

      <div style="padding:14px 24px;background:#f8fafc;border-bottom:1px solid #f1f5f9;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Current Assignments</div>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">
            <th style="text-align:left;padding:3px 8px;">Line</th>
            <th style="text-align:center;padding:3px 8px;">PC</th>
            <th style="text-align:center;padding:3px 8px;">MC</th>
            <th style="text-align:center;padding:3px 8px;">SC</th>
          </tr></thead>
          <tbody>${currentRows}</tbody>
        </table>
        <div style="margin-top:10px;display:flex;align-items:center;gap:6px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;color:#92400e;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          All existing checker assignments for selected lines will be cleared and replaced.
        </div>
      </div>

      <div style="padding:16px 24px;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px;">New Assignment</div>
        <div style="${blockStyle}">${blockTitle('Process Checker','PC')}<div id="pc-radio-group">${buildRadios('PC', pcEng, false)}</div></div>
        <div style="${blockStyle}">${blockTitle('Material Checker','MC')}<div id="mc-radio-group">${buildRadios('MC', mcEng, false)}</div></div>
        <div style="${blockStyle}margin-bottom:0;">${blockTitle('Stress Checker','SC')}<div id="sc-radio-group">${buildRadios('SC', scEng, true)}</div></div>
      </div>

      <div style="padding:16px 24px;border-top:1px solid #f1f5f9;display:flex;gap:10px;">
        <button id="glsgl-cancel-btn" style="flex:1;padding:10px;background:#f1f5f9;color:#334155;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Cancel</button>
        <button id="glsgl-submit-btn" style="flex:2;padding:10px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;">Assign Checkers</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('glsgl-cancel-btn').onclick = () => modal.remove();

  document.getElementById('glsgl-submit-btn').onclick = async function () {
    const getRadio = name => (modal.querySelector(`input[name="${name}"]:checked`) || {}).value || 'pool';
    const pcVal = getRadio('fwd-pc-assign');
    const mcVal = getRadio('fwd-mc-assign');
    const scVal = getRadio('fwd-sc-assign');

    const assignments = [];
    [['PC', pcVal], ['MC', mcVal], ['SC', scVal]].forEach(([role, val]) => {
      if (val === 'skip') return;
      if (val === 'pool') assignments.push({ type: 'pool',     roles: [role] });
      else                assignments.push({ type: 'specific', roles: [role], userId: val });
    });

    if (!assignments.length) {
      alert('Please assign at least one checker role.');
      return;
    }

    const lines = selectedRows.map(r => ({
      lineNo: r.lineNo, project: selectedProject, unit: selectedUnit, zone: selectedZone
    }));

    const btn = document.getElementById('glsgl-submit-btn');
    btn.disabled = true; btn.textContent = 'Assigning…';

    try {
      const res = await fetch('/api/forward-iso-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines, assignments })
      });
      const result = await res.json();
      if (result.ok) {
        modal.remove();
        await refreshZoneData();
        selectedRows.forEach(r => { const cb = r.row?.querySelector('.iso-multi-select'); if (cb) cb.checked = false; });
        if (result.skippedLines && result.skippedLines.length) {
          alert('Some lines were skipped because they are already issued in a lot:\n\n' +
            result.skippedLines.map(s => `${s.lineNo} — ${s.reason}`).join('\n'));
        }
      } else {
        alert('Error: ' + (result.error || 'Unknown error'));
        btn.disabled = false; btn.textContent = 'Assign Checkers';
      }
    } catch (e) {
      alert('Network error. Please try again.');
      btn.disabled = false; btn.textContent = 'Assign Checkers';
    }
  };
}

async function loadRoleCheckers(role) {
  const selectId = { PC: 'fwd-pc-select', MC: 'fwd-mc-select', SC: 'fwd-sc-select' }[role];
  const sel = document.getElementById(selectId);
  if (!sel) return;
  try {
    const res = await fetch(`/api/process-checkers?project=${encodeURIComponent(selectedProject)}&unit=${encodeURIComponent(selectedUnit)}&role=${role}`);
    const data = await res.json();
    (data.checkers || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error(`loadRoleCheckers(${role}) error:`, e);
  }
}


// ===== LOT ASSIGNMENT MODAL =====
async function openAssignLotModal(selectedRows) {
  // Fetch existing planned lots for this project/unit
  let plannedLots = [];
  try {
    const res = await fetch(`/api/lots/planned?project=${encodeURIComponent(selectedProject)}&unit=${encodeURIComponent(selectedUnit)}`);
    const data = await res.json();
    if (data.ok) plannedLots = data.lots;
  } catch (e) {
    console.error('getPlannedLots error:', e);
  }

  const linesHTML = selectedRows.length
    ? selectedRows.map(r => `<span style="display:inline-block;padding:2px 8px;background:#ede9fe;border-radius:4px;font-size:12px;margin:2px;color:#6f42c1;">${r.lineNo}</span>`).join('')
    : '<span style="color:#94a3b8;font-size:12px;">(no lines selected)</span>';

  const existingLotsHTML = plannedLots.map(l =>
    `<div class="lot-plan-row" data-lot-id="${l.id}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;cursor:pointer;"
          onmouseover="this.style.background='#f5f3ff'" onmouseout="this.style.background=''">
       <div>
         <span style="font-weight:600;color:#6f42c1;font-size:13px;">Lot ${l.lotNumber}</span>
         <span style="color:#94a3b8;font-size:11px;margin-left:8px;">${l.lineCount} line(s) planned</span>
       </div>
       <div style="display:flex;gap:6px;">
         <button class="lot-add-btn" data-lot-id="${l.id}" data-lot-num="${l.lotNumber}" style="padding:4px 10px;background:#6f42c1;color:white;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Add Lines</button>
         <button class="lot-issue-btn" data-lot-id="${l.id}" data-lot-num="${l.lotNumber}" style="padding:4px 10px;background:#198754;color:white;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Issue</button>
       </div>
     </div>`
  ).join('');

  const modal = document.createElement('div');
  modal.id = 'assign-lot-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.45);display:flex;justify-content:center;align-items:center;z-index:10000;';

  modal.innerHTML = `
    <div style="background:white;padding:28px;border-radius:10px;width:90%;max-width:520px;box-shadow:0 8px 32px rgba(0,0,0,0.18);max-height:85vh;overflow-y:auto;">
      <h3 style="margin:0 0 6px;color:#1e293b;font-size:16px;">Assign to Lot</h3>
      <p style="margin:0 0 14px;color:#64748b;font-size:13px;">Tag selected lines for an upcoming lot. The lot number appears as a badge on the line — it won't show in the LOT column until the lot is issued.</p>

      ${selectedRows.length ? `<div style="background:#f5f3ff;border:1px solid #ede9fe;border-radius:6px;padding:10px 12px;margin-bottom:18px;font-size:12px;color:#4c1d95;">
        <strong>${selectedRows.length} line(s) selected:</strong><br><div style="margin-top:6px;">${linesHTML}</div>
      </div>` : ''}

      ${plannedLots.length ? `<div style="margin-bottom:18px;">
        <div style="font-weight:600;font-size:13px;color:#334155;margin-bottom:8px;">Existing Planned Lots</div>
        ${existingLotsHTML}
      </div>` : ''}

      <div style="border-top:1px solid #f1f5f9;padding-top:14px;">
        <div style="font-weight:600;font-size:13px;color:#334155;margin-bottom:8px;">Create New Lot</div>
        ${selectedRows.length
          ? `<p style="font-size:12px;color:#64748b;margin:0 0 12px;">A new lot will be created and the selected lines will be tagged to it.</p>`
          : `<p style="font-size:12px;color:#94a3b8;margin:0 0 12px;">Select lines using checkboxes first, then create a new lot.</p>`}
        <button id="lot-create-btn" style="padding:8px 20px;background:${selectedRows.length ? '#6f42c1' : '#cbd5e1'};color:white;border:none;border-radius:4px;font-size:13px;cursor:${selectedRows.length ? 'pointer' : 'not-allowed'};font-weight:600;" ${selectedRows.length ? '' : 'disabled'}>
          + Create New Lot &amp; Assign
        </button>
      </div>

      <div style="margin-top:20px;text-align:right;">
        <button id="lot-modal-close" style="padding:8px 18px;background:#6c757d;color:white;border:none;border-radius:4px;font-size:13px;cursor:pointer;">Close</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById('lot-modal-close').onclick = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Create new lot
  const createBtn = document.getElementById('lot-create-btn');
  if (createBtn && selectedRows.length) {
    createBtn.onclick = async function () {
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/lots/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobNo: selectedProject, unitNo: selectedUnit, lineNos: selectedRows.map(r => r.lineNo) })
        });
        const data = await res.json();
        if (data.ok) {
          modal.remove();
          await refreshZoneData();
          alert(`Lot ${data.lotNumber} created and ${selectedRows.length} line(s) tagged.`);
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
          createBtn.disabled = false;
          createBtn.textContent = '+ Create New Lot & Assign';
        }
      } catch (e) {
        alert('Error creating lot');
        createBtn.disabled = false;
        createBtn.textContent = '+ Create New Lot & Assign';
      }
    };
  }

  // Add lines to existing lot
  modal.querySelectorAll('.lot-add-btn').forEach(btn => {
    btn.onclick = async function () {
      const lotId   = this.dataset.lotId;
      const lotNum  = this.dataset.lotNum;
      if (!selectedRows.length) { alert('Select lines using checkboxes first.'); return; }
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetch(`/api/lots/${lotId}/lines`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobNo: selectedProject, unitNo: selectedUnit, lineNos: selectedRows.map(r => r.lineNo) })
        });
        const data = await res.json();
        if (data.ok) {
          modal.remove();
          await refreshZoneData();
          alert(`${selectedRows.length} line(s) added to Lot ${lotNum}.`);
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = 'Add Lines';
        }
      } catch (e) {
        alert('Error assigning lines');
        btn.disabled = false;
        btn.textContent = 'Add Lines';
      }
    };
  });

  // Issue an existing planned lot
  modal.querySelectorAll('.lot-issue-btn').forEach(btn => {
    btn.onclick = async function () {
      const lotId  = this.dataset.lotId;
      const lotNum = this.dataset.lotNum;
      if (!confirm(`Issue Lot ${lotNum}? The lot number will appear in the LOT column for all its planned lines.`)) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        // Fetch lines for this lot to let GL choose carry-forward
        const linesRes = await fetch(`/api/lots/${lotId}/lines`);
        const linesData = await linesRes.json();
        if (!linesData.ok) throw new Error(linesData.error);
        modal.remove();
        openIssueLotModal(lotId, lotNum, linesData.lines);
      } catch (e) {
        alert('Error loading lot lines');
        btn.disabled = false;
        btn.textContent = 'Issue';
      }
    };
  });
}


// ===== ISSUE LOT MODAL =====
function openIssueLotModal(lotId, lotNum, lines) {
  const modal = document.createElement('div');
  modal.id = 'issue-lot-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.45);display:flex;justify-content:center;align-items:center;z-index:10000;';

  const linesHTML = lines.map(l =>
    `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
       <input type="checkbox" class="issue-line-cb" data-drawing-id="${l.drawingId}" checked style="width:14px;height:14px;">
       <span style="font-size:13px;">${l.lineNo}</span>
       <span style="font-size:11px;color:#94a3b8;margin-left:auto;">${l.zone}</span>
     </label>`
  ).join('');

  modal.innerHTML = `
    <div style="background:white;padding:28px;border-radius:10px;width:90%;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.18);max-height:85vh;overflow-y:auto;">
      <h3 style="margin:0 0 6px;color:#1e293b;font-size:16px;">Issue Lot ${lotNum}</h3>
      <p style="margin:0 0 14px;color:#64748b;font-size:13px;">Select lines to include in this issue. Unchecked lines will automatically carry forward to the next planned lot.</p>
      <div style="border:1px solid #e2e8f0;border-radius:6px;padding:8px;max-height:260px;overflow-y:auto;margin-bottom:18px;">
        <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #f1f5f9;cursor:pointer;">
          <input type="checkbox" id="issue-select-all" checked style="width:14px;height:14px;">
          <span style="font-size:12px;font-weight:600;color:#334155;">Select / Deselect All</span>
        </label>
        ${linesHTML}
      </div>
      <div style="display:flex;gap:10px;">
        <button id="issue-cancel-btn" style="flex:1;padding:10px;background:#6c757d;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Cancel</button>
        <button id="issue-submit-btn" style="flex:1;padding:10px;background:#198754;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;">Issue Lot ${lotNum}</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById('issue-cancel-btn').onclick = () => modal.remove();

  document.getElementById('issue-select-all').onchange = function () {
    modal.querySelectorAll('.issue-line-cb').forEach(cb => cb.checked = this.checked);
  };

  document.getElementById('issue-submit-btn').onclick = async function () {
    const allCbs = modal.querySelectorAll('.issue-line-cb');
    const includedIds = Array.from(allCbs).filter(cb => cb.checked).map(cb => parseInt(cb.dataset.drawingId));
    const allIds = Array.from(allCbs).map(cb => parseInt(cb.dataset.drawingId));
    const excludeLineIds = allIds.filter(id => !includedIds.includes(id));

    this.disabled = true;
    this.textContent = 'Issuing…';
    try {
      const res = await fetch(`/api/lots/${lotId}/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excludeLineIds })
      });
      const data = await res.json();
      if (data.ok) {
        modal.remove();
        await refreshZoneData();
        if (typeof reloadLotsTree === 'function') reloadLotsTree();
        const carryMsg = excludeLineIds.length ? ` ${excludeLineIds.length} line(s) carried forward to next lot.` : '';
        alert(`Lot ${lotNum} issued.${carryMsg}`);
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
        this.disabled = false;
        this.textContent = `Issue Lot ${lotNum}`;
      }
    } catch (e) {
      alert('Error issuing lot');
      this.disabled = false;
      this.textContent = `Issue Lot ${lotNum}`;
    }
  };
}


// Remove a line from its planned lot (right-click action)
async function removeLineFromLotPlan(iso) {
  if (!iso.plannedLotNumber || !iso.plannedLotId || !iso.drawingId) return;
  if (!confirm(`Remove "${iso.line_no}" from Lot ${iso.plannedLotNumber} planning?`)) return;
  try {
    const res = await fetch(`/api/lots/${iso.plannedLotId}/lines/${iso.drawingId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      await refreshZoneData();
      if (typeof reloadLotsTree === 'function') reloadLotsTree();
    } else {
      alert('Error removing line: ' + (data.error || 'Unknown'));
    }
  } catch (e) {
    alert('Error removing line from lot plan');
  }
}


// ===== WORKFLOW DETAILS (right-click from project folder ISO table) =====
async function viewIsoWorkflowDetails(iso) {
  const jobNo  = iso.job_no  || selectedProject;
  const unitNo = iso.unit_no || selectedUnit;
  const lineNo = iso.line_no;

  const modal    = document.getElementById('lineDetailsModal');
  const body     = document.getElementById('ldm-body');
  const subtitle = document.getElementById('ldm-line-subtitle');
  if (!modal || !body || !subtitle) return;

  subtitle.textContent = `${jobNo} · ${unitNo} · ${lineNo}`;
  body.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-faint);font-size:13px;">Loading…</div>`;
  modal.classList.add('open');

  try {
    const [detailsRes, inchRes, lmsRes] = await Promise.all([
      fetch(`/api/line-details?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`),
      fetch(`/api/inch/line?project=${encodeURIComponent(jobNo)}&unit=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`),
      fetch(`/api/lms/line?project=${encodeURIComponent(jobNo)}&unit=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`),
    ]);
    const data       = await detailsRes.json();
    const inchResult = await inchRes.json().catch(() => ({ ok: false }));
    const lmsResult  = await lmsRes.json().catch(() => ({ ok: false }));
    if (data.ok) {
      data.inchData = (inchResult.ok && inchResult.data) ? inchResult.data : null;
      data.lmsData  = (lmsResult.ok && lmsResult.rows?.length) ? lmsResult.rows : null;
      body.innerHTML = renderLineDetailsBody(data);   // defined in left-top.js, same page
    } else {
      body.innerHTML = `<p style="color:#b91c1c;font-size:13px;">${data.error || 'Failed to load details.'}</p>`;
    }
  } catch {
    body.innerHTML = `<p style="color:#b91c1c;font-size:13px;">Network error.</p>`;
  }
}


// Read-only revision history view — what revisions this line has gone
// through, who approved each one, and which lot (if any) it was issued in.
// Pure GET, no workflow state is touched.
async function viewIsoRevisionHistory(iso) {
  const jobNo  = iso.job_no  || selectedProject;
  const unitNo = iso.unit_no || selectedUnit;
  const lineNo = iso.line_no;

  const modal    = document.getElementById('revisionHistoryModal');
  const body     = document.getElementById('rhm-body');
  const subtitle = document.getElementById('rhm-line-subtitle');
  if (!modal || !body || !subtitle) return;

  subtitle.textContent = `${jobNo} · ${unitNo} · ${lineNo}`;
  body.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-faint);font-size:13px;">Loading…</div>`;
  modal.classList.add('open');

  try {
    const resp = await fetch(`/api/drawing-revision-history?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`);
    const data = await resp.json();
    body.innerHTML = data.ok
      ? renderRevisionHistoryBody(data)
      : `<p style="color:#b91c1c;font-size:13px;padding:1rem;">${data.error || 'Failed to load revision history.'}</p>`;
  } catch {
    body.innerHTML = `<p style="color:#b91c1c;font-size:13px;padding:1rem;">Network error.</p>`;
  }
}

function renderRevisionHistoryBody(data) {
  const revisions = data.revisions || [];
  if (revisions.length === 0) {
    return `<p style="padding:1rem;color:var(--text-faint);font-size:13px;">No upload history found for this line.</p>`;
  }

  const fmt = d => d ? new Date(d).toLocaleString() : '—';

  const statusBadge = (status) => {
    if (status === 'Issued')
      return `<span style="background:rgba(0,123,255,0.12);color:#007bff;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;">Issued</span>`;
    if (status === 'Final (not yet issued)')
      return `<span style="background:rgba(22,163,74,0.12);color:#16a34a;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;">Final · Not Issued</span>`;
    if (status === 'Superseded')
      return `<span style="background:rgba(100,116,139,0.12);color:#64748b;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;">Superseded</span>`;
    return `<span style="background:rgba(194,65,12,0.12);color:#c2410c;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;">${status || 'In Progress'}</span>`;
  };

  const cards = revisions.map(rev => {
    const isLatest = rev.revNo === data.currentRevNo;
    const filesRows = rev.files.map(f => {
      const href = `/uploads/${data.jobNo}/${data.unitNo}/${data.zone}/${f.fileName}`;
      return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid #f1f5f9;">
        <a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:none;">${f.fileName}</a>
        <span style="color:var(--text-faint);">${fmt(f.uploadedOn)}</span>
      </div>`;
    }).join('');

    const approvalLine = rev.approvedBy
      ? `<div style="font-size:12px;margin-top:6px;"><strong>Approved by:</strong> ${rev.approvedBy} (${(rev.approvedByRole||[]).join(', ')}) on ${fmt(rev.approvedAt)}</div>`
      : `<div style="font-size:12px;margin-top:6px;color:var(--text-faint);">No approval record found for this revision.</div>`;

    const lotLine = rev.issuedLotNumber
      ? `<div style="font-size:12px;margin-top:2px;"><strong>Issued in:</strong> Lot ${rev.issuedLotNumber} on ${fmt(rev.issuedAt)}</div>`
      : '';

    return `
      <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin-bottom:10px;${isLatest ? 'border-left:4px solid #2563eb;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:14px;font-weight:700;color:#1e293b;">Revision R${rev.revNo}${isLatest ? ' (current)' : ''}</div>
          ${statusBadge(rev.status)}
        </div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:2px;">Started ${fmt(rev.startedAt)} · ${rev.uploadCount} upload(s)</div>
        ${approvalLine}
        ${lotLine}
        <div style="margin-top:8px;">${filesRows}</div>
      </div>`;
  }).join('');

  return `<div style="padding:0.5rem 0.2rem;">${cards}</div>`;
}

// Wire up revision history modal close button
document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('closeRevisionHistoryModal');
  const modal    = document.getElementById('revisionHistoryModal');
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }
});


// Refresh tree data and re-render the current zone (used after lot changes)
async function refreshZoneData() {
  const res = await fetch('/api/tree');
  const data = await res.json();
  if (data.ok) {
    currentTreeData = data.projects;
    renderProjectTree();
    if (selectedProject && selectedUnit && selectedZone) {
      await loadZoneISOs(selectedProject, selectedUnit, selectedZone);
      loadAndApplyClaimBadges(selectedProject, selectedUnit, selectedZone);
    }
  }
}


// Back navigation from comments to ISOs
document.addEventListener('DOMContentLoaded', function () {
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back to ISOs';
  backBtn.className = 'back-to-isos-btn';
  backBtn.style.cssText = `
    margin: 10px;
    padding: 8px 16px;
    background-color: #6c757d;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  `;


  backBtn.addEventListener('click', function () {
    const isoSurface = document.querySelector('.iso-surface');
    const commentsSurface = document.querySelector('.comments-surface');


    if (isoSurface) isoSurface.style.display = 'block';
    if (commentsSurface) commentsSurface.style.display = 'none';
  });


  const commentsToolbar = document.querySelector('.comments-surface .iso-surface-toolbar');
  if (commentsToolbar) {
    commentsToolbar.appendChild(backBtn);
  }
});

// ── Who has this line? popover ────────────────────────────────────────────────
(function () {
  const ROLE_LABEL = { PC: 'Process Checker', MC: 'Material Checker', SC: 'Stress Checker', GL: 'GL', SGL: 'SGL', Modeller: 'Modeller' };

  function removePopover() {
    document.querySelectorAll('.line-who-popover').forEach(p => p.remove());
  }

  async function showWhoPopover(triggerEl, jobNo, unitNo, lineNo) {
    removePopover();

    const pop = document.createElement('div');
    pop.className = 'line-who-popover';
    pop.style.cssText = [
      'position:fixed;z-index:9999;background:#fff;border:1px solid #e2e8f0;border-radius:10px',
      'box-shadow:0 6px 20px rgba(0,0,0,0.13);padding:14px 16px;min-width:210px;max-width:300px',
      'font-size:13px;font-family:inherit;'
    ].join(';');

    const rect = triggerEl.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.left = rect.left + 'px';
    pop.innerHTML  = '<div style="color:#94a3b8;font-size:12px;">Loading…</div>';
    document.body.appendChild(pop);

    try {
      const resp = await fetch(
        `/api/drawing-claimers?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`
      );
      const data = await resp.json();
      const entries = Object.entries(data.claimedBy || {});

      if (!entries.length) {
        pop.innerHTML =
          '<div style="font-weight:600;color:#0f172a;margin-bottom:4px;">Not claimed</div>' +
          '<div style="color:#64748b;font-size:12px;">Line is in the pool — no one holds it yet.</div>';
      } else {
        pop.innerHTML =
          '<div style="font-weight:700;color:#0f172a;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">Currently with</div>' +
          entries.map(([, v]) => {
            const roleLabels = (v.roles || []).map(r => ROLE_LABEL[r] || r).join(', ');
            return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">` +
              `<div style="width:32px;height:32px;border-radius:50%;background:#007bff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${(v.name||'?')[0].toUpperCase()}</div>` +
              `<div><div style="font-weight:600;color:#0f172a;">${v.name || v.user_id}</div><div style="color:#64748b;font-size:11px;">${roleLabels}</div></div>` +
              `</div>`;
          }).join('');
      }
    } catch (e) {
      pop.innerHTML = '<div style="color:#dc2626;">Failed to load</div>';
    }

    // Dismiss on outside click
    setTimeout(() => {
      document.addEventListener('click', function dismiss(e) {
        if (!pop.contains(e.target)) { removePopover(); document.removeEventListener('click', dismiss); }
      });
    }, 0);
  }

  // Delegated click on all .line-who-btn spans
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.line-who-btn');
    if (!btn) return;
    e.stopPropagation();
    showWhoPopover(btn, btn.dataset.job, btn.dataset.unit, btn.dataset.line);
  });
})();

// ── Line Tags ─────────────────────────────────────────────────────────────────
const TAG_COLORS = {
  IBR:  { bg: '#fff3e0', color: '#e65100' },
  H2:   { bg: '#fce4ec', color: '#c62828' },
};
const TAG_DEFAULT = { bg: '#e8eaf6', color: '#283593' };

function tagStyle(tag) {
  const s = TAG_COLORS[tag] || TAG_DEFAULT;
  return `background:${s.bg};color:${s.color};`;
}

function renderTagPills(tags) {
  if (!tags || !tags.length) return '';
  return tags.map(t =>
    `<span class="line-tag-pill" style="${tagStyle(t)}">${t}</span>`
  ).join('');
}

async function openTagModal(iso) {
  const existing = document.getElementById('_tag-modal');
  if (existing) existing.remove();

  const jobNo  = iso.job_no  || selectedProject;
  const unitNo = iso.unit_no || selectedUnit;
  const lineNo = iso.line_no;
  let tags = Array.isArray(iso.tags) ? [...iso.tags] : [];

  const modal = document.createElement('div');
  modal.id = '_tag-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:10000;';

  function renderModal() {
    const chipsHtml = tags.map(t =>
      `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:12px;font-size:12px;font-weight:600;${tagStyle(t)}">
        ${t}
        <button data-remove="${t}" style="background:none;border:none;cursor:pointer;font-size:14px;line-height:1;color:inherit;padding:0;opacity:.7;" title="Remove">&times;</button>
      </span>`
    ).join('');

    modal.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:420px;padding:24px 26px;box-shadow:0 8px 32px rgba(0,0,0,0.18);font-family:inherit;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div>
            <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Tag Line</div>
            <div style="font-size:15px;font-weight:700;color:#0f172a;">${lineNo}</div>
          </div>
          <button id="_tag-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;">&times;</button>
        </div>

        <div id="_tag-chips" style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px;margin-bottom:14px;">
          ${chipsHtml || '<span style="color:#94a3b8;font-size:13px;">No tags yet</span>'}
        </div>

        <div style="display:flex;gap:8px;margin-bottom:20px;">
          <input id="_tag-input" type="text" placeholder="Type a tag (e.g. IBR, H2) and press Enter"
            style="flex:1;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;outline:none;"
            maxlength="30" />
          <button id="_tag-add" style="padding:8px 14px;background:#007bff;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;">Add</button>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="_tag-cancel" style="padding:8px 18px;background:#f1f5f9;color:#334155;border:none;border-radius:6px;font-size:13px;cursor:pointer;">Cancel</button>
          <button id="_tag-save" style="padding:8px 18px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Save</button>
        </div>
      </div>`;

    document.getElementById('_tag-close').onclick  = () => modal.remove();
    document.getElementById('_tag-cancel').onclick = () => modal.remove();

    document.getElementById('_tag-chips').querySelectorAll('[data-remove]').forEach(btn => {
      btn.onclick = () => {
        tags = tags.filter(t => t !== btn.dataset.remove);
        renderModal();
      };
    });

    function addTag() {
      const val = document.getElementById('_tag-input').value.trim().toUpperCase();
      if (val && !tags.includes(val)) { tags.push(val); renderModal(); }
      else document.getElementById('_tag-input').value = '';
    }

    document.getElementById('_tag-add').onclick = addTag;
    document.getElementById('_tag-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    });

    document.getElementById('_tag-save').onclick = async () => {
      document.getElementById('_tag-save').textContent = 'Saving…';
      try {
        const res = await fetch('/api/drawings/tag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobNo, unitNo, lineNo, tags }),
        });
        const data = await res.json();
        if (data.ok) {
          modal.remove();
          await refreshZoneData();
        } else {
          alert('Error: ' + (data.error || 'Failed'));
          document.getElementById('_tag-save').textContent = 'Save';
        }
      } catch (e) {
        alert('Network error');
        document.getElementById('_tag-save').textContent = 'Save';
      }
    };

    setTimeout(() => document.getElementById('_tag-input')?.focus(), 50);
  }

  document.body.appendChild(modal);
  renderModal();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ===== LOT STATUS MODAL =====
// Opens a live status view of a planned lot. Accessible to all logged-in users via
// clicking any L{N} badge — the badge carries jobNo/unitNo as data attributes.
async function openLotStatusModal(jobNo, unitNo, lotNumber) {
  const existing = document.getElementById('_lot-status-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = '_lot-status-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:10000;';

  function setCard(html) {
    modal.innerHTML = `<div style="background:#fff;border-radius:12px;width:720px;max-width:95vw;max-height:88vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.22);display:flex;flex-direction:column;">${html}</div>`;
    const closeBtn = modal.querySelector('._lot-close');
    if (closeBtn) closeBtn.onclick = () => modal.remove();
  }

  setCard(`
    <div style="padding:20px 24px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Lot Live Status</div>
        <div style="font-size:17px;font-weight:700;color:#0f172a;">Lot ${lotNumber} · ${jobNo} / ${unitNo}</div>
      </div>
      <button class="_lot-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#94a3b8;line-height:1;">&times;</button>
    </div>
    <div style="padding:24px;text-align:center;color:#94a3b8;font-size:14px;">Loading…</div>
  `);

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  let data;
  try {
    const r = await fetch(`/api/lots/status?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lotNumber=${encodeURIComponent(lotNumber)}`);
    data = await r.json();
  } catch {
    setCard(`<div style="padding:24px;color:#ef4444;">Network error — could not load lot data.</div>`);
    return;
  }

  if (!data.ok) {
    setCard(`
      <div style="padding:20px 24px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:17px;font-weight:700;color:#0f172a;">Lot ${lotNumber}</div>
        <button class="_lot-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#94a3b8;line-height:1;">&times;</button>
      </div>
      <div style="padding:24px;color:#64748b;font-size:14px;">${data.error || 'Lot not found or already issued.'}</div>
    `);
    return;
  }

  const { lot, lines } = data;

  // Status colour coding
  function sColor(status) {
    if (status === 'Uploaded')       return { bg: '#dbeafe', text: '#1d4ed8' };
    if (status === 'Claimed')        return { bg: '#fef3c7', text: '#92400e' };
    if (status === 'Checking')       return { bg: '#ede9fe', text: '#5b21b6' };
    if (status === 'Comment Issued') return { bg: '#ffedd5', text: '#9a3412' };
    if (status === 'Returned')       return { bg: '#fee2e2', text: '#991b1b' };
    if (status === 'Final')          return { bg: '#dcfce7', text: '#166534' };
    if (status === 'Approved')       return { bg: '#dcfce7', text: '#166534' };
    return { bg: '#f1f5f9', text: '#475569' };
  }

  // Summary counts
  const counts = {};
  for (const l of lines) counts[l.status] = (counts[l.status] || 0) + 1;
  const summaryHtml = Object.entries(counts).map(([status, n]) => {
    const c = sColor(status);
    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:${c.bg};color:${c.text};">${n} ${status}</span>`;
  }).join('');

  const rowsHtml = lines.map(l => {
    const c = sColor(l.status);
    const scBadge = l.stressCritical === 'Y' ? ' <span style="color:#ef4444;font-size:10px;font-weight:700;vertical-align:middle;">SC</span>' : '';
    const claimerText = (l.claimers && l.claimers.length)
      ? l.claimers.map(cl => `${cl.name}<span style="color:#94a3b8;font-size:10px;"> (${(cl.roles || []).join(', ')})</span>`).join('<br>')
      : '<span style="color:#cbd5e1;">—</span>';
    const tagsHtml = (l.tags && l.tags.length)
      ? (typeof renderTagPills === 'function' ? renderTagPills(l.tags) : l.tags.map(t => `<span style="padding:1px 6px;border-radius:8px;font-size:11px;background:#f1f5f9;color:#475569;">${t}</span>`).join(' '))
      : '<span style="color:#cbd5e1;">—</span>';
    return `<tr style="border-bottom:1px solid #f8fafc;">
      <td style="padding:8px 10px;font-size:12px;color:#64748b;white-space:nowrap;">${l.zone}</td>
      <td style="padding:8px 10px;font-size:12.5px;font-weight:600;color:#0f172a;">${l.lineNo}${scBadge}</td>
      <td style="padding:8px 10px;font-size:12px;color:#64748b;">R${l.revNo}</td>
      <td style="padding:8px 10px;white-space:nowrap;">
        <span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:600;background:${c.bg};color:${c.text};">${l.status}</span>
      </td>
      <td style="padding:8px 10px;font-size:12px;color:#334155;">${claimerText}</td>
      <td style="padding:8px 10px;">${tagsHtml}</td>
    </tr>`;
  }).join('');

  setCard(`
    <div style="padding:20px 24px;border-bottom:1px solid #f1f5f9;display:flex;align-items:flex-start;justify-content:space-between;flex-shrink:0;">
      <div>
        <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Lot Live Status</div>
        <div style="font-size:17px;font-weight:700;color:#0f172a;">Lot ${lot.lotNumber} · ${lot.jobNo} / ${lot.unitNo}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:3px;">Planned by ${lot.createdBy}</div>
      </div>
      <button class="_lot-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:#94a3b8;line-height:1;flex-shrink:0;margin-left:16px;">&times;</button>
    </div>

    <div style="padding:12px 24px;background:#f8fafc;border-bottom:1px solid #f1f5f9;flex-shrink:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
      <span style="font-size:12px;color:#64748b;font-weight:600;">${lines.length} line${lines.length !== 1 ? 's' : ''}</span>
      <span style="color:#e2e8f0;font-size:12px;">|</span>
      ${summaryHtml || '<span style="color:#94a3b8;font-size:12px;">No lines yet</span>'}
    </div>

    <div style="overflow-y:auto;flex:1;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#f8fafc;">Zone</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#f8fafc;">Line No</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#f8fafc;">Rev</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#f8fafc;">Status</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#f8fafc;">Claimed By</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;background:#f8fafc;">Tags</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:24px;text-align:center;color:#94a3b8;">No lines in this lot yet.</td></tr>'}</tbody>
      </table>
    </div>
  `);
}

