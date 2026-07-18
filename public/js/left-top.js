// left-top.js - Enhanced with role-based notifications
let currentUser = null;
let currentProject = null;
let assignedUnits = {};
let _currentStreamLabel = '';

// ===================== UNIVERSAL LOADING OVERLAY (with fade-in/out) =====================
function showLoadingOverlay() {
  // Prevent duplicate overlays
  if (document.getElementById("loading-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "loading-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(255,255,255,0.8);
    z-index: 9999;
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  overlay.innerHTML = `
    <div style="text-align:center;">
      <div class="spinner" style="
        border: 6px solid #f3f3f3;
        border-top: 6px solid #007bff;
        border-radius: 50%;
        width: 60px;
        height: 60px;
        animation: spin 1s linear infinite;
        margin: 0 auto;
      "></div>
      <p style="margin-top:15px; font-size:16px; color:#007bff; font-weight:bold;">
        Loading...
      </p>
    </div>
  `;

  document.body.appendChild(overlay);

  // Trigger fade-in after a tiny delay (ensures transition works)
  requestAnimationFrame(() => {
    overlay.style.opacity = "1";
  });

  // Add spinner and fade animations only once
  if (!document.getElementById("overlay-style")) {
    const style = document.createElement("style");
    style.id = "overlay-style";
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("loading-overlay");
  if (overlay) {
    overlay.style.opacity = "0"; // start fade-out
    // Wait for fade-out to finish before removing
    setTimeout(() => overlay.remove(), 300);
  }
}
// =====================================================================



// Load current user info
async function loadCurrentUser() {
  try {
    const response = await fetch("/api/me");
    if (response.ok) {
      currentUser = await response.json();
    }
  } catch (error) {
    console.error("Failed to load user info:", error);
  }
}

// Lot plan badge — shown wherever a line appears if it has a pending lot assignment.
// jobNo / unitNo are embedded as data attributes so the delegated click handler below
// can open the lot status modal without walking the DOM.
function lotBadgeHtml(plannedLotNumber, jobNo, unitNo) {
  if (!plannedLotNumber) return '';
  const jAttr = jobNo  ? ` data-job="${jobNo}"`   : '';
  const uAttr = unitNo ? ` data-unit="${unitNo}"` : '';
  return `<span class="lot-plan-badge" data-lotnumber="${plannedLotNumber}"${jAttr}${uAttr} title="Planned: Lot ${plannedLotNumber} — click to view status" style="margin-left:5px;cursor:pointer;">L${plannedLotNumber}</span>`;
}

// Delegated click handler — any .lot-plan-badge anywhere on the page opens the modal
document.addEventListener('click', function (e) {
  const badge = e.target.closest('.lot-plan-badge');
  if (!badge) return;
  e.stopPropagation();
  const lotNumber = badge.dataset.lotnumber;
  const jobNo     = badge.dataset.job;
  const unitNo    = badge.dataset.unit;
  if (!lotNumber) return;
  if (typeof openLotStatusModal === 'function') {
    openLotStatusModal(jobNo, unitNo, parseInt(lotNumber, 10));
  }
});

// Add CSS for highlighted row
const style = document.createElement("style");
style.textContent = `
  .history-highlighted {
    background-color: #fff3cd !important;
    border: 2px solid #ffc107 !important;
  }
  
  #historyModal table tbody tr:hover {
    background-color: #f5f5f5 !important;
  }
  
  .history-file-row:hover {
    background-color: #f5f5f5 !important;
  }
  
  .selected-history-row {
    background-color: #e3f2fd !important;
    border-left: 4px solid #007bff !important;
  }
  
  .file-name-link {
    color: #007bff;
    text-decoration: none;
  }
  
  .file-name-link:hover {
    text-decoration: underline;
  }
  
  .detail-item {
    margin-bottom: 15px;
    padding: 10px;
    border-left: 3px solid #007bff;
    background-color: #f8f9fa;
  }
  
  .detail-item strong {
    color: #495057;
  }
  
  .task-history-container {
    padding: 20px;
    height: calc(100vh - 100px);
    overflow: hidden;
  }
`;

const additionalStyle = document.createElement("style");
additionalStyle.textContent = `
  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;
document.head.appendChild(additionalStyle);

document.head.appendChild(style);

// --- Begin: Notification menu highlight style (added) ---
const notifHighlightStyle = document.createElement("style");
notifHighlightStyle.textContent = `
  /* Highlight the Notifications item in the left menu when active */
  .menu-notif-active {
    background-color: #15f3bfff !important;
    border-left: 4px solid #0713ffff !important;
    padding-left: 6px;
  }
  .menu-notif-active .icon {
    filter: drop-shadow(0 0 2px #ffc107);
  }
`;
document.head.appendChild(notifHighlightStyle);
// --- End: Notification menu highlight style ---

// --- Begin: My Tasks & Final Isometrics highlight style (added) ---
const extraHighlightStyle = document.createElement("style");
extraHighlightStyle.textContent = `
  .menu-task-active,
  .menu-finaliso-active {
    background-color: #15f3bfff !important;
    border-left: 4px solid #0713ffff !important;
    padding-left: 6px;
  }
  .menu-task-active .icon,
  .menu-finaliso-active .icon {
    filter: drop-shadow(0 0 2px #ffc107);
  }
`;
document.head.appendChild(extraHighlightStyle);
// --- End: My Tasks & Final Isometrics highlight style ---

let _taskActiveFilters = {};

// Auto-refresh functions
async function refreshCurrentNotificationView() {
  const currentRole = window.currentSelectedRole?.role;
  if (!currentRole) return;

  // ✅ Restore last known summary from cache (for Modeller, GL, SGL)
  if (["Modeller", "GL", "SGL"].includes(currentRole)) {
    try {
      const stored = localStorage.getItem(`linesSummary_${currentRole}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        updateAvailableLinesSummary(parsed);
      }
    } catch (err) {
      console.warn("Failed to restore cached summary:", err);
    }
  }

  if (currentRole === "Checker") {
    await loadCheckerNotifications();
  } else if (window.currentSelectedRole?.assignments) {
    // Reload all projects/units for this role
    const role = window.currentSelectedRole.role;
    const assignments = window.currentSelectedRole.assignments;
    const allNotifications = [];

    for (const assignment of assignments) {
      const resp = await fetch(
        `/api/notifications-by-role?role=${encodeURIComponent(
          role
        )}&project=${encodeURIComponent(
          assignment.project
        )}&unit=${encodeURIComponent(assignment.unit)}`
      );
      const data = await resp.json();
      if (data.ok) {
        const withContext = data.notifications.map((n) => ({
          ...n,
          assignmentProject: assignment.project,
          assignmentUnit: assignment.unit,
        }));
        allNotifications.push(...withContext);
      }
    }

    // Deduplicate notifications by project, unit, line, rev, and upload count
    const seen = new Set();
    const uniqueNotifications = [];
    for (const n of allNotifications) {
      const key = [
        n.jobNo || "",
        n.unitNo || "",
        n.lineNo || "",
        n.revNo || "",
        n.uploadCount || "",
      ].join("||");

      if (!seen.has(key)) {
        seen.add(key);
        uniqueNotifications.push(n);
      }
    }

    updateNotificationTableHeaders(role);
    renderNotificationsTable(uniqueNotifications);
    setupClaimButton();
    if (['GL', 'SGL'].includes(role)) loadHoldLines();
    // ✅ Ensure "Lines available to Claim" count is always up to date and retained
    if (["Modeller", "GL", "SGL"].includes(window.currentSelectedRole?.role)) {
      updateAvailableLinesSummary(uniqueNotifications);

      // Store the correct summary persistently for reopening without reload
      try {
        localStorage.setItem(
          `linesSummary_${window.currentSelectedRole.role}`,
          JSON.stringify(uniqueNotifications)
        );
      } catch (err) {
        console.warn("Failed to cache lines summary:", err);
      }
    }
  } else {
    await loadNotificationsForMainRole(currentRole);
  }
}

async function refreshMyTasksView() {
  const taskTable = document.getElementById("default-task-table-container");
  if (taskTable && taskTable.style.display !== "none") {
    await loadClaimedTasksData();
  }
}

// // Auto-refresh My Tasks every 10 seconds when visible
// setInterval(async () => {
//   await refreshMyTasksView();
// }, 10000);

/*
// Auto-refresh Notifications every 10 seconds when visible
setInterval(async () => {
  const notifTable = document.getElementById('default-notification-table-container');
  if (notifTable && notifTable.style.display !== 'none') {
    await refreshCurrentNotificationView();
  }
}, 10000);

*/

// Initialize when page loads
document.addEventListener("DOMContentLoaded", async function () {
  await loadCurrentUser();

  setupMenuEventListeners();
  setupPerformanceViewTaskListeners();
  setupPerformanceViewNotificationListeners();
});

function setupMenuEventListeners() {
  // My Tasks listeners
  const myTasksItems = document.querySelectorAll(
    'li img[src="images/comment.png"]'
  );
  myTasksItems.forEach((item) => {
    item.parentElement.addEventListener("click", function () {
      showMyTasks();
    });
  });

  // Notifications listeners
  const notificationItems = document.querySelectorAll(
    'li img[src="images/notification.png"]'
  );
  notificationItems.forEach((item) => {
    item.parentElement.addEventListener("click", function () {
      showNotifications();
    });
  });


}

// Setup event delegation for My Tasks buttons in performance views
function setupPerformanceViewTaskListeners() {
  // Use event delegation to handle clicks on My Tasks buttons in performance views
  document.addEventListener("click", function (event) {
    // Check if clicked element is a My Tasks button inside a performance view
    const isMyTaskButton =
      event.target.matches('img[src="images/comment.png"]') &&
      event.target.closest(
        "#modeller-performance-view, #gl-performance-view, #sgl-performance-view"
      );

    if (isMyTaskButton) {
      event.preventDefault();
      showMyTasks();
    }
  });
}

// Setup event delegation for Notification buttons in any performance view
function setupPerformanceViewNotificationListeners() {
  document.addEventListener("click", function (event) {
    // Match the notification bell icon inside any performance view
    if (
      event.target.matches('img[src="images/notification.png"]') &&
      event.target.closest(
        "#modeller-performance-view, #gl-performance-view, #sgl-performance-view, #checker-performance-view"
      )
    ) {
      event.preventDefault();
      showNotifications();
    }
  });
}

function showMyTasks() {
  // === Show loading overlay ===
  showLoadingOverlay();


  window.currentView = null;

  // Clear any existing filter state when entering My Tasks fresh
  _taskActiveFilters = {};
  removeNotificationMenuHighlight();
  clearNotificationRoleTitle();

  // Check if we're in performance view and clean it up

  const checkerView = document.getElementById("checker-performance-view");
  if (checkerView) {
    checkerView.remove();
  }

  // Also remove other performance views
  const modellerView = document.getElementById("modeller-performance-view");
  if (modellerView) {
    modellerView.remove();
  }

  const glView = document.getElementById("gl-performance-view");
  if (glView) {
    glView.remove();
  }

  const sglView = document.getElementById("sgl-performance-view");
  if (sglView) {
    sglView.remove();
  }

  // Hide final isometrics table and all lot panels if open
  const fi = document.getElementById('final-isometrics-table-container');
  if (fi) fi.style.display = 'none';
  const lotPanel = document.getElementById('lot-detail-panel');
  if (lotPanel) lotPanel.style.display = 'none';
  const plannedPanel = document.getElementById('planned-lots-panel');
  if (plannedPanel) plannedPanel.style.display = 'none';
  const issuedPanel = document.getElementById('issued-lots-panel');
  if (issuedPanel) issuedPanel.style.display = 'none';

  // Hide ALL view-panels and show task panel
  document.querySelectorAll('.view-panel').forEach(p => {
    p.classList.remove('active-panel');
    p.style.display = 'none';
  });

  const defaultTable = document.getElementById('default-task-table-container');
  if (defaultTable) {
    defaultTable.style.display = 'block';
    defaultTable.classList.add('active-panel');
    const tbody = defaultTable.querySelector('.data-table tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="9" class="no-data">Loading tasks...</td></tr>';
    }
  }

  // Load data first, then show the table with data
  (async function () {
    try {
      await loadClaimedTasksData();
    } finally {
      hideLoadingOverlay();
    }
  })();

}


async function showNotifications() {
  window.currentView = null;

  // Clear task filter state when switching to notifications
  _taskActiveFilters = {};

  // Check if we're in performance view and clean it up

  const checkerView = document.getElementById("checker-performance-view");
  if (checkerView) {
    checkerView.remove();
  }

  // Also remove other performance views
  const modellerView = document.getElementById("modeller-performance-view");
  if (modellerView) {
    modellerView.remove();
  }

  const glView = document.getElementById("gl-performance-view");
  if (glView) {
    glView.remove();
  }

  const sglView = document.getElementById("sgl-performance-view");
  if (sglView) {
    sglView.remove();
  }

  // Hide ALL view-panels (welcome + any other active panel) and show notification panel
  document.querySelectorAll('.view-panel').forEach(p => {
    p.classList.remove('active-panel');
    p.style.display = 'none';
  });
  const _lotPanelN = document.getElementById('lot-detail-panel');
  if (_lotPanelN) _lotPanelN.style.display = 'none';
  const _fiN = document.getElementById('final-isometrics-table-container');
  if (_fiN) _fiN.style.display = 'none';
  const _plannedN = document.getElementById('planned-lots-panel');
  if (_plannedN) _plannedN.style.display = 'none';
  const _issuedN = document.getElementById('issued-lots-panel');
  if (_issuedN) _issuedN.style.display = 'none';

  const defaultNotificationTable = document.getElementById('default-notification-table-container');
  if (defaultNotificationTable) {
    defaultNotificationTable.style.display = 'block';
    defaultNotificationTable.classList.add('active-panel');
    const tbody = defaultNotificationTable.querySelector('.data-table tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="10" class="no-data">Loading notifications...</td></tr>';
    }
  }

  highlightNotificationMenu();

  // Auto-detect user roles and load relevant notifications
  await autoLoadNotifications();
}


async function autoLoadNotifications() {
  const CHECKER_ROLES = ['Process Checker', 'Material Checker', 'Stress Checker'];
  showLoadingOverlay();
  try {
    const resp = await fetch('/api/users/my-roles');
    const data = await resp.json();

    if (!data.ok || !data.roles || data.roles.length === 0) {
      setNotificationRoleTitle('No Roles Assigned');
      renderNotificationsTable([]);
      return;
    }

    const roles = data.roles;
    const hasChecker    = roles.some(r => CHECKER_ROLES.includes(r.role));
    const hasGL         = roles.some(r => r.role === 'GL');
    const hasSGL        = roles.some(r => r.role === 'SGL');
    const hasModeller   = roles.some(r => r.role === 'Modeller');
    const hasISOManager = roles.some(r => r.role === 'ISO Manager');

    // Load by highest role in hierarchy: SGL > GL > ISO Manager > Checker > Modeller
    // ISO Manager sees the GL pool read-only (no claim button).
    if (hasSGL) {
      await loadNotificationsForMainRole('SGL');
    } else if (hasGL) {
      await loadNotificationsForMainRole('GL');
    } else if (hasISOManager) {
      await loadNotificationsForMainRole('ISO Manager');
    } else if (hasChecker) {
      await loadCheckerNotifications();
    } else if (hasModeller) {
      await loadNotificationsForMainRole('Modeller');
    } else {
      setNotificationRoleTitle('No matching role');
      renderNotificationsTable([]);
    }
  } catch (err) {
    console.error('autoLoadNotifications error:', err);
    renderNotificationsTable([]);
  } finally {
    hideLoadingOverlay();
    // Background badge counts — non-blocking, safe to fail
    refreshSidebarBadges().catch(() => {});
  }
}


async function showRoleSelectionDropdown() {
  if (!currentUser) {
    console.error("No current user found");
    return;
  }

  try {
    // Get user's roles from all projects
    const response = await fetch("/api/users/my-roles");
    const data = await response.json();

    if (!data.ok) {
      console.error("Failed to load user roles:", data.error);
      return;
    }

    const userRoles = data.roles || [];

    if (userRoles.length === 0) {
      alert("You have no roles assigned in any project.");
      return;
    }

    // Create role selection modal
    const roleModal = createRoleSelectionModal(userRoles);
    document.body.appendChild(roleModal);
  } catch (error) {
    console.error("Error loading roles:", error);
    alert("Error loading your roles. Please try again.");
  }
}

function createRoleSelectionModal(userRoles) {
  const modal = document.createElement("div");
  modal.id = "role-selection-modal";
  modal.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border: 2px solid #007bff;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 10000;
    padding: 20px;
    min-width: 400px;
  `;

  // Simplified role options - only 4 main roles
  const mainRoles = [
    { role: "Modeller", display: "Modeller" },
    { role: "Checker", display: "Checker (PC/MC/SC)" },
    { role: "GL", display: "Group Leader (GL)" },
    { role: "SGL", display: "Approver (SGL)" },
  ];

  const roleOptions = mainRoles
    .map(
      (roleData) => `
    <label style="display: block; margin: 10px 0; cursor: pointer;">
      <input type="radio" name="selected-role" value="${roleData.role}" style="margin-right: 8px;">
      ${roleData.display}
    </label>
  `
    )
    .join("");

  modal.innerHTML = `
    <h3 style="margin-top: 0; color: #007bff;">Select Role for Notifications</h3>
    <div style="margin: 15px 0;">
      ${roleOptions}
    </div>
    <div style="text-align: center; margin-top: 20px;">
      <button id="select-role-btn" style="background: #007bff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">View Notifications</button>
      <button id="cancel-role-btn" style="background: #6c757d; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Cancel</button>
    </div>
  `;

  // Add event listeners
  modal.querySelector('#select-role-btn').addEventListener('click', async () => {

    // === Show loading overlay when fetching notifications ===
    showLoadingOverlay();



    const selectedRole = modal.querySelector('input[name="selected-role"]:checked');
    if (!selectedRole) {
      alert('Please select a role');
      return;
    }

    const roleValue = selectedRole.value;
    modal.remove();

    // DON'T set title/highlight yet - wait until we confirm user has this role

    // Load notifications based on selected role
    // These functions will set the title/highlight only if successful
    if (roleValue === 'Checker') {
      await loadCheckerNotifications();
    } else {
      await loadNotificationsForMainRole(roleValue);
    }

    hideLoadingOverlay();


  });


  modal.querySelector("#cancel-role-btn").addEventListener("click", () => {
    modal.remove();
  });

  return modal;
}

async function loadCheckerNotifications() {
  try {
    _currentStreamLabel = 'Checker';
    const response = await fetch('/api/notifications');
    const data = await response.json();

    if (!data.ok) {
      renderNotificationsTable([]);
      return;
    }

    const notifications = data.notifications || [];

    window.currentSelectedRole = { role: "Checker" };
    if (typeof setNotificationRoleTitle === "function")
      setNotificationRoleTitle("Checker");
    if (typeof highlightNotificationMenu === "function")
      highlightNotificationMenu();

    const panel = document.getElementById("default-notification-table-container");
    if (panel) {
      panel.style.display = "block";
      updateNotificationTableHeaders("Checker");
      renderNotificationsTable(notifications);
      setupClaimButton();
      loadHoldLines();
    }
  } catch (error) {
    console.error("Error loading checker notifications:", error);
    renderNotificationsTable([]);
  }
}

async function loadNotificationsForMainRole(role) {
  try {
    _currentStreamLabel = role;
    // Load user's roles (all projects/units)
    const userResponse = await fetch("/api/users/my-roles");
    const userData = await userResponse.json();

    if (
      !userData.ok ||
      !Array.isArray(userData.roles) ||
      userData.roles.length === 0
    ) {
      alert("No role assignments found");
      return;
    }

    // Get all assignments that match the requested role
    const roleAssignments = userData.roles.filter((r) => r.role === role);
    if (!roleAssignments.length) {
      clearNotificationRoleTitle();
      removeNotificationMenuHighlight();
      renderNotificationsTable([]);
      return;
    }

    // Fetch notifications for every project/unit where this role is assigned
    const allNotifications = [];
    for (const assignment of roleAssignments) {
      const resp = await fetch(
        `/api/notifications-by-role?role=${encodeURIComponent(
          role
        )}&project=${encodeURIComponent(
          assignment.project
        )}&unit=${encodeURIComponent(assignment.unit)}`
      );
      const data = await resp.json();
      if (data && data.ok && Array.isArray(data.notifications)) {
        // Keep context so user can see project/unit per row if needed
        const withContext = data.notifications.map((n) => ({
          ...n,
          assignmentProject: assignment.project,
          assignmentUnit: assignment.unit,
        }));
        allNotifications.push(...withContext);
      }
    }

    // De-duplicate notifications for Modeller by project, unit, line, rev, and upload count
    const seen = new Set();
    const merged = [];
    for (const n of allNotifications) {
      const key = [
        n.jobNo || "",
        n.unitNo || "",
        n.lineNo || "",
        n.revNo || "",
        n.uploadCount || "",
      ].join("||");

      if (!seen.has(key)) {
        seen.add(key);
        merged.push(n);
      }
    }

    // Store ALL assignments so refresh can reload properly
    window.currentSelectedRole = {
      role: role,
      assignments: roleAssignments.map((a) => ({
        project: a.project,
        unit: a.unit,
      })),
    };
    // Ensure UI shows role title & highlight when role notifications are loaded programmatically.
    if (!window.__suppressNotificationUI) {
      if (typeof setNotificationRoleTitle === "function")
        setNotificationRoleTitle(role);
      if (typeof highlightNotificationMenu === "function")
        highlightNotificationMenu();
    }

    // Render merged notifications (same table UI as before)
    const defaultNotificationTable = document.getElementById(
      "default-notification-table-container"
    );
    if (defaultNotificationTable) {
      defaultNotificationTable.style.display = "block";
      updateNotificationTableHeaders(role);
      renderNotificationsTable(merged);
      setupClaimButton();
    }
  } catch (error) {
    console.error("Error loading notifications for role:", error);
    alert("Error loading notifications. Please try again.");
  }
}

async function loadNotificationsForRole(roleData) {
  try {
    const response = await fetch(
      `/api/notifications-by-role?role=${roleData.role}&project=${roleData.project}&unit=${roleData.unit}`
    );
    const data = await response.json();

    if (data.ok) {
      // Store selected role context
      window.currentSelectedRole = roleData;
      // Ensure UI shows role title & highlight when this role is loaded programmatically.
      if (!window.__suppressNotificationUI) {
        if (typeof setNotificationRoleTitle === "function")
          setNotificationRoleTitle(roleData.role);
        if (typeof highlightNotificationMenu === "function")
          highlightNotificationMenu();
      }

      // Show appropriate notification table
      const defaultNotificationTable = document.getElementById(
        "default-notification-table-container"
      );
      if (defaultNotificationTable) {
        defaultNotificationTable.style.display = "block";
        updateNotificationTableHeaders(roleData.role);
        renderNotificationsTable(data.notifications);
        setupClaimButton();
      }
    } else {
      console.error("Failed to load notifications:", data.error);
      alert("Failed to load notifications for selected role");
    }
  } catch (error) {
    console.error("Error loading notifications:", error);
    alert("Error loading notifications. Please try again.");
  }
}

async function loadNotificationsData() {
  try {
    const response = await fetch("/api/notifications");
    const data = await response.json();

    if (data.ok) {
      const currentRole = window.currentSelectedRole?.role;
      // If there is already a selected role (e.g. after login) ensure the role title & left menu highlight are shown.
      // Don't do this if UI suppression is active (perform.js uses __suppressNotificationUI while switching views).
      if (currentRole && !window.__suppressNotificationUI) {
        if (typeof setNotificationRoleTitle === "function")
          setNotificationRoleTitle(currentRole);
        if (typeof highlightNotificationMenu === "function")
          highlightNotificationMenu();
      }

      if (currentRole === "Checker") {
        await loadCheckerNotifications();
      } else if (currentRole) {
        await loadNotificationsForMainRole(currentRole);
      }
    } else {
      console.error("Failed to load notifications:", data.error);
    }
  } catch (error) {
    console.error("Error loading notifications:", error);
  }
}

function filterNotificationsBasedOnRole(notifications) {
  if (!currentUser) return [];

  // The filtering is already done by the backend based on user's project assignments
  // We just need to return the notifications as they come from the backend
  return notifications;
}

function renderNotificationsTable(notifications) {
  const tableContainer = document.querySelector(
    "#default-notification-table-container .data-table tbody"
  );
  if (!tableContainer) return;

  // Always sync headers to current role — prevents stale static HTML headers
  const currentRole = window.currentSelectedRole?.role || "Process Checker";
  updateNotificationTableHeaders(currentRole);

  // Save current selections before refresh — but only when re-rendering the
  // SAME role's table (e.g. a periodic poll), not when switching to a
  // different role's table entirely. Without the role check, switching from
  // Checker to Modeller/GL/SGL would carry over whatever was checked before.
  // Keyed by job/unit/line identity rather than row position (data-index) —
  // position is just "row 0, row 1..." and means nothing across two
  // completely different notification lists; matching by line identity also
  // survives the same role's list being reordered between refreshes.
  const preservedSelections = new Set();
  if (window._lastRenderedNotifRole === currentRole) {
    document.querySelectorAll(".notification-select:checked").forEach((cb) => {
      const r = cb.closest("tr");
      if (r) preservedSelections.add(`${r.dataset.jobNo}|${r.dataset.unitNo}|${r.dataset.lineNo}`);
    });
  }
  window._lastRenderedNotifRole = currentRole;

  // Clear existing rows
  tableContainer.innerHTML = "";
  setupTableFilters(notifications);

  if (notifications.length === 0) {
    tableContainer.innerHTML =
      '<tr><td colspan="10" class="no-data">No notifications available</td></tr>';
    syncSelectAllCheckbox();
    updateSelectedNotifCount();
    return;
  }

  notifications.forEach((notification, index) => {
    const row = document.createElement("tr");
    row.setAttribute("data-index", index);
    row.dataset.jobNo  = notification.jobNo;
    row.dataset.unitNo = notification.unitNo;
    row.dataset.lineNo = notification.lineNo;

    // Generate role-specific content
    const roleSpecificContent = generateRoleSpecificContent(
      notification,
      currentRole
    );

    // Stress-critical badge
    const sc = notification.stressCritical || 'N';
    const scBadge = `<span class="sc-badge sc-badge-${sc.toLowerCase()}">${sc}</span>`;

    // Upload-type badge
    const isForReview = notification.uploadType === "For Review" ||
      (!notification.uploadType && notification.status === "Uploaded" && notification.forwardedByModeller);
    const utypeBadge = `<span class="utype-badge ${isForReview ? 'utype-review' : 'utype-manual'}">${isForReview ? 'For Review' : 'Manual'}</span>`;

    // Two-line date cell
    let dateHtml = '—';
    if (notification.uploadedOn) {
      const d = new Date(notification.uploadedOn);
      const datePart = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      const timePart = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      dateHtml = `<span class="dt-date">${datePart}</span><span class="dt-time">${timePart}</span>`;
    }

    row.innerHTML = `
      <td style="text-align:center;width:36px;">
        <input type="checkbox" class="notification-select" data-index="${index}" onchange="handleRowSelection(this)">
      </td>
      <td style="font-weight:600;color:var(--blue-700);font-size:12.5px;">${notification.jobNo}</td>
      <td style="color:var(--text-secondary);font-size:12.5px;">${notification.unitNo}</td>
      <td><span class="lno-tag">${notification.lineNo}</span>${lotBadgeHtml(notification.plannedLotNumber, notification.jobNo, notification.unitNo)}${typeof renderTagPills === 'function' ? renderTagPills(notification.tags || []) : ''}</td>
      <td><span class="rev-badge">${notification.revNo}${notification.uploadCount ? '-' + notification.uploadCount : ''}</span></td>
      <td>${scBadge}</td>
      <td><span class="from-chip">${notification.from}</span></td>
      <td class="td-date">${dateHtml}</td>
      <td>${utypeBadge}</td>
      ${roleSpecificContent}
    `;


    tableContainer.appendChild(row);

    // Setup role-specific behavior
    setupRoleSpecificBehavior(row, notification, currentRole, index);
  });

  // Restore selections
  document.querySelectorAll(".notification-select").forEach((cb) => {
    const r = cb.closest("tr");
    const key = r ? `${r.dataset.jobNo}|${r.dataset.unitNo}|${r.dataset.lineNo}` : null;
    if (key && preservedSelections.has(key)) {
      cb.checked = true;
      handleRowSelection(cb); // reapply checkbox enabling
    }
  });
  // Always resync explicitly — handleRowSelection() above only runs for rows
  // that got restored, so a render with nothing restored (e.g. switching to a
  // different role) would otherwise leave the previous render's stale count showing.
  updateSelectedNotifCount();

  // Store notifications data for claiming
  window.notificationsData = notifications;

  updateAvailableLinesSummary(notifications);
}

// ----------------------------
// Update "Lines available to Claim" summary above notifications table
// expected: notifications is an array of notification objects with a .jobNo field
function updateAvailableLinesSummary(notifications) {
  const summaryContainer = document.getElementById("lines-summary");
  if (!summaryContainer) return;

  const rolePrefix = _currentStreamLabel ? `${_currentStreamLabel} ` : '';

  if (!Array.isArray(notifications) || notifications.length === 0) {
    summaryContainer.textContent = `${rolePrefix}(Lines available to Claim = NIL)`;
    return;
  }

  // Count occurrences (lines) per project (jobNo)
  const counts = {};
  notifications.forEach((n) => {
    const proj = (n.jobNo || "Unknown").toString().trim();
    if (!proj) return;
    counts[proj] = (counts[proj] || 0) + 1;
  });

  // Build display text: "B269: 12 ; B121: 8 ; B378: 10"
  const entries = Object.keys(counts).map((k) => `${k}: ${counts[k]}`);
  const summaryText = entries.join(" ; ");

  summaryContainer.textContent = `${rolePrefix}(Lines available to Claim = ${summaryText})`;
}

// --- Sidebar badge helpers ---

function _setBtnBadge(btn, count) {
  if (!btn.dataset.baseText) {
    let text = '';
    btn.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) text += n.textContent; });
    btn.dataset.baseText = text.replace(/\s*\(\d+\)\s*$/, '').trim();
  }
  const base = btn.dataset.baseText;
  // Remove existing text nodes
  Array.from(btn.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .forEach(n => n.parentNode.removeChild(n));
  btn.appendChild(document.createTextNode(count > 0 ? ` ${base} (${count})` : ` ${base}`));
}

async function _fetchRoleStreamCount(role) {
  try {
    const userResp = await fetch('/api/users/my-roles');
    const userData = await userResp.json();
    if (!userData.ok || !Array.isArray(userData.roles)) return 0;
    const assignments = userData.roles.filter(r => r.role === role);
    if (!assignments.length) return 0;
    const seen = new Set();
    for (const a of assignments) {
      const resp = await fetch(
        `/api/notifications-by-role?role=${encodeURIComponent(role)}&project=${encodeURIComponent(a.project)}&unit=${encodeURIComponent(a.unit)}`
      );
      const d = await resp.json();
      if (d.ok && Array.isArray(d.notifications)) {
        d.notifications.forEach(n => {
          seen.add([n.jobNo || '', n.unitNo || '', n.lineNo || '', n.revNo || ''].join('||'));
        });
      }
    }
    return seen.size;
  } catch { return 0; }
}

async function _fetchCheckerStreamCount() {
  try {
    const resp = await fetch('/api/notifications');
    const d = await resp.json();
    if (!d.ok || !Array.isArray(d.notifications)) return 0;
    return d.notifications.length;
  } catch { return 0; }
}

async function refreshSidebarBadges() {
  const streams = [
    { btnId: 'modeller-notif-btn', fn: () => _fetchRoleStreamCount('Modeller') },
    { btnId: 'checker-notif-btn',  fn: () => _fetchCheckerStreamCount() },
    { btnId: 'gl-notif-btn',       fn: () => _fetchRoleStreamCount('GL') },
    { btnId: 'sgl-notif-btn',      fn: () => _fetchRoleStreamCount('SGL') },
  ];
  for (const { btnId, fn } of streams) {
    const btn = document.getElementById(btnId);
    if (!btn || btn.style.display === 'none') continue;
    try {
      const count = await fn();
      _setBtnBadge(btn, count);
    } catch { /* ignore per-stream errors */ }
  }
}

window.refreshSidebarBadges = refreshSidebarBadges;

function generateRoleSpecificContent(notification, currentRole) {
  if (currentRole === "Modeller") {
    return `
      <td class="comment-info">
        ${Array.isArray(notification.commentTypes) &&
        notification.commentTypes.length
        ? notification.commentTypes.join(", ")
        : "No Comments"
      }
      </td>

      <td class="role-selection">
        <label class="role-checkbox-label">
          <input type="checkbox" class="role-claim-checkbox" data-role="Modeller" data-line="${notification.lineNo}">
          Modeller
        </label>
      </td>
    `;
  } else if (
  ["Process Checker", "Material Checker", "Stress Checker"].includes(
    currentRole
  ) ||
  currentRole === "Checker"
) {
  const roleCheckboxes = generateRoleCheckboxes(notification);
  return `
    <td class="role-selection">
      ${roleCheckboxes}
    </td>
  `;
}
 else if (currentRole === "GL") {
    const noCommentsFrom = Array.isArray(notification.noCommentsFrom) && notification.noCommentsFrom.length
      ? notification.noCommentsFrom.join(", ")
      : "—";
    return `
      <td class="comment-info">${noCommentsFrom}</td>
      <td class="role-selection">
        <label class="role-checkbox-label">
          <input type="checkbox" class="role-claim-checkbox" data-role="GL" data-line="${notification.lineNo}">
          GL
        </label>
      </td>
    `;
  } else if (currentRole === "SGL") {
    return `
      <td class="comment-info">
        ${Array.isArray(notification.commentTypes) &&
        notification.commentTypes.length
        ? notification.commentTypes.join(", ")
        : "No Comments"
      }
      </td>

      <td class="role-selection">
        <label class="role-checkbox-label">
          <input type="checkbox" class="role-claim-checkbox" data-role="SGL" data-line="${notification.lineNo}">
          SGL
        </label>
      </td>
    `;
  }

  return "<td></td>";
}


function setupRoleSpecificBehavior(row, notification, currentRole, index) {
  // By default, all role checkboxes disabled unless notification-select is ticked
  setTimeout(() => {
    const roleChks = row.querySelectorAll(
      ".role-claim-checkbox:not(:disabled)"
    );
    roleChks.forEach((chk) => (chk.disabled = true));
  }, 0);

  if (
    ["Process Checker", "Material Checker", "Stress Checker"].includes(
      currentRole
    ) ||
    currentRole === "Checker"
  ) {
    // Setup SC-PC dependency for checkers
    // Only run this if BOTH PC and SC checkboxes exist
    setTimeout(() => {
      const pcCheckbox = row.querySelector('.role-claim-checkbox[data-role="PC"]');
      const scCheckbox = row.querySelector('.role-claim-checkbox[data-role="SC"]');

      // Only apply PC-SC dependency when both checkboxes are present
      if (pcCheckbox && scCheckbox) {
        setupSCPCDependency(row);
      }
      // If only SC checkbox exists (PC already claimed), don't disable it
    }, 10);
  }
}


function updateNotificationTableHeaders(currentRole) {
  const thead = document.querySelector(
    "#default-notification-table-container .data-table thead tr"
  );
  if (!thead) return;

  // Base headers (Upload Type will be added separately for each role)
  const baseHeaders = [
    "Select",
    "Job No",
    "Unit no",
    "Line No",
    "Rev No",
    "Crit.",
    "From",
    "Date & Time"
  ];

  let additionalHeaders = [];

  if (currentRole === "Modeller") {
    additionalHeaders = ["Type", "Comment Received From", "Modeller"];
  } else if (
    ["Process Checker", "Material Checker", "Stress Checker"].includes(
      currentRole
    ) ||
    currentRole === "Checker"
  ) {
    additionalHeaders = ["Type", "Roles"];
  } else if (currentRole === "GL") {
    additionalHeaders = ["Type", "No Comments From", "GL"];
  } else if (currentRole === "SGL") {
    additionalHeaders = ["Type", "SGL"];
  }

  const allHeaders = [...baseHeaders, ...additionalHeaders];

  thead.innerHTML = allHeaders.map((header) =>
    header === "Select"
      ? `<th style="text-align:center;width:36px;"><input type="checkbox" id="notif-select-all" title="Select all" onchange="toggleSelectAllNotifications(this)"></th>`
      : `<th>${header}</th>`
  ).join("");



  // Add search input after headers with correct positioning
  addSearchInputToTable(currentRole, "notification");
}

// Function to add search input above table headers
function addSearchInputToTable(currentRole, tableType = "notification") {
  // Both table types already have a real search box in the static HTML
  // (the "Search notifications…"/"Search tasks…" pill in the panel header) —
  // inserting another one here would duplicate its id, so the new box's
  // listener never actually attaches (getElementById always resolves to the
  // first match, i.e. the original one), leaving a dead, non-functional
  // second search input sitting above the table. Skip creating it, but still
  // wire up the listener on the existing static box below — this function
  // was the only place that ever called setupTableSearch().
  setupTableSearch(tableType);
}

// Function to setup search functionality
function setupTableSearch(tableType = "notification") {
  const searchInput = document.getElementById(
    `${tableType}-table-search-input`
  );
  const clearBtn = document.getElementById(`clear-${tableType}-search-btn`);

  if (searchInput) {
    // Real-time search on every keystroke with debouncing for performance
    let searchTimeout;
    searchInput.addEventListener("input", function () {
      const searchTerm = this.value.toLowerCase().trim();

      // Clear previous timeout
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }

      // Add slight delay to prevent excessive filtering on very fast typing
      searchTimeout = setTimeout(() => {
        filterTableRows(searchTerm, tableType);
        updateSearchStats(searchTerm, tableType);
      }, 150);
    });

    // Also filter on paste events
    searchInput.addEventListener("paste", function () {
      setTimeout(() => {
        const searchTerm = this.value.toLowerCase().trim();
        filterTableRows(searchTerm, tableType);
        updateSearchStats(searchTerm, tableType);
      }, 100);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      const searchInput = document.getElementById(
        `${tableType}-table-search-input`
      );
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
        filterTableRows("", tableType);
        updateSearchStats("", tableType);
      }
    });
  }
}

function updateSearchStats(searchTerm, tableType) {
  const searchInput = document.getElementById(
    `${tableType}-table-search-input`
  );
  if (!searchInput) return;

  const searchContainer = searchInput.closest(".search-input-container");
  if (!searchContainer) return;

  // Remove existing stats
  const existingStats = searchContainer.querySelector(".search-stats");
  if (existingStats) {
    existingStats.remove();
  }

  if (searchTerm.trim() !== "") {
    const tableSelector =
      tableType === "notification"
        ? "#default-notification-table-container .data-table tbody tr"
        : "#default-task-table-container .data-table tbody tr";

    const allRows = document.querySelectorAll(tableSelector);
    const visibleRows = document.querySelectorAll(
      `${tableSelector}:not([style*="display: none"])`
    );

    // Filter out "no data" rows
    const totalRows = Array.from(allRows).filter(
      (row) => !row.querySelector(".no-data")
    ).length;
    const visibleCount = Array.from(visibleRows).filter(
      (row) => !row.querySelector(".no-data")
    ).length;

    const statsDiv = document.createElement("div");
    statsDiv.className = "search-stats";
    statsDiv.style.cssText = `
      margin-top: 8px;
      font-size: 12px;
      color: #6c757d;
      font-style: italic;
    `;

    if (visibleCount === 0) {
      statsDiv.innerHTML = `<span style="color: #dc3545;">No results found for "${searchTerm}" (0 of ${totalRows} ${tableType}s)</span>`;
    } else {
      statsDiv.innerHTML = `Showing ${visibleCount} of ${totalRows} ${tableType}s matching "${searchTerm}"`;
    }

    searchContainer.appendChild(statsDiv);
  }
}

// Function to filter table rows based on search term
function filterTableRows(searchTerm, tableType = "notification") {
  const tableSelector =
    tableType === "notification"
      ? "#default-notification-table-container .data-table tbody"
      : "#default-task-table-container .data-table tbody";

  const currentTable = document.querySelector(tableSelector);

  if (!currentTable) return;

  const rows = currentTable.querySelectorAll("tr");
  let visibleCount = 0;
  let totalCount = 0;

  rows.forEach((row) => {
    // Skip "no data" rows
    if (row.querySelector(".no-data")) {
      return;
    }

    totalCount++;

    if (searchTerm === "") {
      row.style.display = "";
      visibleCount++;
      removeHighlightFromRow(row);
      return;
    }

    // Build searchable text from all cells
    let rowText = "";
    const cells = row.querySelectorAll("td");

    cells.forEach((cell) => {
      // Get text content, including nested elements but excluding HTML
      const textContent = cell.textContent || cell.innerText || "";
      rowText += textContent.toLowerCase() + " ";

      // Also include any input values (like employee IDs in form fields)
      const inputs = cell.querySelectorAll('input[type="text"]');
      inputs.forEach((input) => {
        rowText += (input.value || "").toLowerCase() + " ";
      });
    });

    // Check if search term matches
    const isMatch = rowText.includes(searchTerm);

    if (isMatch) {
      row.style.display = "";
      visibleCount++;
      // Optional: highlight matching text
      highlightSearchTermInRow(row, searchTerm);
    } else {
      row.style.display = "none";
      removeHighlightFromRow(row);
    }
  });

}

// Optional: Highlight matching text in rows
function highlightSearchTermInRow(row, searchTerm) {
  if (searchTerm.length < 2) return; // Don't highlight very short terms

  const cells = row.querySelectorAll("td");
  cells.forEach((cell) => {
    if (
      cell.querySelector("input") ||
      cell.querySelector("button") ||
      cell.querySelector(".role-checkbox-label")
    ) {
      return; // Skip cells with interactive elements
    }

    const originalText = cell.textContent;
    if (originalText.toLowerCase().includes(searchTerm)) {
      const regex = new RegExp(`(${escapeRegExp(searchTerm)})`, "gi");
      const highlightedText = originalText.replace(
        regex,
        '<mark style="background-color: #fff3cd; padding: 1px 2px; border-radius: 2px;">$1</mark>'
      );
      cell.innerHTML = highlightedText;
    }
  });
}

// Helper function to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Remove highlights from row
function removeHighlightFromRow(row) {
  const marks = row.querySelectorAll("mark");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
}

let _notifActiveFilters = {};

function closeAllFilterPanels() {
  document.querySelectorAll(".col-filter-panel").forEach(p => { p.style.display = "none"; });
  document.querySelectorAll(".col-filter-btn.open").forEach(b => b.classList.remove("open"));
}

function setupTableFilters(notifications) {
  const thead = document.querySelector(
    "#default-notification-table-container .data-table thead tr"
  );
  if (!thead) return;

  // Remove previous filter UI
  thead.querySelectorAll(".col-filter-btn").forEach(b => b.remove());
  document.querySelectorAll(".col-filter-panel[data-notif-filter]").forEach(p => p.remove());
  _notifActiveFilters = {};

  const filterDefs = [
    { idx: 1, key: "jobNo" },
    { idx: 2, key: "unitNo" },
    { idx: 4, key: "revNo" },
    { idx: 5, key: "stressCritical" },
    { idx: 8, staticVals: ["Manual", "System Upload"] },
  ];
  const _curRole = window.currentSelectedRole?.role || "";
  const _isChecker = ["Process Checker", "Material Checker", "Stress Checker", "Checker"].includes(_curRole);
  if (_isChecker && thead.children[9]) {
    filterDefs.push({ idx: 9, staticVals: ["PC", "MC", "SC"] });
  }

  filterDefs.forEach(({ idx, key, staticVals }) => {
    const th = thead.children[idx];
    if (!th) return;

    let vals = staticVals;
    if (!vals) {
      vals = Array.from(new Set(
        notifications.map(n => {
          const v = key === "uploadType" ? (n[key] || "Manual") : n[key];
          return String(v || "").split("-")[0];
        }).filter(Boolean)
      ));
    }

    // Small funnel icon button inside th
    const btn = document.createElement("button");
    btn.className = "col-filter-btn";
    btn.dataset.filterCol = idx;
    btn.title = "Filter";
    btn.innerHTML = `<svg viewBox="0 0 10 9" fill="currentColor"><path d="M0 0h10L6.5 4.5V9l-3-1.5V4.5z"/></svg>`;
    th.appendChild(btn);

    // Floating panel appended to body (escapes overflow:auto clipping)
    const panel = document.createElement("div");
    panel.className = "col-filter-panel";
    panel.dataset.notifFilter = "1";
    panel.dataset.filterCol = idx;
    panel.style.display = "none";

    [{ label: "All", value: "" }, ...vals.map(v => ({ label: v, value: v }))]
      .forEach(({ label, value }) => {
        const opt = document.createElement("div");
        opt.className = "col-filter-option" + (value === "" ? " selected" : "");
        opt.dataset.value = value;
        opt.textContent = label;
        panel.appendChild(opt);
      });
    document.body.appendChild(panel);

    btn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = panel.style.display !== "none";
      closeAllFilterPanels();
      if (!isOpen) {
        const rect = btn.getBoundingClientRect();
        panel.style.top = (rect.bottom + 2) + "px";
        panel.style.left = rect.left + "px";
        panel.style.display = "block";
        btn.classList.add("open");
      }
    });

    panel.addEventListener("click", e => {
      const opt = e.target.closest(".col-filter-option");
      if (!opt) return;
      const val = opt.dataset.value;
      _notifActiveFilters[idx] = val;
      panel.querySelectorAll(".col-filter-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      btn.classList.toggle("active", val !== "");
      closeAllFilterPanels();
      filterNotificationsTable();
    });
  });

  if (!window._notifFilterCloseListenerAdded) {
    document.addEventListener("click", closeAllFilterPanels);
    window._notifFilterCloseListenerAdded = true;
  }
}

// Helper for table filtering
function filterNotificationsTable() {
  const table = document.querySelector(
    "#default-notification-table-container .data-table"
  );
  if (!table) return;
  const tbody = table.querySelector("tbody");
  if (!tbody) return;

  const rows = tbody.querySelectorAll("tr");
  rows.forEach(row => {
    let show = true;
    Object.entries(_notifActiveFilters).forEach(([colIdxStr, val]) => {
      if (!val) return;
      const colIdx = parseInt(colIdxStr);
      const cell = row.children[colIdx];
      if (!cell) return;
      const cellText = cell.textContent.trim();
      if (colIdx === 9) {
        if (!cellText.includes(val)) show = false;
      } else {
        if (!cellText.startsWith(val)) show = false;
      }
    });
    row.style.display = show ? "" : "none";
  });
}

function generateRoleCheckboxes(notification) {
  if (!currentUser || !notification.userRoles) return "";

  const userRoles = notification.userRoles; // Use roles from notification (from backend)
  const stressCritical = notification.stressCritical === "Y";
  const claimedRoles = notification.claimedRoles || [];

  let checkboxes = "";

  // Check if user has all 3 roles
  const hasAllThreeRoles = [
    "Process Checker",
    "Material Checker",
    "Stress Checker",
  ].every((role) => userRoles.includes(role));

  // Check if PC is already claimed by someone else
  const pcAlreadyClaimed = claimedRoles.includes("PC");

  // Process Checker
  if (userRoles.includes("Process Checker") && !claimedRoles.includes("PC")) {
    checkboxes += `
      <label class="role-checkbox-label">
        <input type="checkbox" class="role-claim-checkbox" data-role="PC" data-line="${notification.lineNo}">
        PC
      </label>
    `;
  }

  // Material Checker
  if (userRoles.includes("Material Checker") && !claimedRoles.includes("MC")) {
    checkboxes += `
      <label class="role-checkbox-label">
        <input type="checkbox" class="role-claim-checkbox" data-role="MC" data-line="${notification.lineNo}">
        MC
      </label>
    `;
  }

  // Stress Checker logic - UPDATED PHILOSOPHY
  if (userRoles.includes("Stress Checker") && !claimedRoles.includes("SC")) {

    console.log("DEBUG SC CHECK:", notification.lineNo, {
      stressCritical: notification.stressCritical,
      scTagged: notification.scTagged,
      status: notification.status,
      claimedRoles: notification.claimedRoles,
      userRoles: notification.userRoles,
    });

    let showSC = false;
    let disabled = "";

    if (!stressCritical) {
      // Non-stress critical
      if (hasAllThreeRoles) {
        if (!pcAlreadyClaimed) {
          // Fresh line: SC shown alongside PC but starts disabled until PC is ticked
          showSC = true;
          disabled = "disabled";
        } else {
          // PC/MC already claimed (by this user or anyone) — SC now stands alone
          showSC = true;
        }
      } else {
        // Pure SC, SC+MC, SC+PC (without all three): can claim SC directly
        showSC = true;
      }
    } else {
      // Stress critical: SC stays hidden until the line has actually been
      // released for supporting check (PC no-comment auto-route, or explicit
      // Good for Supporting) — matches backend's shouldShowToChecker gate.
      // Applies regardless of role combination, including all-three-role users:
      // by the time status flips, PC's own claim row already exists (completed
      // via no-comment, or left open via Good for Supporting) and is excluded
      // from checkboxes via claimedRoles already — so PC and SC are never
      // offered as simultaneous fresh choices here, unlike the non-critical
      // hasAllThreeRoles case above, which needs the PC/SC coupling because
      // both appear together on a completely fresh line.
      if (notification.status === "Sent for Supporting Check") {
        showSC = true;
      }
    }

    if (showSC) {
      checkboxes += `
        <label class="role-checkbox-label">
          <input type="checkbox" class="role-claim-checkbox" data-role="SC" data-line="${notification.lineNo}" ${disabled}>
          SC
        </label>
      `;
    }
  }

  return checkboxes;
}

// Handle row selection - automatically tick available role checkboxes
function handleRowSelection(checkbox) {
  const row = checkbox.closest('tr');

  // Select all role-claim-checkbox, whether disabled or not
  const roleCheckboxes = row.querySelectorAll('.role-claim-checkbox');

  if (checkbox.checked) {
    row.classList.add('active-row');

    // Enable and check role checkboxes
    roleCheckboxes.forEach(roleCheckbox => {
      if (!roleCheckbox.hasAttribute('data-always-disabled')) {
        roleCheckbox.disabled = false;
        roleCheckbox.checked = true; // Default ticked
      }
    });

    // Setup SC-PC dependency for non-critical lines
    // Only run this if BOTH PC and SC checkboxes exist
    const pcCheckbox = row.querySelector('.role-claim-checkbox[data-role="PC"]');
    const scCheckbox = row.querySelector('.role-claim-checkbox[data-role="SC"]');

    // Only apply PC-SC dependency when both checkboxes are present
    if (pcCheckbox && scCheckbox) {
      setupSCPCDependency(row);
    }
    // If only SC checkbox exists (PC already claimed), leave SC enabled and checked
  } else {
    row.classList.remove('active-row');

    // Disable and uncheck role checkboxes
    roleCheckboxes.forEach(roleCheckbox => {
      if (!roleCheckbox.hasAttribute('data-always-disabled')) {
        roleCheckbox.checked = false;
        roleCheckbox.disabled = true;
      }
    });
  }

  syncSelectAllCheckbox();
  updateSelectedNotifCount();
}

// Shows/hides a "(N selected)" chip next to "Claim Selected" — covers every
// notification table (Checker/Modeller/GL/SGL all render through this same
// markup), since otherwise there's no indication of how many rows you've
// picked once more than one or two are selected.
function updateSelectedNotifCount() {
  const countEl = document.getElementById('notif-selected-count');
  if (!countEl) return;
  const checkedCount = document.querySelectorAll(
    '#default-notification-table-container .notification-select:checked'
  ).length;
  if (checkedCount === 0) {
    countEl.style.display = 'none';
  } else {
    countEl.textContent = `${checkedCount} selected`;
    countEl.style.display = '';
  }
}

// Header "select all" checkbox — ticks/unticks every row in the notification
// table by driving each row through handleRowSelection() (not just toggling
// the box), so the same role-checkbox enabling/PC-SC dependency logic that
// runs for a manual click also runs here. Shared by checker/modeller/GL/SGL —
// they all render through this same table, just with a different role column.
function toggleSelectAllNotifications(masterCheckbox) {
  // Capture the desired state once — handleRowSelection() calls
  // syncSelectAllCheckbox() per row, which overwrites masterCheckbox.checked
  // mid-loop (it sees "not all rows checked yet" after just the first row and
  // flips it back). Reading masterCheckbox.checked fresh on every iteration
  // would mean every row after the first inherits that already-reset value.
  const desiredState = masterCheckbox.checked;
  const rowCheckboxes = document.querySelectorAll(
    '#default-notification-table-container .notification-select'
  );
  rowCheckboxes.forEach((cb) => {
    cb.checked = desiredState;
    handleRowSelection(cb);
  });
  masterCheckbox.checked = desiredState;
}

// Keep the header checkbox reflecting reality: checked only when every row is
// checked, so an individual uncheck after a "select all" doesn't leave the
// header showing a stale "all selected" state.
function syncSelectAllCheckbox() {
  const master = document.getElementById('notif-select-all');
  if (!master) return;
  const rowCheckboxes = document.querySelectorAll(
    '#default-notification-table-container .notification-select'
  );
  master.checked = rowCheckboxes.length > 0 &&
    Array.from(rowCheckboxes).every((cb) => cb.checked);
}


// Setup SC-PC dependency for non-critical lines
function setupSCPCDependency(row) {
  const index = row.getAttribute("data-index");
  if (!window.notificationsData || !window.notificationsData[index]) return;

  const notification = window.notificationsData[index];
  const stressCritical = notification.stressCritical === "Y";
  const claimedRoles = notification.claimedRoles || [];
  const pcAlreadyClaimed = claimedRoles.includes("PC");

  // Only apply dependency for non-critical lines and when PC is not already claimed
  if (!stressCritical && !pcAlreadyClaimed) {
    const pcCheckbox = row.querySelector(
      '.role-claim-checkbox[data-role="PC"]'
    );
    const scCheckbox = row.querySelector(
      '.role-claim-checkbox[data-role="SC"]'
    );

    if (pcCheckbox && scCheckbox) {
      // Add event listeners for PC-SC dependency
      pcCheckbox.addEventListener("change", function () {
        if (!this.checked) {
          // If PC is unchecked, uncheck and disable SC
          scCheckbox.checked = false;
          scCheckbox.disabled = true;
        } else {
          // If PC is checked, enable SC (only for users who can claim both)
          scCheckbox.disabled = false;
        }
      });

      // Initially disable SC if PC is not checked
      if (!pcCheckbox.checked) {
        scCheckbox.checked = false;
        scCheckbox.disabled = true;
      }
    }
  }

  // If PC is already claimed by someone else, SC should be permanently disabled
  if (pcAlreadyClaimed) {
    const scCheckbox = row.querySelector(
      '.role-claim-checkbox[data-role="SC"]'
    );
    if (scCheckbox) {
      scCheckbox.disabled = true;
      scCheckbox.checked = false;
      scCheckbox.setAttribute("data-always-disabled", "true");
    }
  }
}

function setupClaimButton() {
  const claimBtn = document.querySelector(
    "#default-notification-table-container #accept-btn"
  );
  if (!claimBtn) return;

  // ISO Manager sees the GL pool read-only — cannot claim lines
  if (window.currentSelectedRole?.role === 'ISO Manager') {
    claimBtn.style.display = 'none';
    return;
  }

  claimBtn.style.display = '';
  // Use onclick to prevent duplicate listeners from multiple setupClaimButton() calls
  claimBtn.onclick = async function () {
    await processNotificationClaims();
  };
}

async function processNotificationClaims() {
  const selectedRows = document.querySelectorAll(
    ".notification-select:checked"
  );

  if (selectedRows.length === 0) {
    alert("Please select at least one notification to claim.");
    return;
  }

  const claims = [];

  selectedRows.forEach((checkbox) => {
    const index = parseInt(checkbox.getAttribute("data-index"));
    const row = checkbox.closest("tr");
    const selectedRoles = [];

    // Get selected roles for this row
    const roleCheckboxes = row.querySelectorAll(".role-claim-checkbox:checked");
    roleCheckboxes.forEach((roleCheckbox) => {
      selectedRoles.push(roleCheckbox.getAttribute("data-role"));
    });

    if (
      selectedRoles.length > 0 &&
      window.notificationsData &&
      window.notificationsData[index]
    ) {
      // Build a fully-scoped claim so backend knows which project/unit to update
      const notif = window.notificationsData[index];
      claims.push({
        drawingId: notif.drawingId,
        jobNo: notif.jobNo,
        unitNo: notif.unitNo,
        lineNo: notif.lineNo,
        revNo: notif.revNo,
        uploadCount: notif.uploadCount, // <-- new
        assignmentProject: notif.assignmentProject || notif.jobNo,
        assignmentUnit: notif.assignmentUnit || notif.unitNo,
        roles: selectedRoles,
      });
    }
  });

  if (claims.length === 0) {
    alert("Please select roles to claim for the selected notifications.");
    return;
  }

  try {
    const response = await fetch("/api/claim-notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claims }),
    });

    const result = await response.json();

    if (result.ok) {
      // Remove all claimed rows immediately from the notification table
      selectedRows.forEach((cb) => {
        const row = cb.closest("tr");
        if (row) row.remove();
      });

      // Refresh notification table from server using the correct role pool
      try {
        const activeRole = window.currentSelectedRole && window.currentSelectedRole.role;
        if (activeRole === "GL" || activeRole === "SGL" || activeRole === "Modeller") {
          await loadNotificationsForMainRole(activeRole);
        } else {
          await loadCheckerNotifications();
        }
      } catch (err) {
        console.warn("Failed to refresh notifications after claim:", err);
      }

      // Update My Tasks badge count
      try {
        const tasksResp = await fetch("/api/my-claimed-tasks");
        const tasksData = await tasksResp.json();
        const badge = document.getElementById("inboxBadge");
        if (badge && tasksData.ok) badge.textContent = tasksData.tasks.length || "";
      } catch (err) {
        console.warn("Failed to update tasks badge:", err);
      }

      alert(`${claims.length} line(s) claimed and moved to My Tasks.`);
    }
  } catch (error) {
    console.error("Error claiming notifications:", error);
    alert("Failed to process claims. Please try again.");
  }
}

function shouldRemoveNotificationRow(notification, claimedRoles) {
  const stressCritical = notification.stressCritical === "Y";
  const allClaimedRoles = [
    ...(notification.claimedRoles || []),
    ...claimedRoles,
  ];
  const uniqueClaimedRoles = [...new Set(allClaimedRoles)];

  if (!stressCritical) {
    // Non-stress critical: Remove if all 3 roles claimed OR if PC+MC claimed (SC rule applies)
    const hasAllThree = ["PC", "MC", "SC"].every((role) =>
      uniqueClaimedRoles.includes(role)
    );
    const hasPCAndMC =
      uniqueClaimedRoles.includes("PC") && uniqueClaimedRoles.includes("MC");

    return hasAllThree || hasPCAndMC;
  } else {
    // Stress-critical: remove if all 3 roles claimed
    // Also remove if PC+MC claimed and SC is tagged (via PC no-comments)
    const hasAllThree = ["PC", "MC", "SC"].every((r) =>
      uniqueClaimedRoles.includes(r)
    );
    const hasPCAndMC =
      uniqueClaimedRoles.includes("PC") && uniqueClaimedRoles.includes("MC");
    if (notification.scTagged) {
      return hasAllThree || hasPCAndMC;
    }
    return hasAllThree;
  }
}

async function loadMyTasksData() {
  // Load tasks data - placeholder for now
  const tableContainer = document.querySelector(
    "#default-task-table-container .data-table tbody"
  );
  if (!tableContainer) return;

  tableContainer.innerHTML =
    '<tr><td colspan="9" class="no-data">No tasks available</td></tr>';
}

async function loadClaimedTasksData() {
  // All roles now fetch their claimed tasks from /api/my-claimed-tasks
  const response = await fetch("/api/my-claimed-tasks");
  const data = await response.json();

  if (data.ok) {
    renderUniversalTasksTable(data.tasks);
    const badge = document.getElementById('inboxBadge');
    if (badge) badge.textContent = data.tasks.length || '';
  } else {
    console.error("Failed to load claimed tasks:", data.error);
    const tableContainer = document.querySelector(
      "#default-task-table-container .data-table tbody"
    );
    if (tableContainer) {
      tableContainer.innerHTML =
        '<tr><td colspan="9" class="no-data">Failed to load tasks</td></tr>';
    }
  }
}


function renderClaimedTasksTable(tasks, currentRole = "Process Checker") {
  const tableContainer = document.querySelector(
    "#default-task-table-container .data-table tbody"
  );
  if (!tableContainer) return;

  // Update table headers for tasks
  updateTaskTableHeaders(currentRole);

  // Clear existing rows
  tableContainer.innerHTML = "";

  if (tasks.length === 0) {
    const colspan = currentRole === "Modeller" ? 9 : 8;
    tableContainer.innerHTML = `<tr><td colspan="${colspan}" class="no-data">No claimed tasks available</td></tr>`;
    return;
  }

  tasks.forEach((task, index) => {
    const row = document.createElement("tr");

    // Generate role-specific task row
    const taskRowContent = generateTaskRowContent(task, currentRole);
    row.innerHTML = taskRowContent;

    tableContainer.appendChild(row);
  });
}

// ── My Tasks sort helpers ────────────────────────────────────────────────────

/* Apply the user's saved sort preference.
   Role rank is always the primary key so SGL/GL/Checker/Modeller stay grouped.
   The user's choice is the secondary key within each group. */
function _applyTaskSort(tasks) {
  const field = localStorage.getItem('taskSortField') || 'date';
  const dir   = localStorage.getItem('taskSortDir')   || 'desc';
  const mult  = dir === 'asc' ? 1 : -1;

  return [...tasks].sort((a, b) => {
    const rankDiff = getTaskRank(a) - getTaskRank(b);
    if (rankDiff !== 0) return rankDiff;

    switch (field) {
      case 'jobNo':
        return mult * (a.jobNo  || '').localeCompare(b.jobNo  || '');
      case 'unitNo':
        return mult * (a.unitNo || '').localeCompare(b.unitNo || '');
      case 'lineNo':
        return mult * (a.lineNo || '').localeCompare(b.lineNo || '');
      case 'revNo': {
        const va = parseInt((a.revNo || 'R0').replace(/\D/g, ''), 10) || 0;
        const vb = parseInt((b.revNo || 'R0').replace(/\D/g, ''), 10) || 0;
        return mult * (va - vb);
      }
      case 'crit': {
        const va = a.stressCritical === 'Y' ? 1 : 0;
        const vb = b.stressCritical === 'Y' ? 1 : 0;
        return mult * (vb - va); // Y first when asc
      }
      default: { // date
        const ta = new Date(a.claimedOn || a.uploadedOn || 0).getTime();
        const tb = new Date(b.claimedOn || b.uploadedOn || 0).getTime();
        return mult * (tb - ta); // newest first when desc
      }
    }
  });
}

let _sortBarListenersAttached = false;

/* Sync the sort bar UI to localStorage values and attach listeners once. */
function _initTaskSortBar() {
  const fieldSel = document.getElementById('task-sort-field');
  const dirBtn   = document.getElementById('task-sort-dir');
  if (!fieldSel || !dirBtn) return;

  // Always sync UI state to saved preference
  const savedField = localStorage.getItem('taskSortField') || 'date';
  const savedDir   = localStorage.getItem('taskSortDir')   || 'desc';
  fieldSel.value     = savedField;
  dirBtn.textContent = savedDir === 'asc' ? '↑' : '↓';
  dirBtn.dataset.dir = savedDir;

  if (_sortBarListenersAttached) return;
  _sortBarListenersAttached = true;

  fieldSel.addEventListener('change', function () {
    localStorage.setItem('taskSortField', this.value);
    if (window._lastTasksData) renderUniversalTasksTable(window._lastTasksData);
  });

  dirBtn.addEventListener('click', function () {
    const next        = (this.dataset.dir || 'desc') === 'desc' ? 'asc' : 'desc';
    this.dataset.dir  = next;
    this.textContent  = next === 'asc' ? '↑' : '↓';
    localStorage.setItem('taskSortDir', next);
    if (window._lastTasksData) renderUniversalTasksTable(window._lastTasksData);
  });
}

// ── Task precedence rank ─────────────────────────────────────────────────────

// Helper to compute precedence rank for My Tasks
function getTaskRank(task) {
  const roles = task.claimedRoles || [];
  const roleType = task.roleType || "";

  // Explicit SGL / GL
  if (roleType === "SGL" || roles.includes("SGL")) return 0;
  if (roleType === "GL" || roles.includes("GL")) return 1;

  // Checkers (PC/MC/SC)
  if (
    roleType === "Checker" ||
    roles.some((r) => ["PC", "MC", "SC"].includes(r))
  ) {
    const checkerRoles = roles.filter((r) => ["PC", "MC", "SC"].includes(r));
    const count = checkerRoles.length;
    if (count === 3) return 2;
    if (count === 2) return 3;
    if (count === 1) return 4;
  }

  // Modeller
  if (roleType === "Modeller" || roles.includes("Modeller")) return 5;

  return 99; // fallback
}

function renderUniversalTasksTable(tasks) {
  const tableContainer = document.querySelector(
    "#default-task-table-container .data-table tbody"
  );
  if (!tableContainer) return;

  // Update table headers for universal view
  updateUniversalTaskTableHeaders();

  // Clear existing rows
  tableContainer.innerHTML = "";

  if (tasks.length === 0) {
    tableContainer.innerHTML = `<tr><td colspan="9" class="no-data">No claimed tasks available</td></tr>`;
    recomputeTasksSummaryFromVisibleRows();
    return;
  }

  // Store for re-sort when user changes sort preference
  window._lastTasksData = tasks;

  // Sort: role rank primary, user preference secondary
  const sorted = _applyTaskSort(tasks);

  sorted.forEach((task, index) => {
    const row = document.createElement("tr");
    row.style.cursor = "pointer";
    row.title = "Click to review this line";
    row.dataset.jobNo  = task.jobNo;
    row.dataset.lineNo = task.lineNo;
    row.dataset.unitNo = task.unitNo;
    row.dataset.roles  = JSON.stringify(Array.isArray(task.claimedRoles) ? task.claimedRoles : []);

    // Generate universal task row content
    const taskRowContent = generateUniversalTaskRowContent(task);
    row.innerHTML = taskRowContent;

    row.addEventListener("click", function () {
      const roles = Array.isArray(task.claimedRoles) ? task.claimedRoles : [];

      // Map each claimed role to its review panel
      const panelMap = { SGL: 'sgl', GL: 'gl', Modeller: 'modeller', PC: 'checker', MC: 'checker', SC: 'checker' };
      const panels = [...new Set(roles.map(r => panelMap[r]).filter(Boolean))];

      // Multi-panel task: let user choose which role to act as
      if (panels.length > 1 && typeof window.showRolePicker === 'function') {
        window.showRolePicker(task, panels);
        return;
      }

      // Single-role task — exact same behavior as before
      const isGL       = roles.includes("GL");
      const isSGL      = roles.includes("SGL");
      const isModeller = roles.includes("Modeller");
      if (isSGL && typeof openSGLReviewPanel === "function") {
        openSGLReviewPanel(task);
      } else if (isGL && typeof openGLReviewPanel === "function") {
        openGLReviewPanel(task);
      } else if (isModeller && typeof openModellerReviewPanel === "function") {
        openModellerReviewPanel(task);
      } else if (typeof openCheckerReviewPanel === "function") {
        openCheckerReviewPanel(task);
      }
    });

    tableContainer.appendChild(row);
  });

  // Add search input for universal task table
  addSearchInputToTable("universal", "task");

  // Setup filters for universal task table
  setupUniversalTaskFilters(tasks);

  // Sync sort bar UI and attach listeners (idempotent)
  _initTaskSortBar();

  // "My Tasks" is one unified list across all roles — this breaks the total
  // down by role (a task with multiple claimed roles, e.g. a Modeller+PC+MC+SC
  // user, counts once in every bucket it genuinely belongs to) so Modeller/
  // Checker/GL/SGL each have visibility into how many of their own tasks are
  // sitting in the combined list, mirroring the notification pool's summary
  // chip. Computed from the rendered rows (not the raw `tasks` array) so the
  // exact same function also works after a column filter hides some of them.
  recomputeTasksSummaryFromVisibleRows();
}

function updateUniversalTaskTableHeaders() {
  const thead = document.querySelector(
    "#default-task-table-container .data-table thead tr"
  );
  if (!thead) return;

  const headers = [
    "Job No",
    "Unit no",
    "Line No",
    "Rev No",
    "Crit.",
    "From",
    "Date & Time Claimed",
    "Assigned By",
    "Claimed Roles",
  ];

  thead.innerHTML = headers.map((header) => `<th>${header}</th>`).join("");
}

function generateUniversalTaskRowContent(task) {
  const baseContent = `
    <td>${task.jobNo}</td>
    <td>${task.unitNo}</td>
    <td>${task.lineNo}${lotBadgeHtml(task.plannedLotNumber, task.jobNo, task.unitNo)}${typeof renderTagPills === 'function' ? renderTagPills(task.tags || []) : ''}</td>
    <td>${task.revNo}${task.uploadCount ? "-" + task.uploadCount : ""}</td>
    <td>${task.stressCritical}</td>
    <td>${task.from}</td>
    <td>${formatDateTime(task.claimedOn)}</td>
    <td>${getAssignedByDisplay(task)}</td>
    <td class="claimed-roles">
      ${generateUniversalClaimedRolesDisplay(task.claimedRoles, task.roleType)}
    </td>
  `;

  return baseContent;
}

function getAssignedByDisplay(task) {
  return task.assignedBy || 'Self';
}



function generateUniversalClaimedRolesDisplay(claimedRoles, roleType) {
  if (!claimedRoles) return "";

  let rolesDisplay = "";

  if (Array.isArray(claimedRoles)) {
    claimedRoles.forEach((role) => {
      rolesDisplay += `
        <label class="role-checkbox-label claimed" onclick="handleRoleClick('${role}', this)" style="cursor: pointer;">
          <input type="checkbox" checked disabled style="pointer-events: none;">
          ${role}
        </label>
      `;
    });
  } else if (roleType) {
    rolesDisplay = `
      <label class="role-checkbox-label claimed" onclick="handleRoleClick('${roleType}', this)" style="cursor: pointer;">
        <input type="checkbox" checked disabled style="pointer-events: none;">
        ${roleType}
      </label>
    `;
  }

  return rolesDisplay;
}

function updateTaskTableHeaders(currentRole) {
  const thead = document.querySelector(
    "#default-task-table-container .data-table thead tr"
  );
  if (!thead) return;

  let headers = [
    "Job No",
    "Unit no",
    "Line No",
    "Rev No",
    "Crit.",
    "From",
    "Date & Time Claimed",
  ];

  if (currentRole === "Modeller") {
    headers.push("Comment Received From", "Claimed As");
  } else if (currentRole === "GL") {
    headers.push("No Comments From", "Claimed As");
  } else if (currentRole === "SGL") {
    headers.push("Claimed As");
  } else {
    headers.push("Claimed Roles");
  }

  thead.innerHTML = headers.map((header) => `<th>${header}</th>`).join("");

  // Add search input for task table
  addSearchInputToTable(currentRole, "task");
}

function setupUniversalTaskFilters(tasks) {
  const thead = document.querySelector(
    "#default-task-table-container .data-table thead tr"
  );
  if (!thead) return;

  thead.querySelectorAll(".col-filter-btn").forEach(b => b.remove());
  document.querySelectorAll(".col-filter-panel[data-task-filter]").forEach(p => p.remove());
  _taskActiveFilters = {};

  const filterDefs = [
    { idx: 0, key: "jobNo" },
    { idx: 1, key: "unitNo" },
    { idx: 3, key: "revNo" },
    { idx: 4, staticVals: ["Y", "N"] },
    { idx: 5, key: "from" },
    { idx: 8, staticVals: ["PC", "MC", "SC", "Modeller", "GL", "SGL"] },
  ];

  filterDefs.forEach(({ idx, key, staticVals }) => {
    const th = thead.children[idx];
    if (!th) return;

    let vals = staticVals;
    if (!vals) {
      vals = Array.from(new Set(
        tasks.map(t => String(t[key] || "").split("-")[0]).filter(Boolean)
      ));
    }

    const btn = document.createElement("button");
    btn.className = "col-filter-btn";
    btn.dataset.filterCol = idx;
    btn.title = "Filter";
    btn.innerHTML = `<svg viewBox="0 0 10 9" fill="currentColor"><path d="M0 0h10L6.5 4.5V9l-3-1.5V4.5z"/></svg>`;
    th.appendChild(btn);

    const panel = document.createElement("div");
    panel.className = "col-filter-panel";
    panel.dataset.taskFilter = "1";
    panel.dataset.filterCol = idx;
    panel.style.display = "none";

    [{ label: "All", value: "" }, ...vals.map(v => ({ label: v, value: v }))]
      .forEach(({ label, value }) => {
        const opt = document.createElement("div");
        opt.className = "col-filter-option" + (value === "" ? " selected" : "");
        opt.dataset.value = value;
        opt.textContent = label;
        panel.appendChild(opt);
      });
    document.body.appendChild(panel);

    btn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = panel.style.display !== "none";
      closeAllFilterPanels();
      if (!isOpen) {
        const rect = btn.getBoundingClientRect();
        panel.style.top = (rect.bottom + 2) + "px";
        panel.style.left = rect.left + "px";
        panel.style.display = "block";
        btn.classList.add("open");
      }
    });

    panel.addEventListener("click", e => {
      const opt = e.target.closest(".col-filter-option");
      if (!opt) return;
      const val = opt.dataset.value;
      _taskActiveFilters[idx] = val;
      panel.querySelectorAll(".col-filter-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      btn.classList.toggle("active", val !== "");
      closeAllFilterPanels();
      filterUniversalTasksTable();
    });
  });

  if (!window._taskFilterCloseListenerAdded) {
    document.addEventListener("click", closeAllFilterPanels);
    window._taskFilterCloseListenerAdded = true;
  }
}

function filterUniversalTasksTable() {
  const tbody = document.querySelector(
    "#default-task-table-container .data-table tbody"
  );
  if (!tbody) return;
  tbody.querySelectorAll("tr").forEach(row => {
    if (row.querySelector(".no-data")) return;
    let show = true;
    Object.entries(_taskActiveFilters).forEach(([colIdxStr, val]) => {
      if (!val) return;
      const colIdx = parseInt(colIdxStr);
      const cell = row.children[colIdx];
      if (!cell) return;
      const cellText = cell.textContent.trim();
      if (colIdx === 8) {
        if (!cellText.includes(val)) show = false;
      } else if (colIdx === 3) {
        if (!cellText.split("-")[0].startsWith(val)) show = false;
      } else {
        if (!cellText.startsWith(val)) show = false;
      }
    });
    row.style.display = show ? "" : "none";
  });

  // Recompute the summary off whichever rows the filter just left visible —
  // with no filter active every row is visible, which is exactly the "whole
  // summary" case, so this one function covers both states without a branch.
  recomputeTasksSummaryFromVisibleRows();
}

// Counts roles from whatever <tr> rows are currently visible (display !==
// "none") in the My Tasks table, using each row's data-roles attribute set at
// render time. Used after a column filter changes so the summary chip tracks
// the filtered subset instead of staying pinned to the unfiltered total.
function recomputeTasksSummaryFromVisibleRows() {
  const summaryEl = document.getElementById('tasks-summary');
  if (!summaryEl) return;

  const rows = document.querySelectorAll(
    '#default-task-table-container .data-table tbody tr'
  );
  let modeller = 0, checker = 0, gl = 0, sgl = 0, total = 0;
  rows.forEach((row) => {
    if (row.style.display === 'none') return;
    if (row.querySelector('.no-data')) return;
    total++;
    let roles = [];
    try { roles = JSON.parse(row.dataset.roles || '[]'); } catch (_) {}
    if (roles.includes('SGL')) sgl++;
    if (roles.includes('GL')) gl++;
    if (roles.some((r) => ['PC', 'MC', 'SC'].includes(r))) checker++;
    if (roles.includes('Modeller')) modeller++;
  });

  if (total === 0) {
    summaryEl.textContent = '(Tasks = 0)';
    return;
  }
  const parts = [`Total: ${total}`];
  if (checker)  parts.push(`Checker: ${checker}`);
  if (modeller) parts.push(`Modeller: ${modeller}`);
  if (gl)       parts.push(`GL: ${gl}`);
  if (sgl)      parts.push(`SGL: ${sgl}`);
  summaryEl.textContent = `(${parts.join(' · ')})`;
}

// Function to setup search functionality for task table
function setupTaskTableSearch() {
  const searchInput = document.getElementById("task-table-search-input");
  const clearBtn = document.getElementById("clear-task-search-btn");

  if (searchInput) {
    // Search on every keystroke
    searchInput.addEventListener("input", function () {
      const searchTerm = this.value.toLowerCase().trim();
      filterTableRows(searchTerm);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      const searchInput = document.getElementById("task-table-search-input");
      if (searchInput) {
        searchInput.value = "";
        filterTableRows("");
      }
    });
  }
}

function generateTaskRowContent(task, currentRole) {
  const baseContent = `
    <td>${task.jobNo}</td>
    <td>${task.unitNo}</td>
    <td>${task.lineNo}${lotBadgeHtml(task.plannedLotNumber, task.jobNo, task.unitNo)}${typeof renderTagPills === 'function' ? renderTagPills(task.tags || []) : ''}</td>
    <td>${task.revNo}${task.uploadCount ? "-" + task.uploadCount : ""}</td>
    <td>${task.stressCritical}</td>
    <td>${task.from}</td>
    <td>${formatDateTime(task.claimedOn)}</td>
  `;

  if (currentRole === "Modeller") {
    return (
      baseContent +
      `
    <td class="comment-types">
      ${task.commentTypes ? task.commentTypes.join(", ") : "No Comments"}
    </td>
    <td class="claimed-roles">
      <label class="role-checkbox-label claimed" onclick="handleRoleClick('Modeller', this)" style="cursor: pointer;">
        <input type="checkbox" checked disabled style="pointer-events: none;">
        Modeller
      </label>
    </td>
  `
    );
  } else if (currentRole === "GL") {
    return (
      baseContent +
      `
    <td class="no-comment-employees">
      ${task.noCommentEmployees ? task.noCommentEmployees.join(", ") : "N/A"}
    </td>
    <td class="claimed-roles">
      <label class="role-checkbox-label claimed" onclick="handleRoleClick('GL', this)" style="cursor: pointer;">
        <input type="checkbox" checked disabled style="pointer-events: none;">
        GL
      </label>
    </td>
  `
    );
  } else if (currentRole === "SGL") {
    return (
      baseContent +
      `
    <td class="claimed-roles">
      <label class="role-checkbox-label claimed" onclick="handleRoleClick('SGL', this)" style="cursor: pointer;">
        <input type="checkbox" checked disabled style="pointer-events: none;">
        SGL
      </label>
    </td>
  `
    );
  } else {
    const claimedRolesDisplay = generateClaimedRolesDisplay(task.claimedRoles);
    return (
      baseContent +
      `
    <td class="claimed-roles">s
      ${claimedRolesDisplay}
    </td>
  `
    );
  }
}

function renderClaimedTasksTable(tasks) {
  const tableContainer = document.querySelector(
    "#default-task-table-container .data-table tbody"
  );
  if (!tableContainer) return;

  // Clear existing rows
  tableContainer.innerHTML = "";

  if (tasks.length === 0) {
    tableContainer.innerHTML =
      '<tr><td colspan="8" class="no-data">No claimed tasks available</td></tr>';
    return;
  }

  tasks.forEach((task, index) => {
    const row = document.createElement("tr");

    // Generate claimed roles display
    const claimedRolesDisplay = generateClaimedRolesDisplay(task.claimedRoles);

    row.innerHTML = `
      <td>${task.jobNo}</td>
      <td>${task.unitNo}</td>
      <td>${task.lineNo}${lotBadgeHtml(task.plannedLotNumber, task.jobNo, task.unitNo)}${typeof renderTagPills === 'function' ? renderTagPills(task.tags || []) : ''}</td>
      <td>${task.revNo}${task.uploadCount ? "-" + task.uploadCount : ""}</td>
      <td>${task.stressCritical}</td>
      <td>${task.from}</td>
      <td>${formatDateTime(task.claimedOn)}</td>
      <td class="claimed-roles">
        ${claimedRolesDisplay}
      </td>
    `;

    tableContainer.appendChild(row);
  });
}

document.addEventListener("contextmenu", function (e) {
  const row = e.target.closest("#default-task-table-container tbody tr");
  if (!row) return;
  e.preventDefault();
  document.getElementById("taskCtxMenu")?.remove();

  const unclaimIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  const menuItems = [
    { label: "View Line Details", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`, action: () => viewLineDetails(row) },
    { label: "View Hold History", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`, action: () => { if (window.showLineHoldsModal) showLineHoldsModal(null, row.dataset.lineNo, row.dataset.jobNo, row.dataset.unitNo); } },
  ];

  // Multiple PC/MC/SC roles combined into one claim (e.g. claimed all three
  // together) — offer unclaiming just one role at a time, plus a catch-all,
  // instead of only the single all-or-nothing option.
  let claimedRoles = [];
  try { claimedRoles = JSON.parse(row.dataset.roles || '[]'); } catch (_) {}
  const checkerRoles = claimedRoles.filter((r) => ['PC', 'MC', 'SC'].includes(r));
  const roleFullName = { PC: 'Process Checker', MC: 'Material Checker', SC: 'Stress Checker' };

  if (checkerRoles.length > 1) {
    checkerRoles.forEach((r) => {
      menuItems.push({
        label: `Unclaim ${r} (${roleFullName[r]})`,
        icon: unclaimIcon,
        action: () => unclaimLine(row, [r]),
      });
    });
    menuItems.push({ label: "Unclaim All Roles", icon: unclaimIcon, action: () => unclaimLine(row) });
  } else {
    menuItems.push({ label: "Unclaim Line", icon: unclaimIcon, action: () => unclaimLine(row) });
  }

  const menu = document.createElement("ul");
  menu.id = "taskCtxMenu";
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;display:block;`;
  menuItems.forEach(({ label, icon, action }) => {
    const li = document.createElement("li");
    li.innerHTML = `${icon}<span>${label}</span>`;
    li.onclick = () => { action(); menu.remove(); };
    menu.appendChild(li);
  });
  document.body.appendChild(menu);
  document.addEventListener("click", () => menu.remove(), { once: true });
});

