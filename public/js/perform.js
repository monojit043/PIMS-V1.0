// perform.js - Handles checker, GL, and SGL performer views


// Add CSS for context menu
if (!document.getElementById('context-menu-styles')) {
  const style = document.createElement('style');
  style.id = 'context-menu-styles';
  style.textContent = `
    .line-context-menu {
      position: fixed;
      background: white;
      border: 1px solid #ccc;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      padding: 8px 0;
      z-index: 10000;
      min-width: 200px;
      font-family: Arial, sans-serif;
    }
    
    .line-context-menu-item {
      padding: 10px 16px;
      cursor: pointer;
      transition: background-color 0.2s;
      font-size: 14px;
      color: #333;
    }
    
    .line-context-menu-item:hover {
      background-color: #f0f0f0;
    }
    
    .line-details-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10001;
    }
    
    .line-details-modal-content {
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      animation: modalFadeIn 0.3s ease;
    }
    
    @keyframes modalFadeIn {
      from {
        opacity: 0;
        transform: scale(0.9);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    
    .line-details-modal-header {
      padding: 20px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-radius: 12px 12px 0 0;
    }
    
    .line-details-modal-header h3 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
    
    .line-details-modal-close {
      background: rgba(255,255,255,0.2);
      border: none;
      color: white;
      font-size: 24px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      transition: background 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    
    .line-details-modal-close:hover {
      background: rgba(255,255,255,0.3);
    }
    
    .line-details-modal-body {
      padding: 24px;
    }
    
    .line-details-section {
      margin-bottom: 24px;
    }
    
    .line-details-section:last-child {
      margin-bottom: 0;
    }
    
    .line-details-section-title {
      font-size: 14px;
      font-weight: 600;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e0e0e0;
    }
    
    .line-details-item {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    
    .line-details-item:last-child {
      border-bottom: none;
    }
    
    .line-details-label {
      font-weight: 600;
      color: #555;
      font-size: 14px;
    }
    
    .line-details-value {
      color: #333;
      font-size: 14px;
      text-align: right;
      max-width: 60%;
      word-break: break-word;
    }
    
    .line-details-value.not-assigned {
      color: #999;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}


let currentPerformanceTask = null;
let currentPerformanceRole = null;

// Initialize performance views when DOM is ready
document.addEventListener("DOMContentLoaded", function () {
  setupPerformanceViewEvents();
});


// Context menu functionality for line details
let activeContextMenu = null;

function showLineContextMenu(event, taskData) {
  event.preventDefault();
  event.stopPropagation();

  // Remove any existing context menu
  if (activeContextMenu) {
    activeContextMenu.remove();
  }

  const menu = document.createElement('div');
  menu.className = 'line-context-menu';
  menu.style.left = event.pageX + 'px';
  menu.style.top = event.pageY + 'px';

  const menuItem = document.createElement('div');
  menuItem.className = 'line-context-menu-item';
  menuItem.textContent = '📋 View Line Details';
  menuItem.onclick = () => {
    menu.remove();
    showLineDetailsModal(taskData);
  };
  menu.appendChild(menuItem);

  const holdsItem = document.createElement('div');
  holdsItem.className = 'line-context-menu-item';
  holdsItem.textContent = '🔴 View Hold History';
  holdsItem.onclick = () => {
    menu.remove();
    showLineHoldsModal(null, taskData.lineNo, taskData.jobNo, taskData.unitNo);
  };
  menu.appendChild(holdsItem);
  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Close menu when clicking elsewhere
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu);
  }, 100);
}

function closeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
  document.removeEventListener('click', closeContextMenu);
}

async function showLineDetailsModal(taskData) {
  try {
    const response = await fetch(
      `/api/line-details?jobNo=${encodeURIComponent(taskData.jobNo)}&unitNo=${encodeURIComponent(taskData.unitNo)}&lineNo=${encodeURIComponent(taskData.lineNo)}`,
      { credentials: 'same-origin' }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch line details');
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || 'Failed to load line details');
    }

    displayLineDetailsModal(data);
  } catch (error) {
    console.error('Error fetching line details:', error);
    alert('Failed to load line details. Please try again.');
  }
}

function displayLineDetailsModal(data) {
  const modal = document.createElement('div');
  modal.className = 'line-details-modal';
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  };

  const { lineInfo, rolePerformers, linelistData } = data;

  const fmt = (val, unit) => {
    const v = (val || '').toString().trim();
    const u = (unit || '').toString().trim();
    return v ? (u ? `${v} ${u}` : v) : '—';
  };

  const llSection = linelistData ? `
    <div class="line-details-section">
      <div class="line-details-section-title">⚙️ Process Engineering Data</div>
      <div class="line-details-item">
        <span class="line-details-label">Design Temp:</span>
        <span class="line-details-value">${fmt(linelistData.design_temp, linelistData.design_temp_unit)}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Operating Temp:</span>
        <span class="line-details-value">${fmt(linelistData.operating_temp, linelistData.operating_temp_unit)}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Min Design Temp:</span>
        <span class="line-details-value">${fmt(linelistData.min_design_temp, linelistData.min_design_temp_unit)}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Fluid State:</span>
        <span class="line-details-value">${linelistData.fluid_state || '—'}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Insulation:</span>
        <span class="line-details-value">${linelistData.insulation || '—'}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Insulation Thickness:</span>
        <span class="line-details-value">${linelistData.insulation_thickness || '—'}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Line Class:</span>
        <span class="line-details-value">${linelistData.line_class || '—'}</span>
      </div>
      <div class="line-details-item">
        <span class="line-details-label">Service:</span>
        <span class="line-details-value">${linelistData.service || '—'}</span>
      </div>
    </div>` : '';

  const modalContent = `
    <div class="line-details-modal-content">
      <div class="line-details-modal-header">
        <h3>📄 Line Details</h3>
        <button class="line-details-modal-close" onclick="this.closest('.line-details-modal').remove()">×</button>
      </div>
      <div class="line-details-modal-body">
        <div class="line-details-section">
          <div class="line-details-section-title">Line Information</div>
          <div class="line-details-item">
            <span class="line-details-label">Line Number:</span>
            <span class="line-details-value">${lineInfo.lineNo}</span>
          </div>
          <div class="line-details-item">
            <span class="line-details-label">Revision:</span>
            <span class="line-details-value">${lineInfo.revNo}</span>
          </div>
          <div class="line-details-item">
            <span class="line-details-label">Upload Count:</span>
            <span class="line-details-value">${lineInfo.uploadCount}</span>
          </div>
        </div>

        ${llSection}

        <div class="line-details-section">
          <div class="line-details-section-title">Uploader</div>
          <div class="line-details-item">
            <span class="line-details-label">Name:</span>
            <span class="line-details-value">${lineInfo.uploader.name}</span>
          </div>
          <div class="line-details-item">
            <span class="line-details-label">Employee ID:</span>
            <span class="line-details-value">${lineInfo.uploader.id}</span>
          </div>
        </div>

        <div class="line-details-section">
          <div class="line-details-section-title">Role Performers</div>
          ${createRolePerformerItems(rolePerformers)}
        </div>
      </div>
    </div>
  `;

  modal.innerHTML = modalContent;
  document.body.appendChild(modal);
}

function createRolePerformerItems(rolePerformers) {
  const roleLabels = {
    PC: 'Process Checker (PC)',
    MC: 'Material Checker (MC)',
    SC: 'Stress Checker (SC)',
    GL: 'Group Leader (GL)',
    SGL: 'Senior Group Leader (SGL)'
  };

  let html = '';

  for (const [roleKey, roleLabel] of Object.entries(roleLabels)) {
    const performer = rolePerformers[roleKey];
    const performerInfo = performer
      ? `${performer.name} (${performer.id})`
      : '<span class="not-assigned">Not assigned yet</span>';

    html += `
      <div class="line-details-item">
        <span class="line-details-label">${roleLabel}:</span>
        <span class="line-details-value ${!performer ? 'not-assigned' : ''}">${performerInfo}</span>
      </div>
    `;
  }

  return html;
}

// Make functions globally available
window.showLineContextMenu = showLineContextMenu;


function setupPerformanceViewEvents() {
  // This will be called when perform.js is loaded
  console.log("Performance views initialized");
}

// Open modeller view
function openModellerView(taskData, role) {
  console.log("Opening modeller view for:", role, taskData);

  currentPerformanceTask = taskData;
  currentPerformanceRole = role;
  _modResubmitFile = null;

  // Hide all other views
  hideAllTables();
  hideWelcome();

  // Show the modeller performance view
  showModellerPerformanceView();
}

function showModellerPerformanceView() {
  const rightPanel = document.querySelector(".right-panel");
  if (!rightPanel) return;

  // Create the modeller view HTML
  const modellerViewHTML = createModellerViewHTML();

  // Insert after menu-bar
  const menuBar = rightPanel.querySelector(".menu-bar");
  if (menuBar && menuBar.nextSibling) {
    const existingView = document.getElementById("modeller-performance-view");
    if (existingView) {
      existingView.remove();
    }

    const modellerDiv = document.createElement("div");
    modellerDiv.id = "modeller-performance-view";
    modellerDiv.innerHTML = modellerViewHTML;

    // Insert after menu-bar
    rightPanel.insertBefore(modellerDiv, menuBar.nextSibling);
  }

  // Setup event listeners for the new view
  setupModellerViewEventListeners();

  // Load history data
  loadModellerTaskHistory();
  loadLinelistDataStrip();
}

function createModellerViewHTML() {
  const task = currentPerformanceTask;
  const commentTypes = task.commentTypes || ["No Comments"];

  return `
        <div class="modeller-view-container">
            <!-- Task Details Table -->
            <div class="task-details-table-container" style="margin-bottom: 20px; width: 100%;">
                <table class="data-table" style="width: 100%;">
                    <thead>
                        <tr>
                            <th>Job No</th>
                            <th>Unit no</th>
                            <th>Line No</th>
                            <th>Rev No</th>
                            <th>Stress Critical (Y/N)</th>
                            <th>From</th>
                            <th>Date & Time Claimed</th>
                            <th>Comment Received From</th>
                            <th>Claimed As</th>
                        </tr>
                    </thead>
                    <tbody oncontextmenu="showLineContextMenu(event, currentPerformanceTask)">
                        <tr>
                            <td>${task.jobNo}</td>
                            <td>${task.unitNo}</td>
                            <td>${task.lineNo}</td>
                            <td>${task.revNo}</td>
                            <td>${task.stressCritical}</td>
                            <td>${task.from}</td>
                            <td>${formatDateTime(task.claimedOn)}</td>
                            <td class="comment-types">${commentTypes.join(
    ", "
  )}</td>
                            <td class="claimed-roles">
                                <label class="role-checkbox-label claimed">
                                    <input type="checkbox" checked disabled>
                                    Modeller
                                </label>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Process Engineering Data Strip -->
            <div id="ll-data-strip"></div>

            <!-- Main Content Area -->
            <div class="modeller-main-content" style="display: flex; gap: 20px; height: 60vh;">
                <!-- Left Side: History Table -->
                <div class="history-section" style="flex: 1;">
                    <h4>File History</h4>
                    <div class="history-table-container" style="max-height: 400px; overflow-y: auto; border: 1px solid #ddd;">
                        <table class="history-table" style="width: 100%; border-collapse: collapse;">
                            <thead style="background-color: #f8f9fa; position: sticky; top: 0;">
                                 <tr>
                                    <th style="border: 1px solid #ddd; padding: 8px;">File Name</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Rev-No.</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Comment From</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Comment Type</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Date & Time</th>
                                </tr>

                            </thead>
                            <tbody id="modeller-history-table-body">
                                <!-- History data will be loaded here -->
                            </tbody>
                        </table>
                    </div>
                </div>
                
                <!-- Right Side: Comment Details and Actions -->
                <div class="modeller-action-section" style="flex: 1; border: 1px solid #ddd; border-radius: 6px;">
                    <div id="modeller-details-content" style="padding: 20px; height: 100%; overflow-y: auto;">
                        <div style="text-align: center; color: #666; padding: 50px 20px;">
                            <h4>Comment Details</h4>
                            <p>Click on a row in the history table to view comment details and download options</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Re-submission Section -->
            <div class="modeller-upload-section" style="width:100%;margin-top:20px;padding:20px;background:var(--bg-card,#1e2433);border:1px solid var(--border,#2e3650);border-radius:8px;">
                <h4 style="margin:0 0 14px;color:var(--gold,#f5c518);">Submit Incorporated ISO</h4>

                <!-- Drop zone -->
                <div id="mod-drop-zone" style="border:2px dashed var(--border,#2e3650);border-radius:6px;padding:28px 20px;text-align:center;cursor:pointer;transition:border-color .2s;margin-bottom:14px;"
                     onclick="document.getElementById('mod-file-input').click()"
                     ondragover="event.preventDefault();this.style.borderColor='var(--gold,#f5c518)'"
                     ondragleave="this.style.borderColor='var(--border,#2e3650)'"
                     ondrop="event.preventDefault();this.style.borderColor='var(--border,#2e3650)';_handleModDroppedFile(event.dataTransfer.files[0])">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted,#8892b0)" stroke-width="1.5" style="margin-bottom:8px;display:block;margin-left:auto;margin-right:auto"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    <p id="mod-drop-label" style="margin:0;color:var(--text-muted,#8892b0);font-size:14px;">Drag &amp; drop the revised ISO here, or <span style="color:var(--gold,#f5c518);text-decoration:underline;">browse</span></p>
                    <input type="file" id="mod-file-input" accept=".pdf" style="display:none" onchange="_handleModDroppedFile(this.files[0])">
                </div>

                <!-- Optional comment -->
                <div style="margin-bottom:14px;">
                    <label style="display:block;font-size:13px;color:var(--text-muted,#8892b0);margin-bottom:6px;">Comments / Notes (optional)</label>
                    <textarea id="mod-comment-input" rows="3" placeholder="Any remarks for the checkers…"
                        style="width:100%;box-sizing:border-box;background:var(--bg-deep,#151a27);border:1px solid var(--border,#2e3650);border-radius:4px;color:var(--text,#cdd6f4);padding:8px 10px;font-size:13px;resize:vertical;"></textarea>
                </div>

                <!-- Status message -->
                <p id="mod-submit-status" style="margin:0 0 10px;font-size:13px;min-height:18px;"></p>

                <!-- Submit button -->
                <button id="mod-submit-btn" disabled onclick="submitModellerResubmit()"
                    style="background:var(--gold,#f5c518);color:#111;border:none;padding:10px 28px;border-radius:5px;font-size:15px;font-weight:600;cursor:not-allowed;opacity:.5;transition:opacity .2s;">
                    POST
                </button>
            </div>
        </div>
    `;
}

function setupModellerViewEventListeners() {
  // History table row clicks
  document.addEventListener("click", (e) => {
    const row = e.target.closest("#modeller-history-table-body tr");
    if (row) {
      const index = parseInt(row.dataset.index);
      showModellerCommentDetails(index);

      // Highlight selected row
      document
        .querySelectorAll("#modeller-history-table-body tr")
        .forEach((r) => r.classList.remove("selected-history-row"));
      row.classList.add("selected-history-row");
    }
  });
}

async function loadModellerTaskHistory() {
  try {
    const response = await fetch(
      `/api/task-history?lineNo=${currentPerformanceTask.lineNo}&jobNo=${currentPerformanceTask.jobNo}`
    );
    const data = await response.json();

    if (data.ok) {
      window.currentModellerHistory = data.history;
      renderModellerTaskHistory(data.history);
    }
  } catch (error) {
    console.error("Error loading modeller task history:", error);
  }
  renderLineEngData();
}

function renderModellerTaskHistory(history) {
  const tbody = document.getElementById("modeller-history-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!history || history.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="no-data">No history available</td></tr>';
    return;
  }

  // Sort history - latest first
  const sortedHistory = history.sort(
    (a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn)
  );

  // Helper: map item -> comment type label (exact labels requested)
  function getModellerCommentType(item) {
    // Prefer explicit commentType from server when it's already correct
    if (item.commentType && typeof item.commentType === "string") {
      const raw = item.commentType || "";
      const low = raw.toLowerCase();
      if (low.includes("annotat")) return "Commented: Annotated";
      if (
        low === "no-comment" ||
        low.includes("no comment") ||
        low.includes("no-comments")
      )
        return "no-comment";
      if (low.includes("commented: text") || low === "commented: text")
        return "Commented: Text";
      if (low.includes("commented: file") || low === "commented: file")
        return "Commented: File";
      // fall through to other checks
    }

    // If server didn't provide consistent commentType, fall back to fileType
    if (item.fileType === "text") return "Commented: Text";
    if (item.fileType === "base") return "Base Upload";
    if (item.fileType === "comment") {
      // Inspect filename or role if available
      const fname = (item.fileName || "").toLowerCase();
      if (fname.includes("_pmsa") || fname.includes("_pmsaa"))
        return "no-comment"; // GL/SGL no-comments variants
      if (
        fname.includes("_pmsa") ||
        fname.includes("_pmsaa") ||
        fname.includes("_annot")
      )
        return "Commented: Annotated";
      return "Commented: File";
    }
    // final fallback
    return item.commentType || "";
  }

  // Helper: display short comment text in the table
  function getDisplayComment(item) {
    if (item.fileType === "text") {
      if (!item.comment) return "";
      return item.comment.length > 50
        ? item.comment.substring(0, 50) + "..."
        : item.comment;
    }
    if (item.fileType === "comment") return "Commented File";
    return "Base Upload";
  }

  sortedHistory.forEach((item, index) => {
    const row = document.createElement("tr");
    row.dataset.index = index;
    row.style.cursor = "pointer";

    // Determine commentFrom: try to re-use the existing helper if present
    let commentFrom = "Unknown";
    try {
      // determineCommentFrom(item, history) exists elsewhere in this file
      if (typeof determineCommentFrom === "function") {
        commentFrom = determineCommentFrom(item, sortedHistory);
      } else {
        // fallback to simple checks
        if (item.role) commentFrom = item.role;
        else if (item.uploadedBy) commentFrom = item.uploadedBy;
        else commentFrom = "Unknown";
      }
    } catch (e) {
      commentFrom = item.uploadedBy || "Unknown";
    }

    const commentTypeLabel = getModellerCommentType(item);
    const displayComment = getDisplayComment(item);

    // File link (prefer comment folder path when present)
    const isCommentFile = item.filePath && item.filePath.includes("/comments/");
    const displayPath = isCommentFile
      ? item.filePath
      : `uploads/${item.jobNo || ""}/${item.unitNo || ""}/${item.zone || ""}/${item.fileName || ""
      }`;
    const fileNameCell = `<a href="/${displayPath}" target="_blank" style="color: #007bff; text-decoration: none;">${item.fileName}</a>`;

    // If the row is a text-comment, make the comment-type clickable to show the popup
    let commentTypeCell = commentTypeLabel;
    if (commentTypeLabel === "Commented: Text") {
      const safeComment = (item.comment || "").replace(/'/g, "\\'");
      commentTypeCell = `<span style="color: #007bff; cursor: pointer; text-decoration: underline;" onclick="showTextCommentPopup('${safeComment}')">${commentTypeLabel}</span>`;
    }

    // If the server supplied a user-friendly uploadedBy name, use that in details; for table we use commentFrom
    row.innerHTML = `
      <td style="border: 1px solid #ddd; padding: 8px;">${fileNameCell}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${item.revNo || ""}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${commentFrom}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${commentTypeCell}</td>
      <td style="border: 1px solid #ddd; padding: 8px;">${new Date(
      item.uploadedOn
    ).toLocaleString()}</td>
    `;

    tbody.appendChild(row);
  });
}

function showModellerCommentDetails(index) {
  const history = window.currentModellerHistory || [];
  const item = history[index];

  if (!item) return;

  const detailsContent = document.getElementById("modeller-details-content");
  if (!detailsContent) return;

  let detailsHTML = `
        <div class="modeller-comment-details">
            <h4>Details: ${item.fileName}</h4>
            <div class="detail-item">
                <strong>Type:</strong> ${item.commentType}
            </div>
            <div class="detail-item">
                <strong>From:</strong> ${item.uploadedBy}
            </div>
            <div class="detail-item">
                <strong>Date & Time:</strong> ${new Date(
    item.uploadedOn
  ).toLocaleString()}
            </div>
    `;

  if (item.fileType === "text") {
    detailsHTML += `
            <div class="detail-item">
                <strong>Comment:</strong>
                <div style="background: #fff; padding: 15px; border-radius: 4px; margin-top: 10px; border: 1px solid #ddd; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">${item.comment}</div>
            </div>
        `;
  } else if (item.fileType === "comment") {
    detailsHTML += `
            <div class="detail-item">
                <strong>Comment Method:</strong> Uploaded PDF File
            </div>
            <div class="detail-item">
                <strong>Role:</strong> ${item.role}
            </div>
            <div style="margin-top: 20px; text-align: center;">
                <a href="/${item.filePath}" target="_blank" style="background: #007bff; color: white; padding: 12px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
                    View PDF
                </a>
                <a href="/${item.filePath}" download style="background: #28a745; color: white; padding: 12px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
                    Download PDF
                </a>
            </div>
        `;
  } else if (item.fileType === "base") {
    detailsHTML += `
            <div class="detail-item">
                <strong>Description:</strong> Original isometric file
            </div>
            <div style="margin-top: 20px; text-align: center;">
                <a href="/${item.filePath}" target="_blank" style="background: #007bff; color: white; padding: 12px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
                    View Original PDF
                </a>
            </div>
        `;
  }

  detailsHTML += `
        </div>
    `;

  detailsContent.innerHTML = detailsHTML;
}

// ----- Modeller re-submission helpers -----

let _modResubmitFile = null;

function _handleModDroppedFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    const status = document.getElementById("mod-submit-status");
    if (status) { status.textContent = "Only PDF files are allowed."; status.style.color = "#e06c75"; }
    return;
  }
  _modResubmitFile = file;
  const label = document.getElementById("mod-drop-label");
  if (label) label.textContent = `Selected: ${file.name}`;
  const btn = document.getElementById("mod-submit-btn");
  if (btn) { btn.disabled = false; btn.style.opacity = "1"; btn.style.cursor = "pointer"; }
  const status = document.getElementById("mod-submit-status");
  if (status) { status.textContent = ""; }
}

async function submitModellerResubmit() {
  const btn = document.getElementById("mod-submit-btn");
  const status = document.getElementById("mod-submit-status");
  if (!_modResubmitFile || !currentPerformanceTask) return;

  const task = currentPerformanceTask;
  const comment = (document.getElementById("mod-comment-input")?.value || "").trim();

  btn.disabled = true;
  btn.textContent = "Uploading…";
  if (status) { status.textContent = ""; }

  const fd = new FormData();
  fd.append("file", _modResubmitFile, _modResubmitFile.name);
  fd.append("jobNo", task.jobNo);
  fd.append("unitNo", task.unitNo);
  fd.append("lineNo", task.lineNo);
  fd.append("zone", task.zone || "");
  if (comment) fd.append("comment", comment);

  try {
    const resp = await fetch("/api/modeller-resubmit", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.ok) {
      if (status) { status.textContent = "Re-submission successful! Checkers have been notified."; status.style.color = "var(--green,#a6e22e)"; }
      btn.textContent = "Submitted ✓";
      btn.style.background = "var(--green,#a6e22e)";
      _modResubmitFile = null;
      // Refresh modeller tasks list after a short delay
      setTimeout(() => {
        if (typeof loadModellerTasks === "function") loadModellerTasks();
        else if (typeof refreshMyTasks === "function") refreshMyTasks();
      }, 1500);
    } else {
      if (status) { status.textContent = data.error || "Upload failed."; status.style.color = "#e06c75"; }
      btn.disabled = false;
      btn.textContent = "POST";
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  } catch (err) {
    if (status) { status.textContent = "Network error — please try again."; status.style.color = "#e06c75"; }
    btn.disabled = false;
    btn.textContent = "POST";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
  }
}

// Open checker view (PC, MC, SC)
function openCheckerView(taskData, role) {
  console.log('Opening checker view for:', role, taskData);
  currentPerformanceTask = taskData;


  currentPerformanceRole = role;

  // Hide all other views
  hideAllTables();
  hideWelcome();

  // Show the checker performance view
  showCheckerPerformanceView();
}

function showCheckerPerformanceView() {
  const rightPanel = document.querySelector(".right-panel");
  if (!rightPanel) return;

  // Create the checker view HTML
  const checkerViewHTML = createCheckerViewHTML();

  // Insert after menu-bar
  const menuBar = rightPanel.querySelector(".menu-bar");
  if (menuBar && menuBar.nextSibling) {
    const existingCheckerView = document.getElementById(
      "checker-performance-view"
    );
    if (existingCheckerView) {
      existingCheckerView.remove();
    }

    const checkerDiv = document.createElement("div");
    checkerDiv.id = "checker-performance-view";
    checkerDiv.innerHTML = checkerViewHTML;

    // Insert after menu-bar
    rightPanel.insertBefore(checkerDiv, menuBar.nextSibling);
  }

  // Setup event listeners for the new view
  setupCheckerViewEventListeners();
  setupClickableHeaderTbody();

  // Load history data
  loadTaskHistory();
  loadLinelistDataStrip();
  loadModellerSelector();
}

// === Shared function: make task header tbody clickable in Checker, GL, and SGL ===
function setupClickableHeaderTbody() {
  ["checker-performance-view", "gl-performance-view", "sgl-performance-view"].forEach((viewId) => {
    const observer = new MutationObserver(() => {
      const view = document.getElementById(viewId);
      if (!view) return;

      const tbody = view.querySelector(".task-details-table-container tbody");
      if (tbody && !tbody.dataset.clickable) {
        tbody.dataset.clickable = "true";
        tbody.style.cursor = "pointer";
        tbody.style.transition = "background-color 0.25s ease, box-shadow 0.25s ease";


        // Hover effects — darker shade, same color across Checker/GL/SGL
        tbody.addEventListener("mouseenter", () => {
          tbody.style.backgroundColor = "#e8e8e8"; // slightly darker than #f2f2f2
          tbody.style.boxShadow = "0 0 8px rgba(0, 0, 0, 0.1)";
        });
        tbody.addEventListener("mouseleave", () => {
          tbody.style.backgroundColor = "";
          tbody.style.boxShadow = "none";
        });


        // Click behavior (reuse your existing logic)
        tbody.addEventListener("click", async (ev) => {
          if (ev.target.closest("a")) return;
          console.log(`[${viewId}] header row clicked - resolving file to open`);
          // reuse the logic block already implemented in your observer for PDF selection
          await handleHeaderClickForRole(viewId);
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// === Helper for file-opening logic reused by all three roles ===
async function handleHeaderClickForRole(viewId) {
  try {
    const resp = await fetch(`/api/task-history?lineNo=${currentPerformanceTask.lineNo}&jobNo=${currentPerformanceTask.jobNo}`, { credentials: "same-origin" });
    if (!resp.ok) return;
    const js = await resp.json();
    if (!js.ok || !Array.isArray(js.history)) return;
    const history = js.history.slice().sort((a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn));

    const isBase = (i) => (i.fileType === "base") || (i.filePath && !i.filePath.includes("/comments/"));
    const isCommented = (i) => i.filePath && i.filePath.includes("/comments/");
    const isNoComments = (i) => {
      const f = (i.fileName || "").toLowerCase();
      const c = (i.commentType || "").toLowerCase();
      const t = (i.type || "").toLowerCase();
      return c.includes("no") || t.includes("no") || /_pmsa|_pmsaa|pmsa|pmsaa|no_comments/i.test(f);
    };

    const role = currentPerformanceRole ? currentPerformanceRole.toString().toUpperCase() : (
      viewId.includes("checker") ? "CHECKER" :
        viewId.includes("gl") ? "GL" :
          viewId.includes("sgl") ? "SGL" : ""
    );

    let fileItem = null;
    if (role.includes("CHECKER")) {
      const latestC = history.find(isCommented);
      const latestB = history.find(isBase);
      if (!latestC && latestB) fileItem = latestB;
      else if (!latestB && latestC) fileItem = latestC;
      else if (latestC && latestB) {
        fileItem = new Date(latestC.uploadedOn) >= new Date(latestB.uploadedOn) ? latestC : latestB;
      }
    } else if (role === "GL") {
      const latestNo = history.find(isNoComments);
      const latestSGL = history.find((h) => isCommented(h) && /sgl|pmsaa/i.test(h.fileName || ""));
      const latestAnyC = history.find(isCommented);
      const candidates = [latestNo, latestSGL || latestAnyC].filter(Boolean);
      fileItem = candidates.sort((a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn))[0] || history[0];
    } else if (role === "SGL") {
      const latestGLNo = history.find((h) => isNoComments(h) && /gl|pmsa/i.test(h.fileName || ""));
      fileItem = latestGLNo || history.find(isNoComments) || history[0];
    } else {
      fileItem = history[0];
    }

    if (!fileItem) {
      alert("No valid file found to open.");
      return;
    }

    let fp = fileItem.filePath || "";
    if (!fp) {
      const job = fileItem.jobNo || currentPerformanceTask?.jobNo || "";
      const unit = fileItem.unitNo || currentPerformanceTask?.unitNo || "";
      const zone = fileItem.zone || currentPerformanceTask?.zone || "";
      const fname = fileItem.fileName || fileItem.storedFile || "";
      fp = `uploads/${job}/${unit}/${zone}/${fname}`.replace(/\/{2,}/g, "/");
    }

    const finalPath = fp.startsWith("/") ? fp : "/" + fp;
    window.open(finalPath, "_blank");
  } catch (err) {
    console.error("Error resolving latest file for role:", err);
  }
}


function createCheckerViewHTML() {
  const task = currentPerformanceTask;
  const role = currentPerformanceRole;
  const claimedRoles = task.claimedRoles || [];

  // Determine role display
  const roleLabels = {
    PC: "Process Checker",
    MC: "Material Checker",
    SC: "Stress Checker",
  };

  const roleDisplays = claimedRoles.map((r) => roleLabels[r] || r).join(", ");

  const stressColor = task.stressCritical === 'Y' ? '#b91c1c' : '#15803d';
  const stressBg    = task.stressCritical === 'Y' ? '#fef2f2' : '#f0fdf4';
  const roleBadges  = claimedRoles.map(r => {
    const colors = { PC: '#1d4ed8:#dbeafe', MC: '#6d28d9:#ede9fe', SC: '#b91c1c:#fee2e2' };
    const [fg, bg] = (colors[r] || '#374151:#f3f4f6').split(':');
    return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:5px;font-size:11.5px;font-weight:600;background:${bg};color:${fg};">
      <input type="checkbox" checked disabled style="margin:0;accent-color:${fg};">${r}
    </span>`;
  }).join('');

  return `
    <div class="checker-view-container" style="display:flex;flex-direction:column;gap:14px;padding:4px 0;">

      <!-- ── Line Info Card ── -->
      <div class="task-details-table-container"
           style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);"
           oncontextmenu="showLineContextMenu(event, currentPerformanceTask)">
        <!-- Header strip -->
        <div style="background:linear-gradient(135deg,#1e40af,#2563eb);padding:10px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="1.8" style="width:16px;height:16px;flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span style="font-size:13px;font-weight:700;color:#fff;letter-spacing:.02em;">${task.lineNo}</span>
          <span style="color:rgba(255,255,255,0.45);font-size:12px;">·</span>
          <span style="font-size:12px;color:rgba(255,255,255,0.8);">${task.jobNo} &nbsp;/&nbsp; Unit ${task.unitNo}</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center;">${roleBadges}</span>
        </div>
        <!-- Meta row -->
        <div style="display:flex;gap:0;flex-wrap:wrap;border-top:1px solid #e2e8f0;">
          ${[
            ['Rev / Upload', task.revNo],
            ['Stress Critical', `<span style="font-weight:700;color:${stressColor};background:${stressBg};padding:1px 8px;border-radius:4px;font-size:12px;">${task.stressCritical}</span>`],
            ['From', task.from],
            ['Claimed', formatDateTime(task.claimedOn)],
          ].map(([k,v]) => `
            <div style="padding:10px 18px;flex:1;min-width:140px;border-right:1px solid #f1f5f9;">
              <div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">${k}</div>
              <div style="font-size:13px;font-weight:600;color:#1e293b;">${v}</div>
            </div>`).join('')}
        </div>
        <!-- Hidden tbody to keep JS selector .task-details-table-container tbody working -->
        <table style="display:none;"><tbody oncontextmenu="showLineContextMenu(event, currentPerformanceTask)"><tr><td>${task.lineNo}</td></tr></tbody></table>
      </div>

      <!-- ── Engineering + LMS Data (injected dynamically by loadLinelistDataStrip / loadLmsDataStrip) ── -->
      <div id="ll-data-strip"></div>

      <!-- ── GL/SGL Commented action panel (only when status = GL Commented or SGL Commented) ── -->
      ${(task.status === 'GL Commented' || task.status === 'SGL Commented') ? `
      <div id="gl-commented-panel" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px 18px;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="background:#ea580c;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.04em;">${task.status === 'SGL Commented' ? 'SGL COMMENTED' : 'GL COMMENTED'}</span>
          <span style="font-size:13px;font-weight:600;color:#9a3412;">${task.status === 'SGL Commented' ? 'SGL' : 'GL'} has reviewed and commented this line</span>
        </div>
        <div style="font-size:12.5px;color:#78350f;margin-bottom:12px;">
          Choose how to proceed — or use the comment options below to address ${task.status === 'SGL Commented' ? 'SGL' : 'GL'}'s concern directly.
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button id="btn-fwd-direct" style="padding:8px 16px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;">
            Send to Modeller
          </button>
          <button id="btn-fwd-edit" style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;">
            Edit &amp; Send to Modeller
          </button>
        </div>
        <!-- Edit panel (shown when "Edit & Send" clicked) -->
        <div id="gl-edit-panel" style="display:none;margin-top:14px;padding:12px;background:#fff;border:1px solid #fed7aa;border-radius:6px;">
          <div style="font-size:12px;font-weight:600;color:#78350f;margin-bottom:8px;">Add your notes for the Modeller:</div>
          <textarea id="gl-edit-comment" placeholder="Describe what needs to be incorporated…"
            style="width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:5px;padding:7px 10px;font-size:12.5px;min-height:60px;resize:vertical;"></textarea>
          <div style="margin-top:8px;">
            <label style="font-size:12px;color:#78350f;font-weight:600;">Or attach an edited file (optional):</label>
            <input type="file" id="gl-edit-file" accept=".pdf" style="display:block;margin-top:5px;font-size:12px;">
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="btn-confirm-edit-fwd" style="padding:7px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;">
              Confirm &amp; Send to Modeller
            </button>
            <button id="btn-cancel-edit-fwd" style="padding:7px 14px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:12.5px;cursor:pointer;">
              Cancel
            </button>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- ── History + Comments (side by side) ── -->
      <div style="display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start;">

        <!-- History -->
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
          <div style="background:#f8fafc;padding:10px 16px;border-bottom:1px solid #e2e8f0;">
            <span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.7px;">History</span>
          </div>
          <div class="history-section" style="padding:0;">
            <div class="history-table-container" style="max-height:280px;overflow-y:auto;">
              <table class="history-table" style="width:100%;border-collapse:collapse;">
                <thead>
                  <tr style="position:sticky;top:0;z-index:1;">
                    <th style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;white-space:nowrap;">File Name</th>
                    <th style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;white-space:nowrap;">Rev</th>
                    <th style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;white-space:nowrap;">From</th>
                    <th style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;white-space:nowrap;">Comment Type</th>
                    <th style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;white-space:nowrap;">Date &amp; Time</th>
                  </tr>
                </thead>
                <tbody id="history-table-body"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Add Comments -->
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
          <div style="background:#f8fafc;padding:10px 16px;border-bottom:1px solid #e2e8f0;">
            <span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.7px;">Add Comments</span>
          </div>
          <div class="comment-section" style="padding:14px 16px;">
            <div class="comment-options" style="display:flex;flex-direction:column;gap:14px;">
              <div class="comment-option">
                <label for="text-comment" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="radio" id="text-comment" name="comment-type" value="text"> Add Comment
                </label>
                <textarea id="comment-text" placeholder="Enter your comments here..." disabled
                  style="margin-top:6px;width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:6px;padding:8px;font-size:12.5px;resize:vertical;min-height:70px;"></textarea>
              </div>
              <div class="comment-option">
                <label for="file-comment" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="radio" id="file-comment" name="comment-type" value="file"> Upload Commented File
                </label>
                <input type="file" id="comment-file" accept=".pdf" disabled style="margin-top:6px;font-size:12px;">
              </div>
              <div class="comment-option">
                <label for="annotation-comment" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="radio" id="annotation-comment" name="comment-type" value="annotation"> Annotate PDF In-Browser
                </label>
                <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
                  <button id="open-annotation-btn" disabled
                    style="padding:5px 14px;font-size:12px;border:1px solid #cbd5e1;border-radius:5px;background:#f8fafc;cursor:default;">
                    Open Annotator
                  </button>
                  <span id="annotation-upload-info" style="color:#16a34a;font-weight:600;font-size:12px;"></span>
                </div>
              </div>
              <div class="comment-option">
                <label for="no-comment" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="radio" id="no-comment" name="comment-type" value="none"> No Comments
                </label>
              </div>
            </div>
          </div>
        </div>

      </div><!-- /grid -->

      <!-- ── Role Selection + Modeller Routing ── -->
      ${generateRoleSelectionSection(claimedRoles)}
      ${generateModellerRoutingSection()}

      <!-- ── POST Button ── -->
      <div class="post-button-container" style="text-align:center;padding:4px 0 8px;">
        <button id="post-comments-btn" class="post-btn">POST</button>
      </div>

    </div>
  `;
}


function generateRoleSelectionSection(claimedRoles) {
  if (claimedRoles.length <= 1) return "";

  return `
        <div class="role-selection-section" style="width: 100%; margin-bottom: 20px; padding: 15px; background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px;">
            <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                <label style="font-weight: bold; color: #856404; margin: 0;">Comments are for:</label>
                <div class="role-checkboxes" style="display: flex; gap: 15px; flex-wrap: wrap;">
                    ${claimedRoles
      .map(
        (role) => `
                        <label class="comment-role-label">
                            <input type="checkbox" class="comment-role-checkbox" value="${role}">
                            ${role}
                        </label>
                    `
      )
      .join("")}
                </div>
            </div>
        </div>
    `;
}

function generateModellerRoutingSection() {
  const task = currentPerformanceTask;
  const uploadedBy = task?.from;
  const isSystem = !uploadedBy || uploadedBy === 'SYSTEM' || uploadedBy === 'System';
  const hint = isSystem
    ? 'Will be broadcast to the modeller pool (system upload — no original uploader)'
    : 'Pre-selected: original uploader. Change if needed.';

  return `
    <div id="modeller-routing-section" style="width:100%;margin-bottom:16px;padding:12px 15px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <label style="font-weight:bold;color:#2e7d32;margin:0;white-space:nowrap;font-size:13px;">Return to Modeller:</label>
      <select id="target-modeller-select" style="padding:5px 10px;border:1px solid #a5d6a7;border-radius:4px;font-size:13px;min-width:200px;background:#fff;">
        <option value="">Loading...</option>
      </select>
      <span id="modeller-routing-hint" style="font-size:12px;color:#555;font-style:italic;">${hint}</span>
    </div>
  `;
}

async function loadModellerSelector() {
  const task = currentPerformanceTask;
  if (!task) return;
  const sel = document.getElementById('target-modeller-select');
  if (!sel) return;

  try {
    const resp = await fetch(`/api/modellers?jobNo=${encodeURIComponent(task.jobNo)}&unitNo=${encodeURIComponent(task.unitNo)}`);
    const data = await resp.json();
    if (!data.ok) return;

    const modellers = data.users || [];
    sel.innerHTML = '<option value="">-- Modeller pool (no specific person) --</option>';
    for (const m of modellers) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.id})`;
      sel.appendChild(opt);
    }

    // Pre-select if line was manually uploaded (from = user ID, not SYSTEM)
    const uploadedBy = task.from;
    if (uploadedBy && uploadedBy !== 'SYSTEM' && uploadedBy !== 'System') {
      sel.value = uploadedBy;
    }

    updateModellerRoutingHint();
    sel.addEventListener('change', updateModellerRoutingHint);
  } catch (err) {
    console.error('Error loading modellers:', err);
    if (sel) sel.innerHTML = '<option value="">Could not load modellers</option>';
  }
}

function updateModellerRoutingHint() {
  const sel = document.getElementById('target-modeller-select');
  const hint = document.getElementById('modeller-routing-hint');
  if (!sel || !hint) return;
  if (sel.value) {
    const name = sel.options[sel.selectedIndex]?.text || sel.value;
    hint.textContent = `Will go directly to ${name}'s inbox`;
    hint.style.color = '#2e7d32';
  } else {
    hint.textContent = 'Will be broadcast to the modeller pool';
    hint.style.color = '#888';
  }
}

function setupCheckerViewEventListeners() {
  // Comment type radio button listeners
  const commentTypeRadios = document.querySelectorAll(
    'input[name="comment-type"]'
  );
  commentTypeRadios.forEach((radio) => {
    radio.addEventListener("change", handleCommentTypeChange);
  });

  // Post comments button
  const postBtn = document.getElementById("post-comments-btn");
  // Open Annotator button
  const annotatorBtn = document.getElementById("open-annotation-btn");
  if (annotatorBtn) {
    annotatorBtn.addEventListener("click", async () => {
      try {
        // Always take the modeller’s base file from drawing.json
        const resp = await fetch(
          `/api/get-base-file?jobNo=${encodeURIComponent(
            currentPerformanceTask.jobNo
          )}&unitNo=${encodeURIComponent(
            currentPerformanceTask.unitNo
          )}&lineNo=${encodeURIComponent(currentPerformanceTask.lineNo)}`,
          { credentials: "same-origin" }
        );
        const js = await resp.json();
        if (!resp.ok || !js.ok || !js.baseFilePath) {
          alert("No modeller-uploaded base PDF found for this task");
          return;
        }

        // Ensure leading slash for the viewer
        const cleanPath = js.baseFilePath.startsWith("/")
          ? js.baseFilePath
          : "/" + js.baseFilePath;

        // Open viewer WITHOUT roles; roles are chosen at POST time
        const url = `/pdfviewer.html?file=${encodeURIComponent(cleanPath)}`;
        window.open(url, "_blank");
      } catch (err) {
        console.error("Error fetching base file path for annotator:", err);
        alert("Error fetching base PDF. See console for details.");
      }
    });
  }

  if (postBtn) {
    postBtn.addEventListener("click", handlePostComments);
  }

  // ── GL Commented action panel buttons ──────────────────────────────────
  const btnDirect = document.getElementById('btn-fwd-direct');
  const btnEdit   = document.getElementById('btn-fwd-edit');
  const btnConfirm= document.getElementById('btn-confirm-edit-fwd');
  const btnCancel = document.getElementById('btn-cancel-edit-fwd');

  if (btnDirect) btnDirect.addEventListener('click', () => handleForwardGLToModeller('direct'));
  if (btnEdit) btnEdit.addEventListener('click', () => {
    const panel = document.getElementById('gl-edit-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  if (btnConfirm) btnConfirm.addEventListener('click', () => handleForwardGLToModeller('edit'));
  if (btnCancel) btnCancel.addEventListener('click', () => {
    const panel = document.getElementById('gl-edit-panel');
    if (panel) panel.style.display = 'none';
  });

  // Back to tasks button
  const backBtn = document.getElementById("back-to-tasks-btn");
  if (backBtn) {
    backBtn.addEventListener("click", handleBackToTasks);
  }
  // --- Make all role checkboxes toggle together ---
  const roleCheckboxes = document.querySelectorAll(".comment-role-checkbox");
  if (roleCheckboxes.length > 1) {
    roleCheckboxes.forEach((cb) => {
      cb.addEventListener("change", () => {
        const newState = cb.checked;
        roleCheckboxes.forEach((otherCb) => {
          otherCb.checked = newState;
        });
      });
    });
  }
  // --- End role checkbox linking ---

  // --- Auto-check all role checkboxes on load ---
  roleCheckboxes.forEach((cb) => {
    cb.checked = true;
  });
}

// Listen for annotation save messages from pdfviewer
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "ANNOTATION_SAVED") {
    const savedPath = event.data.savedPath;

    // Show file upload info near the Annotator button
    const annotBtn = document.getElementById("open-annotation-btn");
    if (annotBtn) {
      let infoEl = document.getElementById("annotation-upload-info");
      if (!infoEl) {
        infoEl = document.createElement("div");
        infoEl.id = "annotation-upload-info";
        infoEl.style.color = "red";
        infoEl.style.marginTop = "6px";
        annotBtn.insertAdjacentElement("afterend", infoEl);
      }
      infoEl.textContent = "File Annotated";
    }

    // Also handle GL annotation info
    const glAnnotBtn = document.getElementById("gl-open-annotation-btn");
    if (glAnnotBtn) {
      let glInfoEl = document.getElementById("gl-annotation-upload-info");
      if (!glInfoEl) {
        glInfoEl = document.createElement("div");
        glInfoEl.id = "gl-annotation-upload-info";
        glInfoEl.style.color = "red";
        glInfoEl.style.marginTop = "6px";
        glAnnotBtn.insertAdjacentElement("afterend", glInfoEl);
      }
      glInfoEl.textContent = "File Annotated";
    }

    // Also handle SGL annotation info
    const sglAnnotBtn = document.getElementById("sgl-open-annotation-btn");
    if (sglAnnotBtn) {
      let sglInfoEl = document.getElementById("sgl-annotation-upload-info");
      if (!sglInfoEl) {
        sglInfoEl = document.createElement("div");
        sglInfoEl.id = "sgl-annotation-upload-info";
        sglInfoEl.style.color = "red";
        sglInfoEl.style.marginTop = "6px";
        sglAnnotBtn.insertAdjacentElement("afterend", sglInfoEl);
      }
      sglInfoEl.textContent = "File Annotated";
    }
  }
});