document.addEventListener("contextmenu", function (e) {
  const row = e.target.closest("#default-notification-table-container tbody tr");
  if (!row || !row.dataset.jobNo) return;
  e.preventDefault();
  document.getElementById("notifCtxMenu")?.remove();

  const menu = document.createElement("ul");
  menu.id = "notifCtxMenu";
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;display:block;`;

  const li = document.createElement("li");
  li.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>View Line Details</span>`;
  li.onclick = () => { viewLineDetails(row); menu.remove(); };
  menu.appendChild(li);

  const liHolds = document.createElement("li");
  liHolds.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>View Hold History</span>`;
  liHolds.onclick = () => { if (window.showLineHoldsModal) showLineHoldsModal(null, row.dataset.lineNo, row.dataset.jobNo, row.dataset.unitNo); menu.remove(); };
  menu.appendChild(liHolds);

  document.body.appendChild(menu);
  document.addEventListener("click", () => menu.remove(), { once: true });
});

async function unclaimLine(row, rolesToDrop) {
  const jobNo  = row.dataset.jobNo  || row.children[0].textContent.trim();
  const lineNo = row.dataset.lineNo || row.children[2].textContent.trim();
  const hasRoles = Array.isArray(rolesToDrop) && rolesToDrop.length > 0;
  const confirmMsg = hasRoles
    ? `Are you sure you want to unclaim ${rolesToDrop.join(', ')} from line ${lineNo}? Your other claimed role(s) on this line will be unaffected.`
    : `Are you sure you want to unclaim line ${lineNo}?`;
  if (!confirm(confirmMsg)) return;

  try {
    const response = await fetch("/api/unclaim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hasRoles ? { lineNo, jobNo, roles: rolesToDrop } : { lineNo, jobNo }),
    });
    const result = await response.json();

    if (result.ok) {
      alert(hasRoles ? `${rolesToDrop.join(', ')} unclaimed successfully.` : "Line unclaimed successfully.");
      await showMyTasks();
    } else {
      alert("Failed to unclaim line: " + (result.error || "Unknown error"));
    }
  } catch (error) {
    console.error(error);
    alert("Error unclaiming line.");
  }
}

async function viewLineDetails(row) {
  const jobNo  = row.dataset.jobNo;
  const unitNo = row.dataset.unitNo;
  const lineNo = row.dataset.lineNo;

  const modal    = document.getElementById("lineDetailsModal");
  const body     = document.getElementById("ldm-body");
  const subtitle = document.getElementById("ldm-line-subtitle");

  subtitle.textContent = `${jobNo} · ${unitNo} · ${lineNo}`;
  body.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-faint);font-size:13px;">Loading…</div>`;
  modal.classList.add("open");

  try {
    const [detailsRes, inchRes, lmsRes] = await Promise.all([
      fetch(`/api/line-details?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`),
      fetch(`/api/inch/line?project=${encodeURIComponent(jobNo)}&unit=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`),
      fetch(`/api/lms/line?project=${encodeURIComponent(jobNo)}&unit=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`),
    ]);
    const data      = await detailsRes.json();
    const inchResult = await inchRes.json().catch(() => ({ ok: false }));
    const lmsResult  = await lmsRes.json().catch(() => ({ ok: false }));
    if (data.ok) {
      data.inchData = (inchResult.ok && inchResult.data) ? inchResult.data : null;
      data.lmsData  = (lmsResult.ok && lmsResult.rows?.length) ? lmsResult.rows : null;
      body.innerHTML = renderLineDetailsBody(data);
    } else {
      body.innerHTML = `<p style="color:#b91c1c;font-size:13px;">${data.error || "Failed to load details."}</p>`;
    }
  } catch {
    body.innerHTML = `<p style="color:#b91c1c;font-size:13px;">Network error.</p>`;
  }
}

function renderLineDetailsBody({ lineInfo, rolePerformers, activeClaims, linelistData, inchData, lmsData }) {
  const { jobNo, unitNo, lineNo, revNo, uploadCount, status, stressCritical, uploader } = lineInfo;

  const statusStyle = status === "Under Review"
    ? "color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;"
    : status === "Uploaded"
    ? "color:#15803d;background:#f0fdf4;border:1px solid #86efac;"
    : status === "Final"
    ? "color:#7c3aed;background:#faf5ff;border:1px solid #c4b5fd;"
    : (status || '').startsWith("Comments Received")
    ? "color:#c2410c;background:#fff7ed;border:1px solid #fed7aa;"
    : "color:var(--text-secondary);background:var(--gray-100);border:1px solid var(--gray-200);";

  // Map active claims to role keys
  const activeRoleMap = {};
  for (const c of (activeClaims || [])) {
    for (const r of (c.roles || [])) activeRoleMap[r] = c.name || c.userId;
  }

  const roleCards = ["PC", "MC", "SC", "GL", "SGL"].map(role => {
    const activeUser = activeRoleMap[role];
    const histUser   = rolePerformers?.[role];
    const user       = activeUser || (histUser ? (histUser.name || histUser.id) : null);
    const isActive   = !!activeUser;
    return `<div class="ldm-role-card${isActive ? " active" : ""}">
      <div class="ldm-role-label">${role}</div>
      <div class="ldm-role-user${user ? "" : " empty"}">${user || "—"}</div>
    </div>`;
  }).join("");

  // ── INCH data section ──
  let inchSection = "";
  if (inchData) {
    const fmt = v => (v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—");
    inchSection = `<div class="ldm-section">
      <div class="ldm-section-title" style="display:flex;align-items:center;gap:6px;">
        <span class="inch-badge">INCH</span> Inch Meter Data
      </div>
      <div class="ldm-info-grid">
        <div class="ldm-info-item">
          <span class="ldm-info-label">Inch Dia</span>
          <span class="ldm-info-value">${inchData.inchDia != null ? fmt(inchData.inchDia) : "—"}</span>
        </div>
        <div class="ldm-info-item">
          <span class="ldm-info-label">Inch Meter</span>
          <span class="ldm-info-value" style="font-weight:700;color:var(--blue,#2563eb);">${inchData.inchMeter != null ? fmt(inchData.inchMeter) : "—"}</span>
        </div>
      </div>
    </div>`;
  }

  let llSection = "";
  if (linelistData) {
    const ll = linelistData;
    const pairs = [
      ["Service",       ll.service],
      ["Line Class",    ll.line_class],
      ["Fluid State",   ll.fluid_state],
      ["Design Temp",   ll.design_temp  != null ? `${ll.design_temp} ${ll.design_temp_unit || ""}`.trim()  : null],
      ["Op. Temp",      ll.operating_temp != null ? `${ll.operating_temp} ${ll.operating_temp_unit || ""}`.trim() : null],
      ["Min. Temp",     ll.min_design_temp != null ? `${ll.min_design_temp} ${ll.min_design_temp_unit || ""}`.trim() : null],
      ["Insulation",    ll.insulation ? `${ll.insulation}${ll.insulation_thickness ? " · " + ll.insulation_thickness + " mm" : ""}` : null],
    ].filter(([, v]) => v != null);
    if (pairs.length) {
      llSection = `<div class="ldm-section">
        <div class="ldm-section-title">Line List Data</div>
        <div class="ldm-info-grid">
          ${pairs.map(([k, v]) => `<div class="ldm-info-item"><span class="ldm-info-label">${k}</span><span class="ldm-info-value">${v}</span></div>`).join("")}
        </div>
      </div>`;
    }
  }

  // ── LMS section ──
  let lmsSection = "";
  if (lmsData && lmsData.length) {
    const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    // Collect unique column keys in insertion order
    const keySet = new Set();
    const keys   = [];
    lmsData.forEach(r => { if (r.rowData) Object.keys(r.rowData).forEach(k => { if (!keySet.has(k)) { keySet.add(k); keys.push(k); } }); });

    const thCss = "padding:5px 8px;font-size:10.5px;font-weight:600;color:var(--text-muted,#64748b);background:var(--gray-50,#f8fafc);border-bottom:1px solid var(--border,#e2e8f0);white-space:nowrap;text-align:left;";
    const tdCss = "padding:5px 8px;font-size:11.5px;border-bottom:1px solid var(--gray-100,#f1f5f9);white-space:nowrap;";

    const headerRow = keys.map(k => `<th style="${thCss}">${esc(k)}</th>`).join("");
    const bodyRows  = lmsData.map(r => {
      const cells = keys.map(k => {
        const v = r.rowData?.[k];
        if (v == null || v === "") return `<td style="${tdCss}color:var(--text-faint,#94a3b8);">—</td>`;
        if (!isNaN(v) && String(v).trim() !== "")
          return `<td style="${tdCss}text-align:right;font-variant-numeric:tabular-nums;">${Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>`;
        return `<td style="${tdCss}">${esc(String(v))}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");

    lmsSection = `<div class="ldm-section">
      <div class="ldm-section-title" style="display:flex;align-items:center;gap:6px;">
        <span style="background:#cffafe;color:#0891b2;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:0.04em;">LMS</span>
        Line Mounted Summary
        <span style="font-size:11px;color:var(--text-faint,#94a3b8);font-weight:400;">${lmsData.length} item${lmsData.length !== 1 ? "s" : ""}</span>
      </div>
      <div style="overflow-x:auto;margin-top:8px;border-radius:6px;border:1px solid var(--border,#e2e8f0);">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>${headerRow}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  return `
    <div class="ldm-section">
      <div class="ldm-section-title">Drawing Info</div>
      <div class="ldm-info-grid">
        <div class="ldm-info-item"><span class="ldm-info-label">Job No</span><span class="ldm-info-value">${jobNo}</span></div>
        <div class="ldm-info-item"><span class="ldm-info-label">Unit No</span><span class="ldm-info-value">${unitNo}</span></div>
        <div class="ldm-info-item"><span class="ldm-info-label">Rev / Upload</span><span class="ldm-info-value">${revNo}-${uploadCount}</span></div>
        <div class="ldm-info-item"><span class="ldm-info-label">Status</span><span class="ldm-info-value" style="font-size:11.5px;padding:2px 8px;border-radius:5px;display:inline-block;${statusStyle}">${status}</span></div>
        <div class="ldm-info-item"><span class="ldm-info-label">Stress Crit.</span><span class="ldm-info-value" style="color:${stressCritical === "Y" ? "#b91c1c" : "inherit"}">${stressCritical || "N"}</span></div>
        <div class="ldm-info-item"><span class="ldm-info-label">Uploaded By</span><span class="ldm-info-value">${uploader?.name || "—"}</span></div>
      </div>
    </div>
    <div class="ldm-section">
      <div class="ldm-section-title">Review Team</div>
      <div class="ldm-role-grid">${roleCards}</div>
    </div>
    ${llSection}
    ${inchSection}
    ${lmsSection}`;
}

// Wire up line details modal close button
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("closeLineDetailsModal");
  const modal    = document.getElementById("lineDetailsModal");
  if (closeBtn && modal) {
    closeBtn.addEventListener("click", () => modal.classList.remove("open"));
    modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });
  }
});

// Make functions globally available

//window.showHistoryItemDetails = showHistoryItemDetails;

function showTaskHistoryPanel(lineNo, history, errorMessage = null) {
  // Hide all existing views
  hideAllTables();
  hideWelcome();

  // Remove any existing history view
  const existingHistoryView = document.getElementById("task-history-view");
  if (existingHistoryView) {
    existingHistoryView.remove();
  }

  const rightPanel = document.querySelector(".right-panel");
  if (!rightPanel) return;

  // Create the task history view HTML
  const historyViewHTML = createTaskHistoryViewHTML(
    lineNo,
    history,
    errorMessage
  );

  // Insert after menu-bar
  const menuBar = rightPanel.querySelector(".menu-bar");
  if (menuBar && menuBar.nextSibling) {
    const historyDiv = document.createElement("div");
    historyDiv.id = "task-history-view";
    historyDiv.innerHTML = historyViewHTML;

    // Insert after menu-bar
    rightPanel.insertBefore(historyDiv, menuBar.nextSibling);
  }

  // Setup event listeners for the history view
  setupTaskHistoryEventListeners();
}

function createTaskHistoryViewHTML(lineNo, history, errorMessage) {
  if (errorMessage) {
    return `
      <div class="task-history-container">
        <div class="history-header">
          <h3>Task History for Line: ${lineNo}</h3>
          <button id="back-to-tasks-history-btn" class="back-btn">← Back to Tasks</button>
        </div>
        <div class="error-message" style="text-align: center; color: #d32f2f; padding: 20px;">
          ${errorMessage}
        </div>
      </div>
    `;
  }

  if (history.length === 0) {
    return `
      <div class="task-history-container">
        <div class="history-header">
          <h3>Task History for Line: ${lineNo}</h3>
          <button id="back-to-tasks-history-btn" class="back-btn">← Back to Tasks</button>
        </div>
        <div class="no-history" style="text-align: center; color: #666; padding: 20px;">
          No task history available for this line.
        </div>
      </div>
    `;
  }

  // Store history data globally for details panel
  window.currentHistoryData = history;

  return `
    <div class="task-history-container">
      <div class="history-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 15px; background-color: #f8f9fa; border-radius: 6px;">
        <h3 style="margin: 0; color: #007bff;">Task History for Line: ${lineNo}</h3>
        <button id="back-to-tasks-history-btn" class="back-btn" style="background: #6c757d; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">← Back to Tasks</button>
      </div>
      
      <div class="history-content" style="display: flex; gap: 20px; height: calc(100vh - 200px);">
        <!-- Left Side: File History Table -->
        <div class="history-files-section" style="flex: 1; min-width: 60%;">
          <h4>File History</h4>
          <div class="history-files-table-container" style="max-height: 500px; overflow-y: auto; border: 1px solid #ddd;">
            <table class="history-files-table" style="width: 100%; border-collapse: collapse;">
              <thead style="background-color: #f8f9fa; position: sticky; top: 0;">
                <tr>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">File Name</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Rev No.</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Type</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Uploaded By</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Date & Time</th>
                </tr>
              </thead>
              <tbody id="history-files-tbody">
                ${generateHistoryFileRows(history)}
              </tbody>
            </table>
          </div>
        </div>
        
        <!-- Right Side: Details Panel -->
        <div class="history-details-section" style="flex: 1; min-width: 40%; border: 1px solid #ddd; border-radius: 6px;">
          <div id="history-details-content" style="padding: 20px; height: 100%; overflow-y: auto;">
            <div style="text-align: center; color: #666; padding: 50px 20px;">
              <h4>File Details</h4>
              <p>Click on a file name to view PDF or click on a row to see comment details</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function generateHistoryFileRows(history) {
  return history
    .map((item, index) => {
      const isClickable =
        item.fileType === "base" || item.fileType === "comment";
      const fileName = isClickable
        ? `<a href="#" class="file-name-link" data-file-path="${item.filePath}" data-index="${index}">${item.fileName}</a>`
        : item.fileName;

      return `
      <tr class="history-file-row" data-index="${index}" style="cursor: pointer;">
        <td style="border: 1px solid #ddd; padding: 8px;">${fileName}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${item.revNo}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${item.commentType
        }</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${item.uploadedBy
        }</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${new Date(
          item.uploadedOn
        ).toLocaleString()}</td>
      </tr>
    `;
    })
    .join("");
}

function setupTaskHistoryEventListeners() {
  // Back button
  const backBtn = document.getElementById("back-to-tasks-history-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      // Remove history view
      const historyView = document.getElementById("task-history-view");
      if (historyView) {
        historyView.remove();
      }

      // Remove row highlighting
      document
        .querySelectorAll("#default-task-table-container tbody tr")
        .forEach((r) => {
          r.classList.remove("history-highlighted");
        });

      // Show tasks table
      const defaultTaskTable = document.getElementById(
        "default-task-table-container"
      );
      if (defaultTaskTable) {
        defaultTaskTable.style.display = "block";
      }
    });
  }

  // File name links (for PDF viewing)
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("file-name-link")) {
      e.preventDefault();
      const filePath = e.target.dataset.filePath;
      const index = parseInt(e.target.dataset.index);
      showPDFInDetailsPanel(filePath, index);
    }
  });

  // Row clicks (for comment details)
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".history-file-row");
    if (row && !e.target.classList.contains("file-name-link")) {
      const index = parseInt(row.dataset.index);
      showCommentDetailsInPanel(index);

      // Highlight selected row
      document
        .querySelectorAll(".history-file-row")
        .forEach((r) => r.classList.remove("selected-history-row"));
      row.classList.add("selected-history-row");
    }
  });
}

function showPDFInDetailsPanel(filePath, index) {
  const detailsContent = document.getElementById("history-details-content");
  if (!detailsContent) return;

  detailsContent.innerHTML = `
    <div class="pdf-viewer-container">
      <h4>PDF Viewer</h4>
      <div style="text-align: center; margin: 10px 0;">
        <a href="/${filePath}" target="_blank" style="background: #007bff; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Open in New Tab</a>
        <button onclick="showCommentDetailsInPanel(${index})" style="background: #6c757d; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-left: 10px;">Show Details</button>
      </div>
      <iframe src="/${filePath}" style="width: 100%; height: 400px; border: 1px solid #ddd; border-radius: 4px;" frameborder="0">
        PDF cannot be displayed. <a href="/${filePath}" target="_blank">Open in new tab</a>
      </iframe>
    </div>
  `;
}

function showCommentDetailsInPanel(index) {
  const history = window.currentHistoryData || [];
  const item = history[index];

  if (!item) return;

  const detailsContent = document.getElementById("history-details-content");
  if (!detailsContent) return;

  let detailsHTML = `
    <div class="comment-details-container">
      <h4>Details for: ${item.fileName}</h4>
      <div class="detail-item">
        <strong>Type:</strong> ${item.commentType}
      </div>
      <div class="detail-item">
        <strong>Uploaded By:</strong> ${item.uploadedBy}
      </div>
      <div class="detail-item">
        <strong>Date & Time:</strong> ${new Date(
    item.uploadedOn
  ).toLocaleString()}
      </div>
      <div class="detail-item">
        <strong>Revision:</strong> ${item.revNo}
      </div>
  `;

  if (item.fileType === "text") {
    detailsHTML += `
      <div class="detail-item">
        <strong>Comment:</strong>
        <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-top: 5px; white-space: pre-wrap;">${item.comment}</div>
      </div>
    `;
  } else if (item.fileType === "comment") {
    detailsHTML += `
      <div class="detail-item">
        <strong>Comment Type:</strong> Uploaded File
      </div>
      <div class="detail-item">
        <strong>Role:</strong> ${item.role}
      </div>
      <div style="margin-top: 15px;">
        <a href="/${item.filePath}" target="_blank" style="background: #28a745; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">Download Comment File</a>
      </div>
    `;
  } else if (item.fileType === "base") {
    detailsHTML += `
      <div class="detail-item">
        <strong>Description:</strong> Base isometric file uploaded by modeller
      </div>
    `;
  }

  detailsHTML += `
    </div>
  `;

  detailsContent.innerHTML = detailsHTML;
}

function generateClaimedRolesDisplay(claimedRoles) {
  if (!Array.isArray(claimedRoles)) return "";

  let rolesDisplay = "";
  const roleLabels = {
    PC: "Process Checker",
    MC: "Material Checker",
    SC: "Stress Checker",
  };

  claimedRoles.forEach((role) => {
    const label = roleLabels[role] || role;
    rolesDisplay += `
      <label class="role-checkbox-label claimed" onclick="handleRoleClick('${role}', this)" style="cursor: pointer;">
        <input type="checkbox" checked disabled style="pointer-events: none;">
        ${role}
      </label>
    `;
  });

  return rolesDisplay;
}

function hideAllTables() {
  const tables = [
    'default-task-table-container',
    'pc-task-table-container',
    'mc-task-table-container',
    'default-notification-table-container',
    'pc-notification-table-container',
    'mc-notification-table-container',
    'final-isometrics-table-container',
    'rejected-isometrics-table-container',
  ];

  tables.forEach(tableId => {
    const table = document.getElementById(tableId);
    if (table) {
      table.style.display = 'none';
      // Clear the table body to prevent old data from showing
      const tbody = table.querySelector('.data-table tbody');
      if (tbody) {
        tbody.innerHTML = '';
      }
    }
  });


  // Hide ISO surfaces
  const isoSurface = document.querySelector(".iso-surface");
  const commentsSurface = document.querySelector(".comments-surface");

  if (isoSurface) isoSurface.style.display = "none";
  if (commentsSurface) commentsSurface.style.display = "none";
}

function hideWelcome() {
  const welcome = document.getElementById('welcome-container');
  if (welcome) {
    welcome.style.display = 'none';
  }
}

// Reset currentView when welcome is hidden
function showWelcome() {
  const welcome = document.getElementById('welcome-container');
  if (welcome) {
    welcome.style.display = 'block';
    window.currentView = null; // Reset view

    // Clear all highlights
    removeNotificationMenuHighlight();
    clearNotificationRoleTitle();
  }
}


function formatDateTime(dateString) {
  if (!dateString) return "";

  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-GB');
  } catch (error) {
    return dateString;
  }
}

// Role context switching functions
function switchToProcessChecker() {
  // Hide default menu, show PC menu
  document.getElementById("default-left-menu").style.display = "none";
  document.getElementById("process-checker-left-menu").style.display = "block";
  document.getElementById("material-checker-left-menu").style.display = "none";

  // Show PC notification table
  hideAllTables();
  hideWelcome();
  document.getElementById("pc-notification-table-container").style.display =
    "block";
}

function switchToMaterialChecker() {
  // Hide default menu, show MC menu
  document.getElementById("default-left-menu").style.display = "none";
  document.getElementById("process-checker-left-menu").style.display = "none";
  document.getElementById("material-checker-left-menu").style.display = "block";

  // Show MC notification table
  hideAllTables();
  hideWelcome();
  document.getElementById("mc-notification-table-container").style.display =
    "block";
}

function switchToDefault() {
  // Show default menu, hide others
  document.getElementById("default-left-menu").style.display = "block";
  document.getElementById("process-checker-left-menu").style.display = "none";
  document.getElementById("material-checker-left-menu").style.display = "none";

  // Show default notification table
  hideAllTables();
  hideWelcome();
  document.getElementById(
    "default-notification-table-container"
  ).style.display = "block";
}

// Handle role click in My Tasks table
function handleRoleClick(role, element) {
  const row = element.closest("tr");
  if (!row) return;

  // Extract task data from the row
  const cells = row.querySelectorAll("td");
  if (cells.length < 7) return;

  const taskData = {
    jobNo: cells[0].textContent.trim(),
    unitNo: cells[1].textContent.trim(),
    lineNo: cells[2].textContent.trim(),
    revNo: cells[3].textContent.trim(),
    stressCritical: cells[4].textContent.trim(),
    from: cells[5].textContent.trim(),
    claimedOn: cells[6].textContent.trim(),
    claimedRoles: [], // Will be populated below
    commentTypes: [], // For modeller
  };

  // Extract role-specific data
  if (role === "Modeller") {
    // For modeller, extract comment types from the 8th column
    if (cells.length > 7) {
      const commentTypesText = cells[7].textContent.trim();
      taskData.commentTypes = commentTypesText.split(",").map((c) => c.trim());
    }
    taskData.claimedRoles = ["Modeller"];
  } else {
    // Extract claimed roles from the row for checkers
    const roleLabels = row.querySelectorAll(".role-checkbox-label.claimed");
    roleLabels.forEach((label) => {
      const roleText = label.textContent.trim();
      if (roleText) {
        taskData.claimedRoles.push(roleText);
      }
    });
  }

  // Call the appropriate performance view function
  if (role === "Modeller") {
    if (typeof window.openModellerView === "function") {
      window.openModellerView(taskData, role);
    } else {
      console.error("openModellerView function not available");
    }
  } else if (role === "GL") {
    if (typeof window.openGLView === "function") {
      window.openGLView(taskData, role);
    } else {
      console.error("openGLView function not available");
    }
  } else if (role === "SGL") {
    if (typeof window.openSGLView === "function") {
      window.openSGLView(taskData, role);
    } else {
      console.error("openSGLView function not available");
    }
  } else {
    // Default checker roles
    if (typeof window.openCheckerView === "function") {
      window.openCheckerView(taskData, role);
    } else {
      console.error("openCheckerView function not available");
    }
  }
}

// Make the function globally available
window.handleRoleClick = handleRoleClick;

// --- Begin: helpers for notification menu highlight & role title ---
function setNotificationRoleTitle(role) {
  const mapping = {
    Modeller: "Modeller's Notification",
    Checker: "Checker's Notification",
    GL: "Group Leader's Notification",
    SGL: "Approver's Notification",
  };
  const titleEl = document.getElementById("role-notification-title");
  if (!titleEl) return;
  titleEl.textContent = mapping[role] || `${role} Notification`;
  titleEl.style.display = "block";
}

function clearNotificationRoleTitle() {
  const titleEl = document.getElementById("role-notification-title");
  if (titleEl) titleEl.style.display = "none";
}

function highlightNotificationMenu() {
  // remove any previous highlights
  document
    .querySelectorAll(".menu-notif-active")
    .forEach((el) => el.classList.remove("menu-notif-active"));

  // find visible left menu (default / process-checker / material-checker)
  const menuIds = [
    "default-left-menu",
    "process-checker-left-menu",
    "material-checker-left-menu",
  ];
  for (const id of menuIds) {
    const menu = document.getElementById(id);
    if (!menu) continue;
    // if menu is visible (style.display != 'none') or not explicitly hidden
    const style = menu.style.display;
    if (style === "none") continue;
    // find the li that contains the notification icon
    const notifLi = Array.from(menu.querySelectorAll("li")).find((li) => {
      const img = li.querySelector("img");
      return (
        img &&
        img.getAttribute("src") &&
        img.getAttribute("src").includes("notification.png")
      );
    });
    if (notifLi) {
      notifLi.classList.add("menu-notif-active");
      break;
    }
  }
}

function removeNotificationMenuHighlight() {
  document
    .querySelectorAll(".menu-notif-active")
    .forEach((el) => el.classList.remove("menu-notif-active"));
  clearNotificationRoleTitle();
}

function highlightMyTasksMenu() {
  document
    .querySelectorAll(
      ".menu-task-active, .menu-finaliso-active, .menu-notif-active"
    )
    .forEach((el) =>
      el.classList.remove(
        "menu-task-active",
        "menu-finaliso-active",
        "menu-notif-active"
      )
    );

  const menuIds = [
    "default-left-menu",
    "process-checker-left-menu",
    "material-checker-left-menu",
  ];
  for (const id of menuIds) {
    const menu = document.getElementById(id);
    if (!menu || menu.style.display === "none") continue;
    const taskLi = Array.from(menu.querySelectorAll("li")).find((li) => {
      const img = li.querySelector("img");
      return img && img.getAttribute("src")?.includes("comment.png");
    });
    if (taskLi) {
      taskLi.classList.add("menu-task-active");
      break;
    }
  }
}

// --- Begin: dynamic highlight updater (added) ---
function updateMenuHighlights() {
  const notifTable = document.getElementById(
    "default-notification-table-container"
  );
  const taskTable = document.getElementById("default-task-table-container");
  const finalIsoTable = document.getElementById("final-isometrics-table-container");
  const modal = document.getElementById("role-selection-modal");

  // Clear all highlights first
  document
    .querySelectorAll(".menu-task-active, .menu-notif-active, .menu-finaliso-active")
    .forEach((el) =>
      el.classList.remove("menu-task-active", "menu-notif-active", "menu-finaliso-active")
    );

  // Check Final Isometrics first (highest priority)
  if (window.currentView === 'FinalIsometrics' || (finalIsoTable && finalIsoTable.style.display !== "none")) {
    // Highlight Final Isometrics menu
    const menuIds = [
      "default-left-menu",
      "process-checker-left-menu",
      "material-checker-left-menu",
    ];
    for (const id of menuIds) {
      const menu = document.getElementById(id);
      if (!menu || menu.style.display === "none") continue;
      const finalIsoLi = Array.from(menu.querySelectorAll("li")).find((li) => {
        const img = li.querySelector("img");
        return img && img.getAttribute("src")?.includes("Final-iso.png");
      });
      if (finalIsoLi) {
        finalIsoLi.classList.add("menu-finaliso-active");
        break;
      }
    }
    return;
  }

  // Highlight Notifications if modal or table visible
  if (
    (modal && modal.style.display !== "none") ||
    (notifTable && notifTable.style.display !== "none")
  ) {
    highlightNotificationMenu();
    return;
  }

  // Highlight My Tasks if table visible
  if (taskTable && taskTable.style.display !== "none") {
    highlightMyTasksMenu();
    return;
  }

  // Otherwise clear all
  removeNotificationMenuHighlight();
}


// Run every 500ms to stay in sync with view changes
setInterval(() => {
  // Only update highlights if we're not on the welcome screen
  const welcomeContainer = document.getElementById('welcome-container');
  if (!welcomeContainer || welcomeContainer.style.display === 'none') {
    updateMenuHighlights();
  }
}, 500);

// --- End: dynamic highlight updater (added) ---

// --- End: helpers for notification menu highlight & role title ---

// Event listeners for role switching buttons
document.addEventListener("DOMContentLoaded", function () {
  const processCheckerBtn = document.getElementById("process-checker-btn");
  const materialCheckerBtn = document.getElementById("material-checker-btn");

  if (processCheckerBtn) {
    processCheckerBtn.addEventListener("click", switchToProcessChecker);
  }

  if (materialCheckerBtn) {
    materialCheckerBtn.addEventListener("click", switchToMaterialChecker);
  }
});

// ── Lines on Hold section ──────────────────────────────────────────────────────

async function loadHoldLines() {
  const section  = document.getElementById('hold-lines-section');
  const body     = document.getElementById('hold-lines-body');
  const countEl  = document.getElementById('hold-lines-count');
  if (!section || !body) return;

  try {
    const resp = await fetch('/api/hold-lines', { credentials: 'same-origin' });
    const data = await resp.json();
    if (!data.ok || !data.lines || data.lines.length === 0) {
      section.style.display = 'none';
      return;
    }

    const holdLabel = { 'Checker Hold': 'Checker', 'GL Hold': 'GL', 'SGL Hold': 'SGL' };
    const holdColor = { 'Checker Hold': '#1d4ed8', 'GL Hold': '#7c3aed', 'SGL Hold': '#b91c1c' };
    const holdBg    = { 'Checker Hold': '#dbeafe', 'GL Hold': '#ede9fe', 'SGL Hold': '#fee2e2' };

    countEl.textContent = data.lines.length;
    body.innerHTML = data.lines.map(function(line) {
      var label = holdLabel[line.status] || line.status;
      var color = holdColor[line.status] || '#64748b';
      var bg    = holdBg[line.status]    || '#f1f5f9';
      var heldAt = line.held_at ? new Date(line.held_at).toLocaleDateString('en-GB') : '—';
      var desc = (line.hold_description || '—');
      var descTrunc = desc.length > 60 ? desc.slice(0, 57) + '…' : desc;
      var safeJob  = (line.job_no  || '').replace(/'/g, "\\'");
      var safeUnit = (line.unit_no || '').replace(/'/g, "\\'");
      var safeLine = (line.line_no || '').replace(/'/g, "\\'");
      return '<tr>' +
        '<td style="font-weight:600;">' + (line.line_no || '—') + '</td>' +
        '<td>' + (line.job_no || '—') + ' / ' + (line.unit_no || '—') + '</td>' +
        '<td><span style="display:inline-block;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:700;background:' + bg + ';color:' + color + ';">' + label + '</span></td>' +
        '<td>' + (line.hold_declarer_name || line.hold_declarer_id || '—') + '</td>' +
        '<td title="' + desc.replace(/"/g, '&quot;') + '" style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + descTrunc + '</td>' +
        '<td>' + heldAt + '</td>' +
        '<td><button onclick="unblockFromHoldSection(\'' + safeJob + '\',\'' + safeUnit + '\',\'' + safeLine + '\')" ' +
          'style="padding:3px 10px;background:#fee2e2;color:#e53935;border:1px solid #fecaca;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">' +
          'Unblock</button></td>' +
      '</tr>';
    }).join('');

    section.style.display = '';
  } catch (err) {
    console.error('loadHoldLines error:', err);
    section.style.display = 'none';
  }
}
window.loadHoldLines = loadHoldLines;

window.unblockFromHoldSection = async function(jobNo, unitNo, lineNo) {
  if (!confirm('Remove hold on line ' + lineNo + '?\n\nThe line will be returned to the checker pool as if newly uploaded.')) return;
  try {
    var resp = await fetch('/api/unblock-line', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobNo: jobNo, unitNo: unitNo, lineNo: lineNo }),
      credentials: 'same-origin',
    });
    var result = await resp.json();
    if (result.ok) {
      alert(result.message);
      loadHoldLines();
      if (typeof refreshCurrentNotificationView === 'function') refreshCurrentNotificationView();
    } else {
      alert('Error: ' + (result.error || 'Failed to unblock'));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
};