function handleCommentTypeChange(event) {
  const commentType = event.target.value;
  const commentText = document.getElementById("comment-text");
  const commentFile = document.getElementById("comment-file");

  // Reset all
  if (commentText) commentText.disabled = true;
  if (commentFile) commentFile.disabled = true;

  // Enable relevant input
  if (commentType === "text" && commentText) {
    commentText.disabled = false;
    commentText.focus();
  } else if (commentType === "file" && commentFile) {
    commentFile.disabled = false;
  }
  // Annotation option: enable button
  const annotateBtn = document.getElementById("open-annotation-btn");
  if (commentType === "annotation") {
    annotateBtn.disabled = false;
  } else if (annotateBtn) {
    annotateBtn.disabled = true;
  }
}

async function handlePostComments() {
  const commentType = document.querySelector(
    'input[name="comment-type"]:checked'
  );

  if (!commentType) {
    alert("Please select a comment type");
    return;
  }

  // Check role selection if multiple roles
  const claimedRoles = currentPerformanceTask.claimedRoles || [];
  const selectedRoles = [];

  if (claimedRoles.length > 1) {
    const roleCheckboxes = document.querySelectorAll(
      ".comment-role-checkbox:checked"
    );
    roleCheckboxes.forEach((cb) => selectedRoles.push(cb.value));

    if (selectedRoles.length === 0) {
      alert("Please select at least one role for comments");
      return;
    }
  } else {
    selectedRoles.push(claimedRoles[0]);
  }

  // Prepare comment data
  const targetModellerSelect = document.getElementById('target-modeller-select');
  const commentData = {
    taskId: currentPerformanceTask.lineNo,
    jobNo: currentPerformanceTask.jobNo,
    unitNo: currentPerformanceTask.unitNo,
    lineNo: currentPerformanceTask.lineNo,
    commentType: commentType.value,
    roles: selectedRoles,
    comment: "",
    file: null,
    targetModellerId: targetModellerSelect?.value || "",
  };

  if (commentType.value === "text") {
    const commentText = document.getElementById("comment-text").value.trim();
    if (!commentText) {
      alert("Please enter a comment");
      return;
    }
    commentData.comment = commentText;
  } else if (
    commentType.value === "file" ||
    commentType.value === "annotation"
  ) {
    // For annotation, no new file is selected here; assume it's already saved on server.
    if (commentType.value === "file") {
      const fileInput = document.getElementById("comment-file");
      if (!fileInput.files[0]) {
        alert("Please select a file to upload");
        return;
      }
      commentData.file = fileInput.files[0];
    }
    if (commentType.value === "annotation") {
      // Assume annotator already saved a temp file on server
      commentData.annotationTemp = true;
    }
  }

  // Hold declaration only for "No Comments" — a minor hold flags a concern
  // while letting the line proceed as if no comments were given. When a real
  // comment is provided, it already communicates the concern.
  let holdData = { holdType: null, holdDescription: null };
  if (commentType.value === 'none') {
    holdData = await captureHoldDeclaration();
    if (!holdData) return;
  }
  commentData.holdType        = holdData.holdType;
  commentData.holdDescription = holdData.holdDescription;

  try {
    const result = await submitComments(commentData);
    alert("Comments posted successfully");

    // --- FIX: Always refresh My Tasks after posting comment ---
console.log("Auto-refreshing My Tasks after POST");

if (typeof hideAllTables === "function") hideAllTables();
if (typeof showMyTasks === "function") {
  showMyTasks();
} else if (typeof handleBackToTasks === "function") {
  handleBackToTasks();
}
if (typeof refreshMyTasksView === "function") {
  await refreshMyTasksView();
}



    // Check if this task should be removed from My Tasks
    if (result && result.taskRemoved) {
      console.log("Task removed from My Tasks, navigating back");

      // ✅ Suppress notification UI so it doesn't appear below My Tasks
      window.__suppressNotificationUI = true;

      try {
        // Hide notification table if visible
        const notifTable = document.getElementById("default-notification-table-container");
        if (notifTable) notifTable.style.display = "none";

        // Hide other tables and switch to My Tasks
        if (typeof hideAllTables === "function") hideAllTables();
        if (typeof showMyTasks === "function") {
          showMyTasks();
        } else if (typeof handleBackToTasks === "function") {
          handleBackToTasks();
        }

        // Refresh My Tasks immediately
        if (typeof refreshMyTasksView === "function") {
          await refreshMyTasksView();
        }
      } catch (err) {
        console.warn("Error updating Checker My Tasks after POST:", err);
      }

      // ✅ Re-enable notifications quietly after My Tasks has stabilised
      setTimeout(() => {
        window.__suppressNotificationUI = false;
      }, 1500);
    }

  } catch (error) {
    console.error("Error posting comments:", error);
    alert("Failed to post comments");
  }
}

async function submitComments(commentData) {
  const formData = new FormData();

  // Add form data — hold fields are excluded from the general loop and appended
  // explicitly so null values are not sent as the string "null".
  Object.keys(commentData).forEach((key) => {
    if (!['file', 'roles', 'holdType', 'holdDescription'].includes(key)) {
      formData.append(key, commentData[key]);
    }
  });

  formData.append("roles", JSON.stringify(commentData.roles));
  if (commentData.holdType)        formData.append('holdType',        commentData.holdType);
  if (commentData.holdDescription) formData.append('holdDescription', commentData.holdDescription);

  if (commentData.targetModellerId) {
    formData.append("targetModellerId", commentData.targetModellerId);
  }

  // ✅ Fix: properly stringify rolePerformers so backend can parse it
  if (commentData.rolePerformers) {
    formData.append("rolePerformers", JSON.stringify(commentData.rolePerformers));
    console.log("📤 rolePerformers stringified:", commentData.rolePerformers);
  }

  // ✅ Ensure rolePerformers is stringified before sending
  if (commentData.rolePerformers) {
    try {
      formData.append("rolePerformers", JSON.stringify(commentData.rolePerformers));
      console.log("📤 rolePerformers sent:", commentData.rolePerformers);
    } catch (err) {
      console.warn("⚠️ Failed to stringify rolePerformers:", err);
    }
  }

  if (commentData.annotationTemp) {
    formData.append("annotationTemp", "true");
  }
  // If this is an annotation, finalize the temp file into role-based name
  if (commentData.annotationTemp) {
    const finalizeResponse = await fetch("/api/finalize-annotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobNo: commentData.jobNo,
        unitNo: commentData.unitNo,
        lineNo: commentData.lineNo,
        roles: commentData.roles,
      }),
    });
    const finalizeResult = await finalizeResponse.json();
    if (!finalizeResult.ok) {
      throw new Error(
        "Failed to finalize annotated PDF: " + finalizeResult.error
      );
    }
    console.log("Finalized annotated PDF as", finalizeResult.savedAs);
  }

  if (commentData.file) {
    formData.append("commentFile", commentData.file);
  }

  const response = await fetch("/api/submit-checker-comments", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Failed to submit comments");
  }

  const result = await response.json();
  if (!response.ok) throw new Error("Failed to submit comments");

  // Return the result which may include taskRemoved status
  return result;
}

function checkIfAllRolesCompleted() {
  // Logic to check if PC, MC, SC are all completed for this task
  // This would require checking the task history/status
  return false; // Placeholder
}

async function loadTaskHistory() {
  try {
    const response = await fetch(
      `/api/task-history?lineNo=${currentPerformanceTask.lineNo}&jobNo=${currentPerformanceTask.jobNo}`
    );
    const data = await response.json();

    if (data.ok) {
      renderTaskHistory(data.history);
    }
  } catch (error) {
    console.error("Error loading task history:", error);
  }
  renderLineEngData();
}

function renderTaskHistory(history) {
  const tbody = document.getElementById("history-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!history || history.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="no-data">No history available</td></tr>';
    return;
  }

  // Sort history - latest first
  const sortedHistory = history.sort(
    (a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn)
  );

  sortedHistory.forEach((item, index) => {
    const row = document.createElement("tr");
    row.dataset.index = index;

    const commentFrom = determineCommentFrom(item, sortedHistory);
    // Manual patch for delegated SGL text comments
    if (
      item.fileName && item.fileName.toLowerCase().includes('_pmsaa') &&
      item.fileType === 'text' &&
      (item.roles && item.roles.includes('SGL'))
    ) {
      commentFrom = 'SGL';
    }

    const commentType = determineCommentType(item);
    const shouldHighlight = shouldHighlightForChecker(item, sortedHistory);

    // Apply highlighting style if needed
    if (shouldHighlight) {
      row.style.cssText = `
        background-color: #fff3cd !important;
        border-left: 4px solid #ffc107 !important;
        font-weight: bold;
      `;
    }

    const isCommentFile = item.filePath && item.filePath.includes("/comments/");

    // ✅ Ensure fallbacks so undefined never appears
    const job = item.jobNo || currentPerformanceTask?.jobNo || "";
    const unit = item.unitNo || currentPerformanceTask?.unitNo || "";

    // ✅ Zone fix — check multiple possible fields
    const zone =
      item.zone ||
      item.Zone ||
      item.zoneName ||
      currentPerformanceTask?.zone ||
      (item.filePath
        ? item.filePath.split("/")[3] // extract from path like uploads/B269/416/A/file.pdf
        : "") ||
      "";

    // ✅ Remove accidental double slashes
    const displayPath = isCommentFile
      ? item.filePath.replace(/\/{2,}/g, "/")
      : `uploads/${job}/${unit}/${zone}/${item.fileName}`.replace(/\/{2,}/g, "/");

    const fileNameCell = `<a href="/${displayPath}" target="_blank" style="color: #007bff; text-decoration: none;">${item.fileName}</a>`;

    // Create comment type cell with click handler for text comments
    let commentTypeCell;
    if (item.fileType === "none") {
      commentTypeCell = "No Comments";
    } else if (item.fileType === "base") {
      commentTypeCell = "Base Upload";
    } else if (item.fileType === "text") {
      commentTypeCell = `<a href="javascript:void(0)" style="color:#007bff;text-decoration:underline;" onclick="showTextCommentPopup('${(
        item.comment || ""
      ).replace(/'/g, "\\'")}')">Commented; Text</a>`;
    } else if (item.fileType === "comment") {
      commentTypeCell = "Commented; File";
    } else {
      commentTypeCell = item.commentType || "";
    }

    row.innerHTML = `
            <td style="border: 1px solid #ddd; padding: 8px;">${fileNameCell}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${item.revNo}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${commentFrom}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${commentTypeCell}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${new Date(
      item.uploadedOn
    ).toLocaleString()}</td>
        `;

    tbody.appendChild(row);
  });
}

function handleBackToTasks() {
  // Hide checker view
  const checkerView = document.getElementById("checker-performance-view");
  if (checkerView) {
    checkerView.remove();
  }

  // Reset current task data
  currentPerformanceTask = null;
  currentPerformanceRole = null;

  // Show the tasks table
  const defaultTaskTable = document.getElementById(
    "default-task-table-container"
  );
  if (defaultTaskTable) {
    defaultTaskTable.style.display = "block";
  }
}

// Utility functions
function hideAllTables() {
  if (window.currentView === "FinalIsometrics") return;

  const tables = [
    "default-task-table-container",
    "pc-task-table-container",
    "mc-task-table-container",
    "default-notification-table-container",
    "pc-notification-table-container",
    "mc-notification-table-container",
    "final-isometrics-table-container",
    "rejected-isometrics-table-container",
  ];

  tables.forEach((tableId) => {
    const table = document.getElementById(tableId);
    if (table) {
      table.style.display = "none";
    }
  });

  // Hide ISO surfaces
  const isoSurface = document.querySelector(".iso-surface");
  const commentsSurface = document.querySelector(".comments-surface");

  if (isoSurface) isoSurface.style.display = "none";
  if (commentsSurface) commentsSurface.style.display = "none";
}

function hideWelcome() {
  const welcome = document.getElementById("welcome-container");
  if (welcome) {
    welcome.style.display = "none";
  }
}

// Add utility function for date formatting
function formatDateTime(dateString) {
  if (!dateString) return "";

  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-GB');
  } catch (error) {
    return dateString;
  }
}

// Open GL view
function openGLView(taskData, role) {
  console.log("Opening GL view for:", role, taskData);

  currentPerformanceTask = taskData;
  currentPerformanceRole = role;

  // Hide all other views
  hideAllTables();
  hideWelcome();

  // Show the GL performance view
  showGLPerformanceView();
}

function showGLPerformanceView() {
  const rightPanel = document.querySelector(".right-panel");
  if (!rightPanel) return;

  // Create the GL view HTML
  const glViewHTML = createGLViewHTML();

  // Insert after menu-bar
  const menuBar = rightPanel.querySelector(".menu-bar");
  if (menuBar && menuBar.nextSibling) {
    const existingView = document.getElementById("gl-performance-view");
    if (existingView) {
      existingView.remove();
    }

    const glDiv = document.createElement("div");
    glDiv.id = "gl-performance-view";
    glDiv.innerHTML = glViewHTML;

    // Insert after menu-bar
    rightPanel.insertBefore(glDiv, menuBar.nextSibling);
  }

  // Setup event listeners for the new view
  setupGLViewEventListeners();
  setupClickableHeaderTbody();

  // Load history data
  loadGLTaskHistory();
  loadLinelistDataStrip();
}

function createGLViewHTML() {
  const task = currentPerformanceTask;
  const noCommentEmployees = task.noCommentEmployees || [];

  return `
        <div class="gl-view-container">
            <!-- Task Details Table -->
            <div class="task-details-table-container" style="margin-bottom: 20px; width: 100%;">
                <table class="data-table" style="width: 100%;">
                    <thead>
                        <tr>
                            <th>Job No</th>
                            <th>Unit no</th>
                            <th>Line No</th>
                            <th>Rev No</th>
                            <th>Stress Critical (Y/N)</th>
                            <th>From</th>
                            <th>Date & Time</th>
                            <th>No Comments From</th>
                            <th>Claimed As</th>
                        </tr>
                    </thead>
                    <tbody oncontextmenu="showLineContextMenu(event, currentPerformanceTask)">
                        <tr>
                            <td>${task.jobNo}</td>
                            <td>${task.unitNo}</td>
                            <td>${task.lineNo}</td>
                            <td>${task.revNo}</td>
                            <td>${task.stressCritical}</td>
                            <td>${task.from}</td>
                            <td>${formatDateTime(task.uploadedOn)}</td>
                            <td class="no-comment-employees">${noCommentEmployees.join(
    "<br>"
  )}</td>
                            <td class="claimed-roles">
                                <label class="role-checkbox-label claimed">
                                    <input type="checkbox" checked disabled>
                                    GL
                                </label>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Process Engineering Data Strip -->
            <div id="ll-data-strip"></div>

            <!-- Main Content Area -->
            <div class="gl-main-content" style="display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap;">
                                
                <!-- Right Side: Comment Options -->
                <div class="gl-comment-section" style="flex: 1; border: 1px solid #ddd; border-radius: 6px; padding: 20px;">
                    <h4>GL Actions</h4>
                    <div class="comment-options" style="display:flex; flex-direction:column; gap:20px;">
                        <div class="comment-option">
                            <label for="gl-text-comment" style="display:flex; align-items:center; gap:8px;">
                                <input type="radio" id="gl-text-comment" name="gl-comment-type" value="text">
                                Add Comment
                            </label>
                            <textarea id="gl-comment-text" placeholder="Enter your GL comments here..." disabled style="margin-top:6px; width: 100%; min-height: 80px;"></textarea>
                        </div>

                        <div class="comment-option">
                            <label for="gl-file-comment" style="display:flex; align-items:center; gap:8px;">
                                <input type="radio" id="gl-file-comment" name="gl-comment-type" value="file">
                                Upload Commented File
                            </label>
                            <input type="file" id="gl-comment-file" accept=".pdf" disabled style="margin-top:6px;">
                        </div>
                        <div class="comment-option">
                            <label for="gl-annotation-comment" style="display:flex; align-items:center; gap:8px;">
                                <input type="radio" id="gl-annotation-comment" name="gl-comment-type" value="annotation">
                                Annotate PDF In-Browser
                            </label>
                            <div style="display:flex; align-items:center; justify-content:space-between; max-width:300px;">
                                <button id="gl-open-annotation-btn" disabled 
                                style="margin-top:6px; padding:6px 20px; display:inline-block; min-width:auto;">
                                Open Annotator
                                </button>
                                <span id="gl-annotation-upload-info" style="color:green; font-weight:bold;"></span>
                           </div>
                      </div>
                        <div class="comment-option">
                            <label for="gl-no-comment" style="display:flex; align-items:center; gap:8px;">
                                <input type="radio" id="gl-no-comment" name="gl-comment-type" value="none">
                                No Comments
                            </label>
                        </div>

                        <!-- Route To: PC or SC (hidden until a comment type is chosen) -->
                        <div id="gl-route-to-section" style="display:none;margin-top:4px;padding:10px 14px;background:#f0f7ff;border:1px solid #bfdbfe;border-radius:6px;">
                          <span style="font-size:11.5px;font-weight:600;color:#1e40af;">Route comments to:</span>
                          <div style="display:flex;gap:20px;margin-top:7px;">
                            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
                              <input type="radio" name="gl-route-to" id="gl-route-pc" value="pc" checked> Process Checker
                            </label>
                            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
                              <input type="radio" name="gl-route-to" id="gl-route-sc" value="sc"> Stress Checker
                            </label>
                          </div>
                        </div>

                    </div>
                </div>


                 <!-- Left Side: History Table (collapsible) -->
                <div class="history-section" style="flex: 0 0 auto; align-self: flex-start;">

                    <h4 style="position: relative;">
                      File History
                      <span id="gl-history-toggle" onclick="toggleGLHistory()" title="Expand / Collapse history"
                            style="position: absolute; right: 8px; top: 0; cursor: pointer; transform: rotate(0deg); transition: transform 200ms;">▼</span>
                    </h4>
                    <div class="history-table-container" style="max-height: 0; overflow: hidden; border: 1px solid #ddd; transition: max-height 300ms ease;">
                        <table class="history-table" style="width: 100%; border-collapse: collapse;">
                            <thead style="background-color: #f8f9fa; position: sticky; top: 0;">
                                <tr>
                                    <th style="border: 1px solid #ddd; padding: 8px;">File Name</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Rev-No.</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Comment From</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Comment Type</th>
                                    <th style="border: 1px solid #ddd; padding: 8px;">Date & Time</th>
                                </tr>
                            </thead>
                            <tbody id="gl-history-table-body">
                                <!-- History data will be loaded here -->
                            </tbody>
                        </table>
                    </div>
                </div>

            </div>
            
            <!-- Delegation Section (shown only when commenting) -->
            <div id="gl-delegation-section" class="delegation-section" style="width: 100%; margin: 20px 0; padding: 15px; background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; display: none;">
                <h4 style="margin-top: 0; color: #856404;">Delegate to Roles</h4>
                <p style="color: #856404; margin-bottom: 15px;">Select which roles should receive this comment:</p>
                <div class="delegation-checkboxes" style="display: flex; gap: 15px; flex-wrap: wrap;">
                    <label class="delegation-role-label">
                        <input type="checkbox" class="delegation-role-checkbox" value="Modeller">
                        Modeller
                    </label>
                    <label class="delegation-role-label">
                        <input type="checkbox" class="delegation-role-checkbox" value="Process Checker">
                        Process Checker
                    </label>
                    <label class="delegation-role-label">
                        <input type="checkbox" class="delegation-role-checkbox" value="Material Checker">
                        Material Checker
                    </label>
                    <label class="delegation-role-label">
                        <input type="checkbox" class="delegation-role-checkbox" value="Stress Checker">
                        Stress Checker
                    </label>
                </div>
            </div>
            
            <!-- POST Button -->
            <div class="post-button-container" style="text-align: center; margin-top: 20px;">
                <button id="gl-post-comments-btn" class="post-btn" style="background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; font-size: 16px;">POST</button>
            </div>
        </div>
    `;
}

// Open Annotator button
const openAnnotatorBtn = document.getElementById("open-annotation-btn");
if (openAnnotatorBtn) {
  openAnnotatorBtn.addEventListener("click", async () => {
    // Get selected roles (same logic as for POST)
    const claimedRoles = currentPerformanceTask.claimedRoles || [];
    let selectedRoles = [];
    if (claimedRoles.length > 1) {
      document
        .querySelectorAll(".comment-role-checkbox:checked")
        .forEach((cb) => selectedRoles.push(cb.value));
      if (selectedRoles.length === 0) {
        alert("Select at least one role before annotating");
        return;
      }
    } else {
      selectedRoles = [claimedRoles[0]];
    }
    // Open pdfviewer in new tab with roles parameter
    // map full role strings to single-letter codes that server expects (PC->P, MC->M, SC->S)
    const rolesParam = encodeURIComponent(
      selectedRoles
        .map((r) => {
          if (r === "PC") return "P";
          if (r === "MC") return "M";
          if (r === "SC") return "S";
          // if other names appear (e.g., 'Process Checker') support them too:
          if (r.toLowerCase().includes("process")) return "P";
          if (r.toLowerCase().includes("material")) return "M";
          if (r.toLowerCase().includes("stress")) return "S";
          return r;
        })
        .sort()
        .join("")
    );
    try {
      // Ask server for base file instead of relying on task.filePath
      // Always reuse the first "Base Upload" file from task history
      let baseLink = null;
      const historyRows = document.querySelectorAll("#history-table-body tr");

      historyRows.forEach((row) => {
        const typeCell = row.cells[3]?.textContent || "";
        if (typeCell.includes("Base Upload") && !baseLink) {
          baseLink = row.cells[0].querySelector("a")?.getAttribute("href");
        }
      });

      if (!baseLink) {
        alert("No modeller-uploaded base PDF found in history");
        return;
      }

      const url = `/pdfviewer.html?file=${encodeURIComponent(
        baseLink
      )}&roles=${rolesParam}`;
      window.open(url, "_blank");
    } catch (err) {
      console.error("Error fetching base file path:", err);
      alert("Failed to fetch base PDF path");
    }
  });
  // make the whole top header row clickable to open annotator too
  const topRow = document.getElementById("checker-top-row");
  if (topRow) {
    topRow.style.cursor = "pointer";
    topRow.addEventListener("click", (e) => {
      // avoid double-opening if user clicked the anchor directly
      if (
        e.target &&
        e.target.tagName &&
        e.target.tagName.toLowerCase() === "a"
      )
        return;
      // trigger the same action as the Open Annotator button
      document.getElementById("open-annotation-btn")?.click();
    });
  }
}

function setupGLViewEventListeners() {
  // Comment type radio button listeners
  const commentTypeRadios = document.querySelectorAll(
    'input[name="gl-comment-type"]'
  );
  commentTypeRadios.forEach((radio) => {
    radio.addEventListener("change", handleGLCommentTypeChange);
  });

  // GL Open Annotator button
  const glAnnotatorBtn = document.getElementById("gl-open-annotation-btn");
  if (glAnnotatorBtn) {
    glAnnotatorBtn.addEventListener("click", async () => {
      try {
        // Always take the modeller's base file from drawing.json
        const resp = await fetch(
          `/api/get-base-file?jobNo=${encodeURIComponent(
            currentPerformanceTask.jobNo
          )}&unitNo=${encodeURIComponent(
            currentPerformanceTask.unitNo
          )}&lineNo=${encodeURIComponent(currentPerformanceTask.lineNo)}`,
          { credentials: "same-origin" }
        );
        const js = await resp.json();
        if (!resp.ok || !js.ok || !js.baseFilePath) {
          alert("No modeller-uploaded base PDF found for this task");
          return;
        }

        // Ensure leading slash for the viewer
        const cleanPath = js.baseFilePath.startsWith("/")
          ? js.baseFilePath
          : "/" + js.baseFilePath;

        // Open viewer for GL annotation
        const url = `/pdfviewer.html?file=${encodeURIComponent(cleanPath)}`;
        window.open(url, "_blank");
      } catch (err) {
        console.error("Error fetching base file path for GL annotator:", err);
        alert("Error fetching base PDF. See console for details.");
      }
    });
  }

  // Route-to radio listeners (PC/SC)
  document.querySelectorAll('input[name="gl-route-to"]').forEach(r =>
    r.addEventListener('change', handleGLRouteToChange)
  );

  // Post comments button
  const postBtn = document.getElementById("gl-post-comments-btn");
  // Setup delegation checkbox behavior for GL
  setupDelegationCheckboxBehavior("#gl-delegation-section", true);

  // NEW: auto-populate delegation checkboxes & grouping based on who previously claimed roles
  populateDelegationFromClaims("#gl-delegation-section");

  if (postBtn) {
    postBtn.addEventListener("click", handleGLPostComments);
  }

  // History table row clicks
  document.addEventListener("click", (e) => {
    const row = e.target.closest("#gl-history-table-body tr");
    if (row) {
      const index = parseInt(row.dataset.index);
      showGLCommentDetails(index);

      // Highlight selected row
      document
        .querySelectorAll("#gl-history-table-body tr")
        .forEach((r) => r.classList.remove("selected-history-row"));
      row.classList.add("selected-history-row");
    }
  });
}

// Checkbox behavior logic for delegation
function setupDelegationCheckboxBehavior(containerSelector, isGL = true) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  const modellerCheckbox = container.querySelector('input[value="Modeller"]');
  const checkerCheckboxes = container.querySelectorAll(
    'input[value="Process Checker"], input[value="Material Checker"], input[value="Stress Checker"]'
  );
  const glCheckbox = container.querySelector('input[value="GL"]');

  // Modeller checkbox behavior
  if (modellerCheckbox) {
    modellerCheckbox.addEventListener("change", function () {
      if (this.checked) {
        // Disable all checker checkboxes
        checkerCheckboxes.forEach((cb) => {
          cb.checked = false;
          cb.disabled = true;
        });

        // For SGL: also disable GL checkbox
        if (!isGL && glCheckbox) {
          glCheckbox.checked = false;
          glCheckbox.disabled = true;
        }
      } else {
        // Re-enable all checkboxes
        checkerCheckboxes.forEach((cb) => {
          cb.disabled = false;
        });

        if (!isGL && glCheckbox) {
          glCheckbox.disabled = false;
        }
      }
    });
  }

  // Checker checkboxes behavior
  checkerCheckboxes.forEach(function (cb) {
    cb.addEventListener("change", function () {
      const anyCheckerSelected = Array.from(checkerCheckboxes).some(x => x.checked);

      if (anyCheckerSelected) {
        // ✅ Disable Modeller when any checker is selected
        if (modellerCheckbox) {
          modellerCheckbox.checked = false;
          modellerCheckbox.disabled = true;
        }

        // ✅ For SGL: disable GL checkbox too
        if (!isGL && glCheckbox) {
          glCheckbox.checked = false;
          glCheckbox.disabled = true;
        }
      } else {
        // ✅ Re-enable Modeller when all checkers are unselected
        if (modellerCheckbox) {
          modellerCheckbox.disabled = false;
        }

        // ✅ Also re-enable GL (for SGL case)
        if (!isGL && glCheckbox) {
          glCheckbox.disabled = false;
        }
      }
    });
  });



  // GL checkbox behavior (for SGL only)
  if (!isGL && glCheckbox) {
    glCheckbox.addEventListener("change", function () {
      if (this.checked) {
        // Disable modeller and checker checkboxes
        if (modellerCheckbox) {
          modellerCheckbox.checked = false;
          modellerCheckbox.disabled = true;
        }
        checkerCheckboxes.forEach((cb) => {
          cb.checked = false;
          cb.disabled = true;
        });
      } else {
        // Re-enable all checkboxes
        if (modellerCheckbox) {
          modellerCheckbox.disabled = false;
        }
        checkerCheckboxes.forEach((cb) => {
          cb.disabled = false;
        });
      }
    });
  }
}

// ----------------- NEW: Auto-populate delegation checkboxes and group same-user roles -----------------
// Updated to use /api/line-details instead of /api/drawing-claimers
async function populateDelegationFromClaims(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container || !currentPerformanceTask) {
    console.log("⚠️ populateDelegationFromClaims: container or task missing", { container, currentPerformanceTask });
    return;
  }

  const { jobNo, unitNo, lineNo } = currentPerformanceTask;
  console.log("🟢 populateDelegationFromClaims (using line-details)", { jobNo, unitNo, lineNo });
  console.log("✨ Called for container:", containerSelector);

  try {
    const resp = await fetch(`/api/line-details?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`, { credentials: "same-origin" });
    const js = await resp.json();
    if (!resp.ok || !js.ok) {
      console.warn("⚠️ populateDelegationFromClaims: invalid line-details response", js);
      return;
    }

    const performers = js.rolePerformers || {};
    console.log("📦 Role Performers from /api/line-details:", performers);

    // Map each role to its checkbox
    const roleToCheckbox = {};
    container.querySelectorAll(".delegation-role-checkbox").forEach(cb => {
      const val = cb.value && cb.value.trim();
      if (val) roleToCheckbox[val] = cb;
      cb.removeAttribute("data-group");
      cb.removeAttribute("data-claimed-user");
    });

    // Build groups of roles performed by same user
    const userGroups = {};
    ["PC", "MC", "SC"].forEach((shortRole) => {
      const performer = performers[shortRole];
      if (performer && performer.id) {
        if (!userGroups[performer.id]) userGroups[performer.id] = new Set();
        const readableRole =
          shortRole === "PC"
            ? "Process Checker"
            : shortRole === "MC"
              ? "Material Checker"
              : "Stress Checker";
        userGroups[performer.id].add(readableRole);
      }
    });

    console.log("👥 Grouped roles by user:", Object.fromEntries(Object.entries(userGroups).map(([u, s]) => [u, Array.from(s)])));

    // Assign group IDs and tick checkboxes
    let gid = 0;
    Object.entries(userGroups).forEach(([userId, roleSet]) => {
      gid++;
      const groupId = `claimGroup-${gid}`;
      Array.from(roleSet).forEach(roleLabel => {
        const cb = roleToCheckbox[roleLabel];
        if (cb) {
          cb.checked = true;
          cb.dataset.claimedUser = userId;
          cb.dataset.group = groupId;
          cb.checked = false; // ensure all start unchecked
          console.log(`✅ ${roleLabel} assigned to ${userId} (${groupId})`);
        }
      });
    });

    // Disable/enable logic: if any checker ticked, disable Modeller
    const modellerCB = roleToCheckbox["Modeller"];
    const anyCheckerChecked = ["Process Checker", "Material Checker", "Stress Checker"].some(r => roleToCheckbox[r]?.checked);
    if (modellerCB) modellerCB.disabled = anyCheckerChecked;

    // Group toggle behavior
    container.querySelectorAll(".delegation-role-checkbox").forEach(cb => {
      cb._claimsGroupHandler && cb.removeEventListener("change", cb._claimsGroupHandler);
      const handler = function () {
        const grp = this.dataset.group;
        if (grp) {
          const peers = container.querySelectorAll(`.delegation-role-checkbox[data-group="${grp}"]`);
          peers.forEach(p => {
            if (p !== this) p.checked = this.checked;
          });
        }
        // If any checker ticked, disable modeller
        if (modellerCB) modellerCB.disabled = ["Process Checker", "Material Checker", "Stress Checker"].some(r => roleToCheckbox[r]?.checked);
      };
      cb._claimsGroupHandler = handler;
      cb.addEventListener("change", handler);
    });

    console.log("🏁 populateDelegationFromClaims complete (line-details source)");
  } catch (err) {
    console.error("❌ populateDelegationFromClaims failed:", err);
  }
}


// ----------------- END NEW --------------------------------------------------------------------------------


function handleGLCommentTypeChange(event) {
  const commentType = event.target.value;
  const commentText       = document.getElementById("gl-comment-text");
  const commentFile       = document.getElementById("gl-comment-file");
  const delegationSection = document.getElementById("gl-delegation-section");
  const routeToSection    = document.getElementById("gl-route-to-section");
  const annotateBtn       = document.getElementById("gl-open-annotation-btn");

  // Reset inputs
  if (commentText) commentText.disabled = true;
  if (commentFile) commentFile.disabled = true;
  if (annotateBtn) annotateBtn.disabled = true;

  const isRoutingAction = (commentType === "approve" || commentType === "sgl");
  const isCommentType   = !isRoutingAction;

  // Route To section: show only for comment types (text/file/annotation/none)
  if (routeToSection) routeToSection.style.display = isCommentType ? "block" : "none";

  // Delegation section: show only when commenting AND routing to PC (not SC, not none)
  const routingToSC = document.querySelector('input[name="gl-route-to"]:checked')?.value === 'sc';
  if (delegationSection) {
    delegationSection.style.display =
      (isCommentType && commentType !== "none" && !routingToSC) ? "block" : "none";
  }

  // Enable relevant input
  if (commentType === "text" && commentText) {
    commentText.disabled = false;
    commentText.focus();
  } else if (commentType === "file" && commentFile) {
    commentFile.disabled = false;
  } else if (commentType === "annotation" && annotateBtn) {
    annotateBtn.disabled = false;
  }
}

function handleGLRouteToChange() {
  // Re-evaluate delegation visibility when route-to changes
  const commentType    = document.querySelector('input[name="gl-comment-type"]:checked')?.value;
  const routingToSC    = document.querySelector('input[name="gl-route-to"]:checked')?.value === 'sc';
  const delegation     = document.getElementById("gl-delegation-section");
  if (!delegation || !commentType) return;
  const isCommentType  = (commentType !== "approve" && commentType !== "sgl");
  delegation.style.display =
    (isCommentType && commentType !== "none" && !routingToSC) ? "block" : "none";
}

// Helper to show modal popup when GL selects "no comments"
function showNoCommentModal(onConfirm) {
  // Create modal HTML dynamically
  const modalHtml = `
  <div id="noCommentModal" style="
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
  ">
    <div style="
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.25);
        width: 380px;
        padding: 24px 28px;
        text-align: left;
        font-family: 'Segoe UI', Arial, sans-serif;
        animation: fadeInScale 0.25s ease;
    ">
      <h2 style="font-size: 18px; font-weight: 600; color: #333; margin-bottom: 18px;">
        Select Action
      </h2>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 15px;">
          <input type="checkbox" id="finalApprovalCheckbox" checked style="transform: scale(1.2);" />
          <span>✅ Final Approval; Ready For EngDMS</span>
        </label>
        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 15px;">
          <input type="checkbox" id="sendToSGLCheckbox" style="transform: scale(1.2);" />
          <span>📤 Send to SGL</span>
        </label>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px;">
        <button id="cancelNoCommentModal" style="
            background: #e0e0e0;
            color: #333;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
        ">Cancel</button>
        <button id="confirmNoCommentModal" style="
            background: #007bff;
            color: #fff;
            border: none;
            padding: 8px 18px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
        ">Confirm & Submit</button>
      </div>
    </div>
  </div>

  <style>
    @keyframes fadeInScale {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
  </style>
`;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const finalCheckbox = document.getElementById("finalApprovalCheckbox");
  const sglCheckbox = document.getElementById("sendToSGLCheckbox");

  // ✅ Only one checkbox can be active at a time
  finalCheckbox.addEventListener("change", () => {
    if (finalCheckbox.checked) {
      sglCheckbox.checked = false;
    } else {
      // Ensure at least one checkbox is always checked
      sglCheckbox.checked = true;
    }
  });

  sglCheckbox.addEventListener("change", () => {
    if (sglCheckbox.checked) {
      finalCheckbox.checked = false;
    } else {
      // Ensure at least one checkbox is always checked
      finalCheckbox.checked = true;
    }
  });

  // ✅ Cancel button closes modal, performs no backend activity
  document.getElementById("cancelNoCommentModal").onclick = () => {
    const modal = document.getElementById("noCommentModal");
    if (modal) {
      modal.remove();
    }
  };

  // ✅ Confirm button proceeds and closes the modal
  document.getElementById("confirmNoCommentModal").onclick = () => {
    const finalApproval = finalCheckbox.checked;
    const sendToSGL = sglCheckbox.checked;
    const modal = document.getElementById("noCommentModal");
    if (modal) {
      modal.remove();
    }
    onConfirm(finalApproval, sendToSGL);
  };
}

async function handleGLPostComments() {
  const commentType = document.querySelector(
    'input[name="gl-comment-type"]:checked'
  );

  // Fetch latest role performer data from line-details (already used for delegation)
  const { jobNo, unitNo, lineNo } = currentPerformanceTask;
  try {
    const resp = await fetch(`/api/line-details?jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}&lineNo=${encodeURIComponent(lineNo)}`, { credentials: "same-origin" });
    const js = await resp.json();
    if (js.ok && js.rolePerformers) {
      window._delegationRolePerformers = js.rolePerformers;
      console.log("📦 Cached rolePerformers for delegation:", js.rolePerformers);
    }
  } catch (err) {
    console.warn("⚠️ Could not fetch rolePerformers before delegation:", err);
  }


  if (!commentType) {
    alert("Please select a comment type");
    return;
  }

  const commentData = {
    taskId: currentPerformanceTask.lineNo,
    jobNo: currentPerformanceTask.jobNo,
    unitNo: currentPerformanceTask.unitNo,
    lineNo: currentPerformanceTask.lineNo,
    commentType: commentType.value,
    roles: [],
    comment: "",
    file: null,
    isGL: true,
  };

  if (commentType.value === "none") {
    const holdData = await captureHoldDeclaration();
    if (!holdData) return;
    commentData.holdType        = holdData.holdType;
    commentData.holdDescription = holdData.holdDescription;

    showNoCommentModal(async (finalApproval, sendToSGL) => {
      if (finalApproval) {
        commentData.commentType = "none_final"; // Final approval
      } else if (sendToSGL) {
        commentData.commentType = "none_sgl"; // Send to SGL
      } else {
        return; // Modal cancelled
      }

      commentData.roles = ["GL"];

      try {
        await submitGLComments(commentData);
        const msg = finalApproval
          ? "Task approved and sent directly to Final Isometrics (Ready for EngDMS)"
          : "Task approved and forwarded to SGL";
        alert(msg);

        // refresh task tables
        try {
          if (typeof showMyTasks === "function") showMyTasks();
          if (typeof refreshMyTasksView === "function") await refreshMyTasksView();
          if (typeof refreshCurrentNotificationView === "function")
            await refreshCurrentNotificationView();
          else if (typeof loadNotificationsData === "function")
            await loadNotificationsData();
        } catch (err) {
          console.warn("Error updating after GL No Comments:", err);
        }
      } catch (error) {
        console.error("Error posting GL comments:", error);
        alert("Failed to post GL comments");
      }
    });
    return;
  }

  // Read route-to selection (PC or SC)
  const routeToSC = document.querySelector('input[name="gl-route-to"]:checked')?.value === 'sc';
  commentData.routeToSC = routeToSC ? 'true' : 'false';

  // Handle other comment types
  if (!routeToSC) {
    // Only require delegation when routing to PC
    const roleCheckboxes = document.querySelectorAll(".delegation-role-checkbox:checked");
    roleCheckboxes.forEach((cb) => commentData.roles.push(cb.value));
    if (commentData.roles.length === 0) {
      alert("Please select at least one role to delegate to");
      return;
    }
  }

  if (commentType.value === "text") {
    const commentText = document.getElementById("gl-comment-text").value.trim();
    if (!commentText) {
      alert("Please enter a comment");
      return;
    }
    commentData.comment = commentText;
  } else if (commentType.value === "annotation") {
    commentData.annotationTemp = true;
  } else if (commentType.value === "file") {
    const fileInput = document.getElementById("gl-comment-file");
    if (!fileInput.files[0]) {
      alert("Please select a file to upload");
      return;
    }
    commentData.file = fileInput.files[0];
  }

  try {
    if (window._delegationRolePerformers) {
      commentData.rolePerformers = window._delegationRolePerformers;
    }

    await submitGLComments(commentData);
    alert("Comments submitted and delegated to selected roles");

    // --- AUTO-SWITCH TO My Tasks ---
    window.__suppressNotificationUI = true;
    try {
      const notifTable = document.getElementById("default-notification-table-container");
      if (notifTable) notifTable.style.display = "none";

      if (typeof hideAllTables === "function") hideAllTables();
      if (typeof showMyTasks === "function") {
        showMyTasks();
      } else if (typeof handleBackToTasks === "function") {
        handleBackToTasks();
      }

      if (typeof refreshMyTasksView === "function") {
        await refreshMyTasksView();
      }

      if (typeof refreshCurrentNotificationView === "function") {
        await refreshCurrentNotificationView();
      } else if (typeof loadNotificationsData === "function") {
        await loadNotificationsData();
      }
    } catch (err) {
      console.warn("Error updating GL My Tasks after POST (delegated):", err);
    }
    setTimeout(() => {
      window.__suppressNotificationUI = false;
    }, 1500);
    try {
      // reload the GL history so the new comment appears immediately
      await loadGLTaskHistory();
      // also refresh My Tasks in case delegation changed claims
      if (typeof refreshMyTasksView === "function") {
        await refreshMyTasksView();
      }
    } catch (err) {
      console.warn("Failed to refresh after GL comments:", err);
    }
  } catch (error) {
    console.error("Error posting GL comments:", error);
    alert("Failed to post comments");
  }
}

async function submitGLComments(commentData) {
  const formData = new FormData();

  Object.keys(commentData).forEach((key) => {
    if (!['file', 'roles', 'holdType', 'holdDescription'].includes(key)) {
      formData.append(key, commentData[key]);
    }
  });

  formData.append("roles", JSON.stringify(commentData.roles));
  if (commentData.holdType)        formData.append('holdType',        commentData.holdType);
  if (commentData.holdDescription) formData.append('holdDescription', commentData.holdDescription);
  if (commentData.routeToSC) formData.append("routeToSC", commentData.routeToSC);
  // ✅ Guarantee JSON string for rolePerformers
  if (commentData.rolePerformers) {
    const json = JSON.stringify(commentData.rolePerformers);
    formData.append("rolePerformers", json);
    console.log("✅ rolePerformers JSON added:", json);
  }


  if (commentData.annotationTemp) {
    formData.append("annotationTemp", "true");
  }

  // If this is an annotation, finalize the temp file into role-based name
  if (commentData.annotationTemp) {
    const finalizeResponse = await fetch("/api/finalize-annotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobNo: commentData.jobNo,
        unitNo: commentData.unitNo,
        lineNo: commentData.lineNo,
        roles: ["GL"], // GL annotation always uses GL role
      }),
    });
    const finalizeResult = await finalizeResponse.json();
    if (!finalizeResult.ok) {
      throw new Error(
        "Failed to finalize annotated PDF: " + finalizeResult.error
      );
    }
    console.log("Finalized GL annotated PDF as", finalizeResult.savedAs);
  }

  if (commentData.file) {
    formData.append("commentFile", commentData.file);
  }

  for (const [key, value] of formData.entries()) {
    console.log("📤 Sending field:", key, value);
  }


  const response = await fetch("/api/submit-gl-comments", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Failed to submit GL comments");
  }

  return await response.json();
}

async function loadGLTaskHistory() {
  try {
    const response = await fetch(
      `/api/task-history?lineNo=${currentPerformanceTask.lineNo}&jobNo=${currentPerformanceTask.jobNo}`
    );
    const data = await response.json();

    if (data.ok) {
      renderGLTaskHistory(data.history);
    }
  } catch (error) {
    console.error("Error loading GL task history:", error);
  }
  renderLineEngData();
}

function renderGLTaskHistory(history) {
  const tbody = document.getElementById("gl-history-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!history || history.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="no-data">No history available</td></tr>';
    return;
  }

  // Sort history - latest first
  const sortedHistory = history.sort(
    (a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn)
  );

  sortedHistory.forEach((item, index) => {
    const row = document.createElement("tr");
    row.dataset.index = index;

    const commentFrom = determineCommentFrom(item, sortedHistory);
    const commentType = determineCommentType(item);
    const shouldHighlight = shouldHighlightForGL(item);

    // Apply highlighting style if needed
    if (shouldHighlight) {
      row.style.cssText = `
        background-color: #fff3cd !important;
        border-left: 4px solid #ffc107 !important;
        font-weight: bold;
      `;
    }

    // Create file name cell with hyperlink
    const fileNameCell = `<a href="/${item.filePath}" target="_blank" style="color: #007bff; text-decoration: none;">${item.fileName}</a>`;

    // Create comment type cell with click handler for text comments
    const commentTypeCell =
      commentType === "Commented: Text"
        ? `<span style="color: #007bff; cursor: pointer; text-decoration: underline;" onclick="showTextCommentPopup('${(
          item.comment || ""
        ).replace(/'/g, "\\'")}')">${commentType}</span>`
        : commentType;

    row.innerHTML = `
            <td style="border: 1px solid #ddd; padding: 8px;">${fileNameCell}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${item.revNo}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${commentFrom}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${commentTypeCell}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${new Date(
      item.uploadedOn
    ).toLocaleString()}</td>
        `;

    tbody.appendChild(row);
  });
  // If the history container is expanded, adjust its max-height to fit new content
  const glCont = document.querySelector(
    "#gl-performance-view .history-table-container"
  );
  if (glCont && glCont.classList.contains("expanded")) {
    // allow the transition to animate properly
    glCont.style.maxHeight = glCont.scrollHeight + "px";
  }
}

function showGLCommentDetails(index) {
  // Similar to modeller details but for GL view
  const history = window.currentGLHistory || [];
  const item = history[index];

  if (!item) return;

  console.log("GL viewing details for:", item);
  // You can implement detailed view if needed
}

// Open SGL view
function openSGLView(taskData, role) {
  console.log("Opening SGL view for:", role, taskData);

  currentPerformanceTask = taskData;
  currentPerformanceRole = role;

  // Hide all other views
  hideAllTables();
  hideWelcome();

  // Show the SGL performance view
  showSGLPerformanceView();
}

function showSGLPerformanceView() {
  const rightPanel = document.querySelector(".right-panel");
  if (!rightPanel) return;

  // Create the SGL view HTML
  const sglViewHTML = createSGLViewHTML();

  // Insert after menu-bar
  const menuBar = rightPanel.querySelector(".menu-bar");
  if (menuBar && menuBar.nextSibling) {
    const existingView = document.getElementById("sgl-performance-view");
    if (existingView) {
      existingView.remove();
    }

    const sglDiv = document.createElement("div");
    sglDiv.id = "sgl-performance-view";
    sglDiv.innerHTML = sglViewHTML;

    // Insert after menu-bar
    rightPanel.insertBefore(sglDiv, menuBar.nextSibling);
  }

  // Setup event listeners for the new view
  setupSGLViewEventListeners();
  setupClickableHeaderTbody();


  // Load history data
  loadSGLTaskHistory();
  loadLinelistDataStrip();
}

function createSGLViewHTML() {
  const task = currentPerformanceTask;

  return `
        <div class="sgl-view-container">
            <!-- Task Details Table -->
            <div class="task-details-table-container" style="margin-bottom: 20px; width: 100%;">
                <table class="data-table" style="width: 100%;">
                    <thead>
                        <tr>
                            <th>Job No</th>
                            <th>Unit no</th>
                            <th>Line No</th>
                            <th>Rev No</th>
                            <th>Stress Critical (Y/N)</th>
                            <th>From</th>
                            <th>Date & Time</th>
                            <th>Claimed As</th>
                        </tr>
                    </thead>
                    <tbody oncontextmenu="showLineContextMenu(event, currentPerformanceTask)">
                        <tr>
                            <td>${task.jobNo}</td>
                            <td>${task.unitNo}</td>
                            <td>${task.lineNo}</td>
                            <td>${task.revNo}</td>
                            <td>${task.stressCritical}</td>
                            <td>${task.from}</td>
                            <td>${formatDateTime(task.uploadedOn)}</td>
                            <td class="claimed-roles">
                                <label class="role-checkbox-label claimed">
                                    <input type="checkbox" checked disabled>
                                    SGL
                                </label>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Process Engineering Data Strip -->
            <div id="ll-data-strip"></div>

            <!-- Main Content Area -->
            <div class="sgl-main-content" style="display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap;">

                <!-- Comment Options (send to PC) -->
                <div class="sgl-comment-section" style="flex: 1; border: 1px solid rgba(0,123,255,0.2); border-radius: 6px; padding: 20px;">
                    <h4 style="margin:0 0 14px; font-size:13px; font-weight:600; color:#e8f3fb;">Post Comments to PC</h4>
                    <div class="comment-options" style="display:flex; flex-direction:column; gap:14px;">
                        <div class="comment-option">
                            <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#c8dff5; cursor:pointer;">
                                <input type="radio" id="sgl-text-comment" name="sgl-comment-type" value="text">
                                Add Text Comment
                            </label>
                            <textarea id="sgl-comment-text" placeholder="Enter your comments here…" disabled
                              style="margin-top:6px; width:100%; min-height:80px; background:rgba(0,0,0,0.2); border:1px solid rgba(0,123,255,0.2); border-radius:4px; color:#e8f3fb; padding:8px; font-size:12.5px; resize:vertical;"></textarea>
                        </div>

                        <div class="comment-option">
                            <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#c8dff5; cursor:pointer;">
                                <input type="radio" id="sgl-file-comment" name="sgl-comment-type" value="file">
                                Upload Commented File
                            </label>
                            <input type="file" id="sgl-comment-file" accept=".pdf" disabled style="margin-top:6px; font-size:12px;">
                        </div>

                        <div class="comment-option">
                            <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#c8dff5; cursor:pointer;">
                                <input type="radio" id="sgl-annotation-comment" name="sgl-comment-type" value="annotation">
                                Annotate PDF In-Browser
                            </label>
                            <div style="display:flex; align-items:center; gap:10px; margin-top:6px;">
                                <button id="sgl-open-annotation-btn" disabled
                                  style="padding:5px 14px; font-size:12px; background:rgba(0,123,255,0.15); border:1px solid rgba(0,123,255,0.3); border-radius:4px; color:#89c4ff; cursor:pointer;">
                                  Open Annotator
                                </button>
                                <span id="sgl-annotation-upload-info" style="color:#28a745; font-weight:600; font-size:12px;"></span>
                            </div>
                        </div>
                    </div>

                    <div style="margin-top:18px;">
                        <button id="sgl-post-comments-btn" class="post-btn" disabled
                          style="background:#007bff; min-width:180px;"
                          onclick="handleSGLPostComments()">
                          POST Comments → PC
                        </button>
                    </div>
                </div>

                <!-- History Table (collapsible) -->
                <div class="history-section" style="flex: 0 0 auto; align-self: flex-start;">
                    <h4 style="position: relative; font-size:13px; font-weight:600; color:#e8f3fb; margin:0 0 8px;">
                      File History
                      <span id="sgl-history-toggle" onclick="toggleSGLHistory()" title="Expand / Collapse history"
                            style="position: absolute; right: 8px; top: 0; cursor: pointer; transform: rotate(0deg); transition: transform 200ms;">▼</span>
                    </h4>
                    <div class="history-table-container" style="max-height: 0; overflow: hidden; border: 1px solid rgba(0,123,255,0.15); border-radius:4px; transition: max-height 300ms ease;">
                        <table class="history-table" style="width: 100%; border-collapse: collapse;">
                            <thead style="background: rgba(0,123,255,0.15); position: sticky; top: 0;">
                                <tr>
                                    <th style="padding: 8px; font-size:12px; color:#89c4ff;">File Name</th>
                                    <th style="padding: 8px; font-size:12px; color:#89c4ff;">Rev-No.</th>
                                    <th style="padding: 8px; font-size:12px; color:#89c4ff;">Comment From</th>
                                    <th style="padding: 8px; font-size:12px; color:#89c4ff;">Comment Type</th>
                                    <th style="padding: 8px; font-size:12px; color:#89c4ff;">Date & Time</th>
                                </tr>
                            </thead>
                            <tbody id="sgl-history-table-body"></tbody>
                        </table>
                    </div>
                </div>

            </div>

            <!-- Approve button — full width, prominent -->
            <div style="margin-top:20px; text-align:center;">
                <button id="sgl-approve-btn" class="post-btn"
                  style="background:#28a745; min-width:220px; font-size:14px;"
                  onclick="handleSGLApprove()">
                  ✓ Approve → Final Isometrics
                </button>
            </div>
        </div>
    `;
}

function setupSGLViewEventListeners() {
  // Enable/disable POST button and inputs based on comment type selection
  document.querySelectorAll('input[name="sgl-comment-type"]').forEach((radio) => {
    radio.addEventListener("change", handleSGLCommentTypeChange);
  });

  // Annotator button
  const sglAnnotatorBtn = document.getElementById("sgl-open-annotation-btn");
  if (sglAnnotatorBtn) {
    sglAnnotatorBtn.addEventListener("click", async () => {
      try {
        const resp = await fetch(
          `/api/get-base-file?jobNo=${encodeURIComponent(currentPerformanceTask.jobNo)}&unitNo=${encodeURIComponent(currentPerformanceTask.unitNo)}&lineNo=${encodeURIComponent(currentPerformanceTask.lineNo)}`,
          { credentials: "same-origin" }
        );
        const js = await resp.json();
        if (!resp.ok || !js.ok || !js.baseFilePath) {
          alert("No base PDF found for this task");
          return;
        }
        const cleanPath = js.baseFilePath.startsWith("/") ? js.baseFilePath : "/" + js.baseFilePath;
        window.open(`/pdfviewer.html?file=${encodeURIComponent(cleanPath)}`, "_blank");
      } catch (err) {
        console.error("SGL annotator error:", err);
        alert("Error fetching base PDF.");
      }
    });
  }
}

function handleSGLCommentTypeChange(event) {
  const val = event.target.value;
  const commentText = document.getElementById("sgl-comment-text");
  const commentFile = document.getElementById("sgl-comment-file");
  const annotateBtn = document.getElementById("sgl-open-annotation-btn");
  const postBtn = document.getElementById("sgl-post-comments-btn");

  if (commentText) commentText.disabled = (val !== "text");
  if (commentFile) commentFile.disabled = (val !== "file");
  if (annotateBtn) annotateBtn.disabled = (val !== "annotation");
  if (postBtn) postBtn.disabled = false;

  if (val === "text" && commentText) commentText.focus();
}

async function handleSGLPostComments() {
  const commentTypeEl = document.querySelector('input[name="sgl-comment-type"]:checked');
  if (!commentTypeEl) { alert('Please select a comment type'); return; }
  const commentType = commentTypeEl.value;

  const postBtn = document.getElementById("sgl-post-comments-btn");
  const origText = postBtn.textContent;
  postBtn.disabled = true;
  postBtn.textContent = 'Sending…';

  const commentData = {
    jobNo: currentPerformanceTask.jobNo,
    unitNo: currentPerformanceTask.unitNo,
    lineNo: currentPerformanceTask.lineNo,
    commentType,
    roles: ['Process Checker'],
    comment: '',
    file: null,
    isSGL: true,
  };

  let holdData = { holdType: null, holdDescription: null };
  if (commentType === 'none') {
    holdData = await captureHoldDeclaration();
    if (!holdData) { postBtn.disabled = false; postBtn.textContent = origText; return; }
  }
  commentData.holdType        = holdData.holdType;
  commentData.holdDescription = holdData.holdDescription;

  if (commentType === 'text') {
    commentData.comment = (document.getElementById('sgl-comment-text').value || '').trim();
    if (!commentData.comment) { alert('Please enter a comment'); postBtn.disabled = false; postBtn.textContent = origText; return; }
  } else if (commentType === 'annotation') {
    commentData.annotationTemp = true;
  } else if (commentType === 'file') {
    const fileInput = document.getElementById('sgl-comment-file');
    if (!fileInput.files[0]) { alert('Please select a file'); postBtn.disabled = false; postBtn.textContent = origText; return; }
    commentData.file = fileInput.files[0];
  }

  try {
    await submitSGLComments(commentData);
    alert('Comments sent to Process Checker');
    _sglRefreshAfterAction();
  } catch (err) {
    console.error('SGL post error:', err);
    alert('Failed to post comments');
    postBtn.disabled = false;
    postBtn.textContent = origText;
  }
}

async function handleSGLApprove() {
  if (!currentPerformanceTask) return;

  // Hold declaration before the confirmation dialog
  const holdData = await captureHoldDeclaration();
  if (!holdData) return;

  if (!confirm('Approve this line?\nIt will be moved to Final Isometrics.')) return;

  const approveBtn = document.getElementById("sgl-approve-btn");
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Approving…'; }

  try {
    const fd = new FormData();
    fd.append('jobNo', currentPerformanceTask.jobNo);
    fd.append('unitNo', currentPerformanceTask.unitNo);
    fd.append('lineNo', currentPerformanceTask.lineNo);
    fd.append('commentType', 'approve');
    fd.append('roles', JSON.stringify(['SGL']));
    if (holdData.holdType)        fd.append('holdType',        holdData.holdType);
    if (holdData.holdDescription) fd.append('holdDescription', holdData.holdDescription);

    const resp = await fetch('/api/submit-sgl-comments', { method: 'POST', body: fd, credentials: 'same-origin' });
    const result = await resp.json();
    if (result.ok) {
      alert('Line approved and moved to Final Isometrics');
      _sglRefreshAfterAction();
    } else {
      alert('Error: ' + (result.error || 'Approval failed'));
      if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = '✓ Approve → Final Isometrics'; }
    }
  } catch (err) {
    console.error('SGL approve error:', err);
    alert('Network error during approval');
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = '✓ Approve → Final Isometrics'; }
  }
}

function _sglRefreshAfterAction() {
  try {
    if (typeof hideAllTables === 'function') hideAllTables();
    if (typeof showWelcome === 'function') showWelcome();
    if (typeof loadNotificationsForMainRole === 'function') loadNotificationsForMainRole('SGL');
  } catch (e) { /* ignore */ }
}


async function submitSGLComments(commentData) {
  const formData = new FormData();

  Object.keys(commentData).forEach((key) => {
    if (!['file', 'roles', 'holdType', 'holdDescription'].includes(key)) {
      formData.append(key, commentData[key]);
    }
  });

  formData.append("roles", JSON.stringify(commentData.roles));
  if (commentData.holdType)        formData.append('holdType',        commentData.holdType);
  if (commentData.holdDescription) formData.append('holdDescription', commentData.holdDescription);

  // Guarantee JSON string for rolePerformers
  if (commentData.rolePerformers) {
    const json = JSON.stringify(commentData.rolePerformers);
    formData.append('rolePerformers', json);
    console.log('[rolePerformers] JSON added:', json);
  }


  if (commentData.annotationTemp) {
    formData.append("annotationTemp", "true");
  }

  // If this is an annotation, finalize the temp file into role-based name
  if (commentData.annotationTemp) {
    const finalizeResponse = await fetch("/api/finalize-annotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobNo: commentData.jobNo,
        unitNo: commentData.unitNo,
        lineNo: commentData.lineNo,
        roles: ["SGL"], // SGL annotation always uses SGL role
      }),
    });
    const finalizeResult = await finalizeResponse.json();
    if (!finalizeResult.ok) {
      throw new Error(
        "Failed to finalize annotated PDF: " + finalizeResult.error
      );
    }
    console.log("Finalized SGL annotated PDF as", finalizeResult.savedAs);
  }

  if (commentData.file) {
    formData.append("commentFile", commentData.file);
  }

  const response = await fetch("/api/submit-sgl-comments", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Failed to submit SGL comments");
  }

  return await response.json();
}

async function loadSGLTaskHistory() {
  try {
    const response = await fetch(
      `/api/task-history?lineNo=${currentPerformanceTask.lineNo}&jobNo=${currentPerformanceTask.jobNo}`
    );
    const data = await response.json();

    if (data.ok) {
      renderSGLTaskHistory(data.history);
    }
  } catch (error) {
    console.error("Error loading SGL task history:", error);
  }
  renderLineEngData();
}

function renderSGLTaskHistory(history) {
  const tbody = document.getElementById("sgl-history-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!history || history.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="no-data">No history available</td></tr>';
    return;
  }

  // Sort history - latest first
  const sortedHistory = history.sort(
    (a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn)
  );

  sortedHistory.forEach((item, index) => {
    const row = document.createElement("tr");
    row.dataset.index = index;

    const commentFrom = determineCommentFrom(item, sortedHistory);
    const commentType = determineCommentType(item);
    const shouldHighlight = shouldHighlightForSGL(item);

    // Apply highlighting style if needed
    if (shouldHighlight) {
      row.style.cssText = `
        background-color: #fff3cd !important;
        border-left: 4px solid #ffc107 !important;
        font-weight: bold;
      `;
    }

    // Create file name cell with hyperlink
    const fileNameCell = `<a href="/${item.filePath}" target="_blank" style="color: #007bff; text-decoration: none;">${item.fileName}</a>`;

    // Create comment type cell with click handler for text comments
    const commentTypeCell =
      commentType === "Commented: Text"
        ? `<span style="color: #007bff; cursor: pointer; text-decoration: underline;" onclick="showTextCommentPopup('${(
          item.comment || ""
        ).replace(/'/g, "\\'")}')">${commentType}</span>`
        : commentType;

    row.innerHTML = `
            <td style="border: 1px solid #ddd; padding: 8px;">${fileNameCell}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${item.revNo}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${commentFrom}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${commentTypeCell}</td>
            <td style="border: 1px solid #ddd; padding: 8px;">${new Date(
      item.uploadedOn
    ).toLocaleString()}</td>
        `;

    tbody.appendChild(row);
  });

  // If the history container is expanded, adjust its max-height to fit new content
  const sglCont = document.querySelector(
    "#sgl-performance-view .history-table-container"
  );
  if (sglCont && sglCont.classList.contains("expanded")) {
    sglCont.style.maxHeight = sglCont.scrollHeight + "px";
  }
}

// Toggle functions for GL / SGL history collapse/expand
function toggleGLHistory() {
  const viewRoot = document.getElementById("gl-performance-view");
  if (!viewRoot) return;
  const container = viewRoot.querySelector(".history-table-container");
  const historySection = viewRoot.querySelector(".history-section");
  const mainContent = viewRoot.querySelector(".gl-main-content");
  const toggle = document.getElementById("gl-history-toggle");
  if (!container || !historySection) return;

  if (container.classList.contains("expanded")) {
    // collapse
    container.style.maxHeight = "0";
    container.classList.remove("expanded");
    // make history section hug its content only
    historySection.style.flex = "0 0 auto";
    historySection.style.alignSelf = "flex-start";
    if (mainContent) mainContent.style.height = "60vh"; // restore default visual height
    if (toggle) toggle.style.transform = "rotate(0deg)";
  } else {
    // expand - set to scrollHeight so it animates open
    container.classList.add("expanded");
    // ensure the section can stretch to full height while expanded
    historySection.style.flex = "1";
    historySection.style.alignSelf = "stretch";
    // give browser a tick to compute scrollHeight correctly if content was just added
    requestAnimationFrame(() => {
      container.style.maxHeight = container.scrollHeight + "px";
    });
    if (mainContent) mainContent.style.height = "auto"; // let it grow
    if (toggle) toggle.style.transform = "rotate(180deg)";
  }
}

function toggleSGLHistory() {
  const viewRoot = document.getElementById("sgl-performance-view");
  if (!viewRoot) return;
  const container = viewRoot.querySelector(".history-table-container");
  const historySection = viewRoot.querySelector(".history-section");
  const mainContent = viewRoot.querySelector(".sgl-main-content");
  const toggle = document.getElementById("sgl-history-toggle");
  if (!container || !historySection) return;

  if (container.classList.contains("expanded")) {
    // collapse
    container.style.maxHeight = "0";
    container.classList.remove("expanded");
    historySection.style.flex = "0 0 auto";
    historySection.style.alignSelf = "flex-start";
    if (mainContent) mainContent.style.height = "50vh"; // restore original SGL height
    if (toggle) toggle.style.transform = "rotate(0deg)";
  } else {
    // expand - set to scrollHeight so it animates open
    container.classList.add("expanded");
    historySection.style.flex = "1";
    historySection.style.alignSelf = "stretch";
    requestAnimationFrame(() => {
      container.style.maxHeight = container.scrollHeight + "px";
    });
    if (mainContent) mainContent.style.height = "auto"; // let it grow
    if (toggle) toggle.style.transform = "rotate(180deg)";
  }
}

// Utility functions for history table
function determineCommentFrom(item, history) {
  if (item.fileType === "base") {
    return `Upload ${extractUploadCount(item.fileName)}`;
  }

  if (item.fileType === "text" || item.fileType === "comment") {
    // Determine roles from the file naming or role info
    if (item.role) {
      return item.role;
    }

    // Try to determine from filename with proper priority order
    const filename = item.fileName;
    if (filename.includes("_PMSAA.pdf")) {
      return "SGL";
    } else if (filename.includes("_PMSA.pdf")) {
      return "GL";
    } else if (filename.includes("_PMS.pdf")) {
      return "PC+MC+SC";
    } else if (filename.includes("_PM.pdf")) {
      return "PC+MC";
    } else if (filename.includes("_PS.pdf")) {
      return "PC+SC";
    } else if (filename.includes("_MS.pdf")) {
      return "MC+SC";
    } else if (filename.includes("_P.pdf")) {
      return "PC";
    } else if (filename.includes("_M.pdf")) {
      return "MC";
    } else if (filename.includes("_S.pdf")) {
      return "SC";
    }
  }

  return item.uploadedBy || "Unknown";
}

function determineCommentType(item) {
  // Prefer an explicit server-provided label when present (normalize variants)
  const raw = item.commentType || "";
  const ct = String(raw).trim();
  const lc = ct.toLowerCase();

  // Normalise server-side no comments variants to the exact label we want - FIXED
  if (lc === 'no-comment' || lc === 'no comments' || lc === 'no-comments' || lc === 'no_comments' ||
    lc === 'gl_no_comments' || lc === 'glnocomments' || lc === 'sgl_no_comments' || lc === 'sglnocomments' ||
    (lc.includes('no') && lc.includes('comment'))) {
    return 'no-comment';
  }


  // If server already labelled it as annotated, respect that
  if (lc.includes("annotat") || lc.includes("annotated")) {
    return "Commented: Annotated";
  }

  // If server labelled it explicitly as text-comment
  if (lc.includes("commented: text") || lc === "commented: text") {
    return "Commented: Text";
  }

  // Fallbacks based on fileType (server sometimes uses fileType 'comment') - FIXED
  if (item.fileType === 'base') return 'Base Upload';
  if (item.fileType === 'text') return 'Commented Text';
  if (item.fileType === 'comment') {
    // FIRST check if item.type indicates no-comment (underscore variants)
    if (item.type) {
      const typeStr = String(item.type).toLowerCase();
      if (typeStr === 'no_comments' || typeStr === 'gl_no_comments' || typeStr === 'sgl_no_comments' ||
        typeStr === 'nocomments' || typeStr === 'glnocomments' || typeStr === 'sglnocomments') {
        return 'no-comment';
      }
    }

    // If item.type or commentType hint contains annotation, treat as annotated
    if (item.type && String(item.type).toLowerCase().includes('annot') || lc.includes('annot')) {
      return 'Commented Annotated';
    }
    return 'Commented File';
  }


  // If server gave some other free-form label, return it (but keep no-comment normalized)
  if (ct) {
    return ct;
  }

  return "Unknown";
}

function extractUploadCount(filename) {
  const match = filename.match(/_R\d+-(\d+)\.pdf$/);
  return match ? parseInt(match[1], 10) : 1;
}

function isBaseUploadFile(item) {
  return item.fileType === "base" && item.fileName.match(/_R\d+-\d+\.pdf$/);
}

function shouldHighlightForChecker(item, history) {
  if (!isBaseUploadFile(item)) return false;

  // Find the latest base upload file
  const baseFiles = history.filter((h) => isBaseUploadFile(h));
  if (baseFiles.length === 0) return false;

  // Sort by upload count and get the latest
  const latestFile = baseFiles.reduce((latest, current) => {
    const latestCount = extractUploadCount(latest.fileName);
    const currentCount = extractUploadCount(current.fileName);
    return currentCount > latestCount ? current : latest;
  });

  return item.fileName === latestFile.fileName;
}

function shouldHighlightForGL(item) {
  const ctype = determineCommentType(item);
  // Highlight consolidated _PMS.pdf when it represents 'no comments' OR
  // when the server explicitly marked it consolidated_no_comments
  return (
    item.fileName &&
    item.fileName.includes("_PMS.pdf") &&
    (ctype === "no-comment" || item.type === "consolidated_no_comments")
  );
}

function shouldHighlightForSGL(item) {
  return (
    item.fileName.includes("_PMSA.pdf") &&
    (item.commentType === "No Comments" ||
      determineCommentType(item) === "No Comments")
  );
}

function showTextCommentPopup(comment) {
  // Remove existing popup if any
  const existingPopup = document.getElementById("text-comment-popup");
  if (existingPopup) {
    existingPopup.remove();
  }

  const popup = document.createElement("div");
  popup.id = "text-comment-popup";
  popup.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border: 2px solid #007bff;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 10000;
    max-width: 500px;
    max-height: 400px;
  `;

  popup.innerHTML = `
    <div style="padding: 15px; border-bottom: 1px solid #ddd; background: #f8f9fa; display: flex; justify-content: space-between; align-items: center;">
      <h4 style="margin: 0; color: #007bff;">Text Comment</h4>
      <button onclick="closeTextCommentPopup()" style="background: #6c757d; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">✕</button>
    </div>
    <div style="padding: 20px; max-height: 300px; overflow-y: auto;">
      <div style="background: #f8f9fa; padding: 15px; border-radius: 4px; white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.4;">
        ${comment || "No comment text available"}
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  // Close popup when clicking outside
  setTimeout(() => {
    document.addEventListener("click", handlePopupOutsideClick);
  }, 100);
}

function closeTextCommentPopup() {
  const popup = document.getElementById("text-comment-popup");
  if (popup) {
    popup.remove();
  }
  document.removeEventListener("click", handlePopupOutsideClick);
}

function handlePopupOutsideClick(event) {
  const popup = document.getElementById("text-comment-popup");
  if (popup && !popup.contains(event.target)) {
    closeTextCommentPopup();
  }
}

// Make functions globally available
window.showTextCommentPopup = showTextCommentPopup;
window.closeTextCommentPopup = closeTextCommentPopup;

// ── Process Engineering Data Strip ──────────────────────────────────────────
function loadLinelistDataStrip() {
  // Defer by one tick so the view's innerHTML is fully parsed into the DOM
  setTimeout(_doLoadLinelistDataStrip, 0);
}

async function _doLoadLinelistDataStrip() {
  const task = currentPerformanceTask;
  console.log('[LL-Strip] task =', task);
  if (!task) { console.warn('[LL-Strip] no task'); return; }

  // Find the placeholder already baked into the template
  let strip = document.getElementById('ll-data-strip');
  console.log('[LL-Strip] strip element =', strip);
  if (!strip) {
    // Fallback: create and inject after the task table
    const anchor = document.querySelector('.task-details-table-container');
    console.warn('[LL-Strip] placeholder missing, anchor =', anchor);
    if (!anchor) return;
    strip = document.createElement('div');
    strip.id = 'll-data-strip';
    anchor.insertAdjacentElement('afterend', strip);
  }

  strip.style.cssText = 'margin:0 0 16px;border:1px solid #b8d4f8;border-radius:6px;overflow:hidden;';
  strip.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:#555;background:#edf4ff;">Loading line engineering data…</div>`;

  try {
    const res = await fetch(
      `/api/linelist/line-data?jobNo=${encodeURIComponent(task.jobNo)}&lineNo=${encodeURIComponent(task.lineNo)}`,
      { credentials: 'same-origin' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data: d } = await res.json();

    if (!d) {
      strip.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:#555;background:#edf4ff;">No line list data found for this line.</div>`;
      return;
    }

    const fmt = (v, u) => {
      const val = (v || '').toString().trim();
      const unit = (u || '').toString().trim();
      return val ? (unit ? `${val} ${unit}` : val) : '—';
    };

    const tableRows = [
      ['Design Temp',     fmt(d.design_temp,     d.design_temp_unit),    'Design Press',   fmt(d.design_press,   d.design_press_unit)],
      ['Oper. Temp',      fmt(d.operating_temp,  d.operating_temp_unit), 'Fluid State',    d.fluid_state          || '—'],
      ['Min Design Temp', fmt(d.min_design_temp, d.min_design_temp_unit),'Line Class',     d.line_class           || '—'],
      ['Insulation',      d.insulation           || '—',                  'Ins. Thickness', d.insulation_thickness || '—'],
    ];

    strip.innerHTML = `
      <div style="background:#dbeafe;padding:7px 14px;border-bottom:1px solid #b8d4f8;">
        <span style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.8px;">Line Engineering Data</span>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#f0f7ff;">
        <tbody>
          ${tableRows.map((r, i) => `
          <tr style="${i < tableRows.length - 1 ? 'border-bottom:1px solid #d1e8ff;' : ''}">
            <td style="padding:8px 14px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:16%;">${r[0]}</td>
            <td style="padding:8px 14px;font-size:13px;font-weight:600;color:#1e3a5f;width:34%;border-right:1px solid #d1e8ff;">${r[1]}</td>
            <td style="padding:8px 14px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:16%;">${r[2]}</td>
            <td style="padding:8px 14px;font-size:13px;font-weight:600;color:#1e3a5f;width:34%;">${r[3]}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  } catch (e) {
    strip.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:#b91c1c;background:#fef2f2;">Could not load line data: ${e.message}</div>`;
  }

  loadLmsDataStrip();
}

// ── Line Engineering Data Table ───────────────────────────────────────────────
async function renderLineEngData(taskOverride, opts) {
  const task = taskOverride || currentPerformanceTask;
  if (!task || !task.jobNo || !task.lineNo) return;

  const _engBodyId = (opts && opts.engBodyId) || 'crp-tab-body-engdata';

  // Tab mode (unified card) or legacy standalone card
  const strip = document.getElementById(_engBodyId) || document.getElementById('ll-data-strip');
  if (!strip) return;
  const _tabMode = strip.id === _engBodyId && _engBodyId !== 'll-data-strip';

  const _loading = s => _tabMode
    ? `<div style="display:flex;align-items:center;justify-content:center;height:100%;"><span style="font-size:12px;color:#94a3b8;">${s}</span></div>`
    : `<div class="crp-dc-header crp-dc-header-eng">Line Engineering Data</div><div class="crp-dc-body" style="display:flex;align-items:center;justify-content:center;"><span style="font-size:12px;color:#94a3b8;">${s}</span></div>`;

  strip.innerHTML = _loading('Loading…');

  try {
    const [engRes, inchRes] = await Promise.all([
      fetch(`/api/linelist/line-data?jobNo=${encodeURIComponent(task.jobNo)}&lineNo=${encodeURIComponent(task.lineNo)}`, { credentials: 'same-origin' }),
      fetch(`/api/inch/line?project=${encodeURIComponent(task.jobNo)}&unit=${encodeURIComponent(task.unitNo || '')}&lineNo=${encodeURIComponent(task.lineNo)}`, { credentials: 'same-origin' }),
    ]);

    const { data: d } = await engRes.json();
    const inchJson = await inchRes.json().catch(() => ({ ok: false }));
    const inch = (inchJson.ok && inchJson.data) ? inchJson.data : null;

    if (!d && !inch) {
      strip.innerHTML = _loading('No line data for this line');
      loadLmsDataStrip(task, opts);
      return;
    }

    const fmt = (v, u) => {
      const val = (v || '').toString().trim();
      const unit = (u || '').toString().trim();
      return val ? (unit ? `${val} ${unit}` : val) : '—';
    };
    const fmtN = v => (v != null && v !== '') ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';

    // Flat list of [label, value] pairs — renders as vertical 2-column table
    const fields = [];
    if (d) {
      fields.push(
        ['Design Temp',     fmt(d.design_temp,     d.design_temp_unit)],
        ['Design Press',    fmt(d.design_press,    d.design_press_unit)],
        ['Oper. Temp',      fmt(d.operating_temp,  d.operating_temp_unit)],
        ['Fluid State',     d.fluid_state          || '—'],
        ['Min Design Temp', fmt(d.min_design_temp, d.min_design_temp_unit)],
        ['Line Class',      d.line_class           || '—'],
        ['Insulation',      d.insulation           || '—'],
        ['Ins. Thickness',  d.insulation_thickness || '—'],
      );
    }

    const TL = 'padding:7px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:44%;border-right:1px solid #d1e8ff;';
    const TV = 'padding:7px 12px;font-size:13px;font-weight:600;color:#1e3a5f;';

    const engRows = fields.map((f, i) =>
      `<tr style="${i < fields.length - 1 ? 'border-bottom:1px solid #d1e8ff;' : ''}">` +
      `<td style="${TL}">${f[0]}</td>` +
      `<td style="${TV}">${f[1]}</td>` +
      `</tr>`
    ).join('');

    // Inch Dia / Inch Meter as teal-accented rows appended below
    const inchRows = inch ? [
      ['Inch Dia',   fmtN(inch.inchDia)],
      ['Inch Meter', fmtN(inch.inchMeter)],
    ].map((f, i) =>
      `<tr style="background:#f0fdfa;border-top:${i === 0 ? '2px solid #99f6e4' : 'none'};border-bottom:${i === 0 ? '1px solid #99f6e4' : 'none'};">` +
      `<td style="${TL.replace('#6b7280','#0f766e').replace('#d1e8ff','#99f6e4')}">${f[0]}</td>` +
      `<td style="${TV.replace('#1e3a5f','#0f766e')}font-size:14px;">${f[1]}</td>` +
      `</tr>`
    ).join('') : '';

    const tableHtml = `<table style="width:100%;border-collapse:collapse;background:#f0f7ff;"><tbody>${engRows}${inchRows}</tbody></table>`;
    strip.innerHTML = _tabMode
      ? tableHtml
      : '<div class="crp-dc-header crp-dc-header-eng">Line Engineering Data</div>' +
        `<div class="crp-dc-body">${tableHtml}</div>`;

  } catch (e) {
    strip.innerHTML = _tabMode
      ? `<div style="padding:10px 14px;font-size:12px;color:#b91c1c;">Error: ${e.message}</div>`
      : '<div class="crp-dc-header crp-dc-header-eng">Line Engineering Data</div>' +
        `<div class="crp-dc-body" style="padding:10px 14px;font-size:12px;color:#b91c1c;">Error: ${e.message}</div>`;
  }

  loadLmsDataStrip(task, opts);
}

// ── Forward GL Commented line to Modeller (from PC or SC) ────────────────────
async function handleForwardGLToModeller(forwardType) {
  const task = currentPerformanceTask;
  if (!task) return;

  const btn = forwardType === 'direct'
    ? document.getElementById('btn-fwd-direct')
    : document.getElementById('btn-confirm-edit-fwd');
  const origText = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const fd = new FormData();
    fd.append('jobNo',       task.jobNo);
    fd.append('unitNo',      task.unitNo);
    fd.append('lineNo',      task.lineNo);
    fd.append('forwardType', forwardType);

    if (forwardType === 'edit') {
      const comment = document.getElementById('gl-edit-comment')?.value.trim() || '';
      const file    = document.getElementById('gl-edit-file')?.files[0];
      if (comment) fd.append('comment', comment);
      if (file)    fd.append('commentFile', file);
    }

    // Include modeller routing selection if present (reuse existing selector)
    const modellerSel = document.getElementById('target-modeller-select');
    if (modellerSel?.value) fd.append('targetModellerId', modellerSel.value);

    const res = await fetch('/api/forward-gl-to-modeller', { method: 'POST', body: fd });
    const d   = await res.json();

    if (d.ok) {
      alert('Line forwarded to Modeller for incorporation.');
      try {
        if (typeof showMyTasks === 'function') showMyTasks();
        if (typeof refreshMyTasksView === 'function') await refreshMyTasksView();
      } catch (_) {}
    } else {
      alert('Error: ' + (d.error || 'Failed to forward'));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// ── LMS Data Strip (Line Mounted Summary) ─────────────────────────────────────
async function loadLmsDataStrip(taskOverride, opts) {
  const task = taskOverride || currentPerformanceTask;
  if (!task || !task.jobNo || !task.unitNo || !task.lineNo) return;

  const _tabBarId    = (opts && opts.tabBarId)    || 'crp-tab-bar';
  const _tabBodiesId = (opts && opts.tabBodiesId) || 'crp-tab-bodies';

  // ── Tab mode: unified card — create one tab per lms_type ────────────────────
  const _tabBar    = document.getElementById(_tabBarId);
  const _tabBodies = document.getElementById(_tabBodiesId);
  if (_tabBar && _tabBodies) {
    try {
      const _lmb = String(task.lineNo).match(/^([A-Za-z]+-\d+-[A-Za-z0-9]{1,7})/);
      const _base = _lmb ? _lmb[1] : task.lineNo.replace(/-[A-Za-z]$/, '');

      const _res = await fetch(
        `/api/lms/line?project=${encodeURIComponent(task.jobNo)}&unit=${encodeURIComponent(task.unitNo)}&lineNo=${encodeURIComponent(_base)}`,
        { credentials: 'same-origin' }
      );
      if (!_res.ok) throw new Error(`HTTP ${_res.status}`);
      const _d = await _res.json();

      if (!_d.ok || !_d.rows || !_d.rows.length) return; // no LMS data — no tabs

      const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const _TL = 'padding:6px 12px;font-size:11px;color:#0e7490;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:44%;border-right:1px solid #a5f3fc;';
      const _TV = 'padding:6px 12px;font-size:12.5px;font-weight:600;color:#134e4a;';

      // Helper: find the instrument tag number from row_data columns
      // Looks for common "tag" column names; falls back to equip_raw
      const _pickTag = row => {
        const data = row.rowData || {};
        const norm = s => s.toLowerCase().replace(/[\s._\-]/g, '');
        const exact = ['tagno','tagnumber','tag','instrumenttag','equipmenttag',
                       'itemno','itemnumber','equipmentno','tagid','instrumentno'];
        for (const k of Object.keys(data)) {
          if (exact.includes(norm(k))) {
            const v = data[k];
            if (v != null && String(v).trim()) return String(v).trim();
          }
        }
        // second pass: any column whose normalised name contains 'tag'
        for (const k of Object.keys(data)) {
          if (norm(k).includes('tag')) {
            const v = data[k];
            if (v != null && String(v).trim()) return String(v).trim();
          }
        }
        return (row.equipRaw || '').trim();
      };

      // One tab per LMS record — label from instrument tag column in row_data
      _d.rows.forEach((row, rowIdx) => {
        const tagVal   = _pickTag(row);
        const tabLabel = tagVal.length > 22 ? tagVal.substring(0, 20) + '…' : (tagVal || ('Item ' + (rowIdx + 1)));
        const _tabId   = 'lms-item-' + rowIdx;

        // Tab button
        if (!_tabBar.querySelector(`[data-tab="${_tabId}"]`)) {
          const _btn = document.createElement('button');
          _btn.className   = 'crp-tab';
          _btn.dataset.tab = _tabId;
          _btn.textContent = tabLabel;
          _btn.title       = tagVal;
          _btn.onclick     = (function(id, barId, bodiesId) {
            return function() { switchTabInPanel(id, barId, bodiesId); };
          })(_tabId, _tabBarId, _tabBodiesId);
          _tabBar.appendChild(_btn);
        }

        // Tab body — prefix body ID with the tab bar ID so GL/SGL don't clash with checker
        const _bodyId = _tabBarId === 'crp-tab-bar' ? ('crp-tab-body-' + _tabId) : (_tabBarId + '-body-' + _tabId);
        let _body = document.getElementById(_bodyId);
        if (!_body) {
          _body = document.createElement('div');
          _body.className = 'crp-tab-body';
          _body.id        = _bodyId;
          _tabBodies.appendChild(_body);
        }

        // Render this item's key-value pairs as vertical table
        const _keys = Object.keys(row.rowData || {});
        const _html = _keys.map((k, i) => {
          const v      = row.rowData[k];
          const empty  = v == null || v === '';
          const isNum  = !empty && !isNaN(v) && String(v).trim() !== '';
          const val    = empty ? '—' : (isNum ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 }) : _esc(String(v)));
          return `<tr style="${i < _keys.length - 1 ? 'border-bottom:1px solid #e0f7fa;' : ''}">` +
            `<td style="${_TL}">${_esc(k)}</td>` +
            `<td style="${_TV}${isNum ? 'text-align:right;font-variant-numeric:tabular-nums;' : ''}">${val}</td>` +
            `</tr>`;
        }).join('');

        _body.innerHTML = `<table style="width:100%;border-collapse:collapse;background:#f0fdfe;"><tbody>${_html}</tbody></table>`;
      });
    } catch (e) {
      console.error('[LMS] tab-mode error:', e.message);
    }
    return; // tab mode handled — skip old lmsStrip logic
  }

  // ── Legacy mode: populate #lms-data-strip card ───────────────────────────────
  let lmsStrip = document.getElementById('lms-data-strip');
  if (!lmsStrip) {
    const anchor = document.getElementById('ll-data-strip') ||
                   document.querySelector('.task-details-table-container');
    if (!anchor) return;
    lmsStrip = document.createElement('div');
    lmsStrip.id = 'lms-data-strip';
    anchor.insertAdjacentElement('afterend', lmsStrip);
  }

  const LMS_HDR =
    '<div class="crp-dc-header crp-dc-header-lms">' +
      '<span class="crp-lms-badge">LMS</span> Line Mounted Summary' +
    '</div>';

  lmsStrip.innerHTML =
    LMS_HDR +
    '<div class="crp-dc-body" style="display:flex;align-items:center;justify-content:center;">' +
      '<span style="font-size:12px;color:#94a3b8;">Loading…</span>' +
    '</div>';

  try {
    // Extract base PREFIX-UNIT-SEQNO, dropping zone and subline
    // e.g. TRM-111-VV1227-01-A → TRM-111-VV1227,  P-101-12000-A → P-101-12000
    const _lm = String(task.lineNo).match(/^([A-Za-z]+-\d+-[A-Za-z0-9]{1,7})/);
    const baseLineNo = _lm ? _lm[1] : task.lineNo.replace(/-[A-Za-z]$/, '');

    const res = await fetch(
      `/api/lms/line?project=${encodeURIComponent(task.jobNo)}&unit=${encodeURIComponent(task.unitNo)}&lineNo=${encodeURIComponent(baseLineNo)}`,
      { credentials: 'same-origin' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    if (!d.ok || !d.rows || !d.rows.length) {
      lmsStrip.innerHTML =
        LMS_HDR +
        '<div class="crp-dc-body" style="display:flex;align-items:center;justify-content:center;">' +
          '<span style="font-size:12px;color:#94a3b8;font-style:italic;">No LMS data for this line</span>' +
        '</div>';
      return;
    }

    // Collect all unique keys in order
    const keySet = new Set();
    const keys   = [];
    d.rows.forEach(r => {
      if (r.rowData) Object.keys(r.rowData).forEach(k => {
        if (!keySet.has(k)) { keySet.add(k); keys.push(k); }
      });
    });

    const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const TL = 'padding:6px 12px;font-size:11px;color:#0e7490;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:44%;border-right:1px solid #a5f3fc;';
    const TV = 'padding:6px 12px;font-size:12.5px;font-weight:600;color:#134e4a;';

    // Render each row's key-value pairs vertically; add separator between records
    const bodyRows = d.rows.map((row, rowIdx) => {
      const sep = d.rows.length > 1
        ? `<tr><td colspan="2" style="padding:3px 12px 3px;font-size:10px;font-weight:700;color:#0891b2;background:#e0f7fa;border-bottom:1px solid #a5f3fc;border-top:${rowIdx > 0 ? '2px solid #a5f3fc' : 'none'};">` +
          `Record ${rowIdx + 1}</td></tr>`
        : '';
      const fieldRows = keys.map((k, i) => {
        const v = row.rowData?.[k];
        const isEmpty = v == null || v === '';
        const isNum = !isEmpty && !isNaN(v) && String(v).trim() !== '';
        const val = isEmpty ? '—' : (isNum ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 }) : esc(String(v)));
        const isLast = i === keys.length - 1 && rowIdx === d.rows.length - 1;
        return `<tr style="${isLast ? '' : 'border-bottom:1px solid #e0f7fa;'}">` +
          `<td style="${TL}">${esc(k)}</td>` +
          `<td style="${TV}${isNum ? 'text-align:right;font-variant-numeric:tabular-nums;' : ''}">${val}</td>` +
          `</tr>`;
      }).join('');
      return sep + fieldRows;
    }).join('');

    const countLabel = d.rows.length + ' record' + (d.rows.length !== 1 ? 's' : '');

    lmsStrip.innerHTML =
      '<div class="crp-dc-header crp-dc-header-lms">' +
        '<span class="crp-lms-badge">LMS</span> Line Mounted Summary ' +
        `<span style="font-size:10.5px;color:#0891b2;font-weight:400;margin-left:2px;">(${countLabel})</span>` +
      '</div>' +
      '<div class="crp-dc-body">' +
        `<table style="width:100%;border-collapse:collapse;background:#f0fdfe;">` +
          `<tbody>${bodyRows}</tbody>` +
        `</table>` +
      '</div>';

  } catch (e) {
    lmsStrip.innerHTML =
      LMS_HDR +
      `<div class="crp-dc-body" style="padding:10px 14px;font-size:12px;color:#b91c1c;">Could not load LMS data: ${e.message}</div>`;
  }
}

// ── Hold Declaration Modal ───────────────────────────────────────────────────
// Returns Promise<{holdType, holdDescription}> or null when user cancels.
function captureHoldDeclaration() {
  return new Promise((resolve) => {
    const existing = document.getElementById('hold-declaration-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'hold-declaration-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:20000;font-family:\'DM Sans\',sans-serif;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.22);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h3 style="margin:0;font-size:16px;font-weight:700;color:#0d1f3c;">Hold Declaration</h3>
          <button id="hd-cancel-x" style="background:none;border:none;font-size:22px;color:#94a3b8;cursor:pointer;line-height:1;">×</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <label style="display:flex;align-items:center;gap:10px;font-size:14px;color:#334155;cursor:pointer;">
            <input type="radio" name="hd-type" value="none" checked style="accent-color:#007bff;width:16px;height:16px;"> No holds
          </label>
          <label style="display:flex;align-items:center;gap:10px;font-size:14px;color:#334155;cursor:pointer;">
            <input type="radio" name="hd-type" value="has-hold" style="accent-color:#007bff;width:16px;height:16px;"> Has hold
          </label>
        </div>
        <div id="hd-hold-body" style="display:none;margin-top:16px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
          <!-- Minor hold only — Blocking Hold is now its own independent button in the
               Review Action box, not a sub-choice here. A blocking issue isn't compatible
               with "No Comments" semantics, and shouldn't wait on other checkers either;
               see the dedicated "Blocking Hold" action for that. -->
          <div id="hd-minor-section">
            <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:5px;">Category</label>
            <select id="hd-minor-category" style="width:100%;padding:7px 10px;border:1px solid #cbd5e1;border-radius:5px;font-size:13px;color:#334155;background:#fff;margin-bottom:10px;">
              <option value="">— Select category —</option>
              <option value="Design Clarification Pending">Design Clarification Pending</option>
              <option value="Material Specification Query">Material Specification Query</option>
              <option value="Stress Analysis Pending">Stress Analysis Pending</option>
              <option value="Client Input / TQ Required">Client Input / TQ Required</option>
              <option value="Interdisciplinary Conflict">Interdisciplinary Conflict</option>
              <option value="Documentation Incomplete">Documentation Incomplete</option>
            </select>
            <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:5px;">Additional Info (optional)</label>
            <textarea id="hd-minor-info" rows="2" placeholder="Any additional context…"
              style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #cbd5e1;border-radius:5px;font-size:13px;color:#334155;resize:vertical;"></textarea>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:22px;">
          <button id="hd-cancel-btn" style="padding:8px 20px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
          <button id="hd-confirm-btn" style="padding:8px 20px;background:#007bff;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Confirm Submit</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    overlay.querySelectorAll('input[name="hd-type"]').forEach(r => {
      r.addEventListener('change', () => {
        overlay.querySelector('#hd-hold-body').style.display = r.value === 'has-hold' ? 'block' : 'none';
      });
    });

    function cancel() { overlay.remove(); resolve(null); }

    function confirm() {
      const typeRadio = overlay.querySelector('input[name="hd-type"]:checked');
      if (typeRadio.value === 'none') { overlay.remove(); resolve({ holdType: null, holdDescription: null }); return; }
      // "Has hold" now only ever means minor — Blocking Hold has its own button elsewhere.
      const cat = overlay.querySelector('#hd-minor-category').value;
      const info = (overlay.querySelector('#hd-minor-info').value || '').trim();
      if (!cat) { alert('Please select a hold category'); return; }
      const holdDescription = cat + (info ? ': ' + info : '');
      overlay.remove();
      resolve({ holdType: 'minor', holdDescription });
    }

    overlay.querySelector('#hd-cancel-x').addEventListener('click', cancel);
    overlay.querySelector('#hd-cancel-btn').addEventListener('click', cancel);
    overlay.querySelector('#hd-confirm-btn').addEventListener('click', confirm);
    overlay.addEventListener('click', e => { if (e.target === overlay) cancel(); });
  });
}

// ── Blocking Hold Modal ──────────────────────────────────────────────────────
// Independent escalation action — description only, no comment-type choice.
// Resolves the trimmed description string, or null if cancelled.
function captureBlockingHoldDescription() {
  return new Promise((resolve) => {
    const existing = document.getElementById('blocking-hold-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'blocking-hold-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:20000;font-family:\'DM Sans\',sans-serif;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.22);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0;font-size:16px;font-weight:700;color:#b91c1c;">🛑 Blocking Hold</h3>
          <button id="bh-cancel-x" style="background:none;border:none;font-size:22px;color:#94a3b8;cursor:pointer;line-height:1;">×</button>
        </div>
        <p style="margin:0 0 14px;font-size:12.5px;color:#78350f;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:9px 12px;">
          This immediately parks the line — it will not proceed further until the Modeller re-uploads. Anyone else still reviewing this line will be notified that no action is needed this cycle.
        </p>
        <label style="display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:5px;">Describe the blocking issue <span style="color:#e53935;">*</span></label>
        <textarea id="bh-desc" rows="4" placeholder="Describe why this line is blocked…"
          style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e53935;border-radius:5px;font-size:13px;color:#334155;resize:vertical;"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
          <button id="bh-cancel-btn" style="padding:8px 20px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
          <button id="bh-confirm-btn" style="padding:8px 20px;background:#e53935;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Declare Blocking Hold</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    function cancel() { overlay.remove(); resolve(null); }
    function confirm() {
      const desc = (overlay.querySelector('#bh-desc').value || '').trim();
      if (!desc) { alert('Please describe the blocking issue.'); return; }
      overlay.remove();
      resolve(desc);
    }

    overlay.querySelector('#bh-cancel-x').addEventListener('click', cancel);
    overlay.querySelector('#bh-cancel-btn').addEventListener('click', cancel);
    overlay.querySelector('#bh-confirm-btn').addEventListener('click', confirm);
    overlay.addEventListener('click', e => { if (e.target === overlay) cancel(); });
  });
}

// ── Hold History Modal ───────────────────────────────────────────────────────
// drawingId OR lineNo+jobNo+unitNo must be provided.
async function showLineHoldsModal(drawingId, lineNo, jobNo, unitNo) {
  const existing = document.getElementById('line-holds-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'line-holds-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:20001;font-family:\'DM Sans\',sans-serif;';

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:600px;width:92%;max-height:80vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.22);display:flex;flex-direction:column;">
      <div style="background:linear-gradient(135deg,#0d1f3c,#1e40af);padding:16px 22px;display:flex;justify-content:space-between;align-items:center;border-radius:12px 12px 0 0;">
        <div>
          <div style="font-size:15px;font-weight:700;color:#fff;">Hold History</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px;">${lineNo || ''}</div>
        </div>
        <button id="lh-close" style="background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:20px;width:30px;height:30px;border-radius:50%;cursor:pointer;line-height:1;">×</button>
      </div>
      <div id="lh-body" style="padding:20px;overflow-y:auto;flex:1;">
        <div style="text-align:center;color:#94a3b8;padding:24px;">Loading holds…</div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#lh-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // Store context for removeHoldEntry refresh
  window._lineHoldsCtx = { drawingId, lineNo, jobNo, unitNo };

  try {
    let url = '/api/line-holds?';
    if (drawingId) url += `drawingId=${encodeURIComponent(drawingId)}`;
    else url += `lineNo=${encodeURIComponent(lineNo)}&jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo || '')}`;

    const resp = await fetch(url, { credentials: 'same-origin' });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);

    const body = overlay.querySelector('#lh-body');
    if (!data.holdsByCycle || data.holdsByCycle.length === 0) {
      body.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:24px;">No holds declared for this line.</div>';
      return;
    }

    body.innerHTML = data.holdsByCycle.map((cycle, ci) => {
      const label  = cycle.isCurrent ? `Current Cycle (Cycle ${cycle.cycleNo ?? '—'})` : `Cycle ${cycle.cycleNo ?? '—'}`;
      const labelColor = cycle.isCurrent ? '#1e40af' : '#64748b';
      const labelBg    = cycle.isCurrent ? '#dbeafe' : '#f1f5f9';
      const holds = cycle.holds.map(h => {
        const tc = h.holdType === 'blocking' ? '#e53935' : '#f59e0b';
        const tb = h.holdType === 'blocking' ? '#fef2f2' : '#fffbeb';
        const removeBtn = h.canRemove
          ? `<button onclick="removeHoldEntry(${h.commentId},this)" style="padding:3px 10px;background:#fee2e2;color:#e53935;border:1px solid #fecaca;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;">Remove</button>`
          : '';
        return `
          <div style="padding:10px 12px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:8px;background:#fff;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:700;color:#334155;">${h.userName || h.userId}
                  <span style="font-weight:400;color:#64748b;">(${(h.roles||[]).join(', ')})</span></div>
                <div style="margin-top:4px;">
                  <span style="display:inline-block;padding:1px 8px;background:${tb};color:${tc};border-radius:10px;font-size:11px;font-weight:700;text-transform:uppercase;">${h.holdType}</span>
                  ${h.holdDescription ? `<span style="font-size:12.5px;color:#475569;margin-left:8px;">${h.holdDescription}</span>` : ''}
                </div>
                <div style="font-size:11px;color:#94a3b8;margin-top:3px;">${h.createdAt ? new Date(h.createdAt).toLocaleString() : ''}</div>
              </div>
              ${removeBtn}
            </div>
          </div>`;
      }).join('');

      return `
        <div style="margin-bottom:${ci < data.holdsByCycle.length - 1 ? '18px' : '0'};">
          <div style="margin-bottom:8px;">
            <span style="padding:2px 10px;background:${labelBg};color:${labelColor};border-radius:10px;font-size:11px;font-weight:700;">${label}</span>
          </div>
          ${holds}
        </div>`;
    }).join('');
  } catch (err) {
    console.error('Error loading holds:', err);
    overlay.querySelector('#lh-body').innerHTML = '<div style="text-align:center;color:#e53935;padding:24px;">Failed to load holds.</div>';
  }
}

async function removeHoldEntry(commentId, btn) {
  if (!confirm('Remove this hold?')) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const resp = await fetch(`/api/drawing-comments/${commentId}/hold`, { method: 'PATCH', credentials: 'same-origin' });
    const data = await resp.json();
    if (data.ok) {
      const ctx = window._lineHoldsCtx || {};
      // Refresh whichever view is active — inline panel or modal
      if (window._lineHoldsInlineContainerId) {
        await renderHoldsInline(ctx.lineNo, ctx.jobNo, ctx.unitNo, window._lineHoldsInlineContainerId);
      } else {
        await showLineHoldsModal(ctx.drawingId, ctx.lineNo, ctx.jobNo, ctx.unitNo);
      }
    } else {
      alert(data.error || 'Failed to remove hold');
      btn.disabled = false; btn.textContent = 'Remove';
    }
  } catch (err) {
    alert('Network error'); btn.disabled = false; btn.textContent = 'Remove';
  }
}
window.removeHoldEntry = removeHoldEntry;

// ── Inline Hold History renderer ─────────────────────────────────────────────
// Renders hold history directly into a container element (tab body or data strip card).
async function renderHoldsInline(lineNo, jobNo, unitNo, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  window._lineHoldsCtx = { lineNo, jobNo, unitNo };
  window._lineHoldsInlineContainerId = containerId;

  container.innerHTML = '<div style="padding:12px;color:#94a3b8;font-size:12px;text-align:center;">Loading hold history…</div>';

  try {
    const resp = await fetch(
      `/api/line-holds?lineNo=${encodeURIComponent(lineNo)}&jobNo=${encodeURIComponent(jobNo)}&unitNo=${encodeURIComponent(unitNo)}`,
      { credentials: 'same-origin' }
    );
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);

    if (!data.holdsByCycle || data.holdsByCycle.length === 0) {
      container.innerHTML = '<div style="padding:12px;color:#94a3b8;font-size:12.5px;text-align:center;">No holds declared for this line.</div>';
      return;
    }

    container.innerHTML = data.holdsByCycle.map((cycle, ci) => {
      const label      = cycle.isCurrent ? 'Current Cycle' : `Cycle ${cycle.cycleNo ?? '—'}`;
      const labelColor = cycle.isCurrent ? '#1e40af' : '#64748b';
      const labelBg    = cycle.isCurrent ? '#dbeafe'  : '#f1f5f9';
      const holds = cycle.holds.map(h => {
        const isUnblocked = h.holdType === 'unblocked';
        const tc = isUnblocked ? '#15803d' : (h.holdType === 'blocking' ? '#e53935' : '#f59e0b');
        const tb = isUnblocked ? '#f0fdf4' : (h.holdType === 'blocking' ? '#fef2f2' : '#fffbeb');
        const label = isUnblocked ? 'UNBLOCKED' : (h.holdType || '').toUpperCase();
        const borderColor = isUnblocked ? '#bbf7d0' : '#e2e8f0';
        // Remove button not applicable for unblock events or past-cycle holds
        const removeBtn = (!isUnblocked && h.canRemove)
          ? `<button onclick="removeHoldEntry(${h.commentId},this)" style="padding:2px 8px;background:#fee2e2;color:#e53935;border:1px solid #fecaca;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;">Remove</button>`
          : '';
        return `<div style="padding:8px 10px;border:1px solid ${borderColor};border-radius:5px;margin-bottom:6px;background:#fff;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:700;color:#334155;">${h.userName || h.userId}
                <span style="font-weight:400;color:#64748b;">${(h.roles||[]).length ? '(' + h.roles.join(', ') + ')' : ''}</span></div>
              <div style="margin-top:3px;">
                <span style="display:inline-block;padding:1px 7px;background:${tb};color:${tc};border-radius:9px;font-size:11px;font-weight:700;">${label}</span>
                ${h.holdDescription ? `<span style="font-size:12px;color:#475569;margin-left:6px;">${h.holdDescription}</span>` : ''}
              </div>
              <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${h.createdAt ? new Date(h.createdAt).toLocaleString() : ''}</div>
            </div>
            ${removeBtn}
          </div>
        </div>`;
      }).join('');

      return `<div style="margin-bottom:${ci < data.holdsByCycle.length - 1 ? '14px' : '0'};">
        <span style="display:inline-block;padding:2px 9px;background:${labelBg};color:${labelColor};border-radius:9px;font-size:11px;font-weight:700;margin-bottom:7px;">${label}</span>
        ${holds}
      </div>`;
    }).join('');
  } catch (err) {
    console.error('renderHoldsInline error:', err);
    container.innerHTML = '<div style="padding:8px;color:#e53935;font-size:12px;text-align:center;">Failed to load hold history.</div>';
  }
}
window.renderHoldsInline = renderHoldsInline;

// Export functions for use by other scripts
window.openCheckerView = openCheckerView;
window.openModellerView = openModellerView;
window.openGLView = openGLView;
window.openSGLView = openSGLView;
window.renderLineEngData = renderLineEngData;
window.loadLmsDataStrip = loadLmsDataStrip;
window.showLineHoldsModal = showLineHoldsModal;
