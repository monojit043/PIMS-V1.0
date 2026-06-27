// public/js/script.js - Main script file (cleaned up)

// ================= Left panel resizer =================
const dragHandle = document.querySelector('.drag-handle');
const leftPanel = document.querySelector('.left-panel');

let isDragging = false;
let startX;
let startWidth;

if (dragHandle && leftPanel) {
  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = leftPanel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    let newWidth = startWidth + dx;
    newWidth = Math.max(150, Math.min(newWidth, window.innerWidth * 0.7));
    leftPanel.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  });
}

// ================= LEFT PANEL INTERACTION - Collapsible folders =================
document.querySelectorAll('.folder-header').forEach(header => {
  header.addEventListener('click', function () {
    this.parentElement.classList.toggle('active');
  });
});

// ================= Dropdowns =================
function toggleDropdown(event) {
  event.stopPropagation();
  document.querySelectorAll('.dropdown').forEach(drop => drop.classList.remove('show'));
  const dropdown = event.currentTarget.closest('.dropdown');
  if (dropdown) dropdown.classList.toggle('show');
}
window.toggleDropdown = toggleDropdown;

window.addEventListener('click', function (e) {
  // Close all open dropdowns when clicking outside any .dropdown
  if (!e.target.closest('.dropdown')) {
    document.querySelectorAll('.dropdown.show').forEach(drop => {
      drop.classList.remove('show');
    });
  }
});


// ================= Upload / Reports popups =================
const uploadBtn = document.getElementById('upload-isometrics-btn');
if (uploadBtn) {
  uploadBtn.addEventListener('click', (event) => {
    event.preventDefault();
    window.location.href = '/upload.html';
  });
}

const reportsBtn = document.getElementById('reports-btn');
if (reportsBtn) {
  reportsBtn.addEventListener('click', () => {
    window.open('report.html', '_blank');
  });
}

// ================= Show logged-in Name [ID] in left header =================
// ================= Show logged-in Name [ID] in left header (robust, retries once)
function initSidebarForRoles(roles) {
  if (!Array.isArray(roles)) return;

  const CHECKER_ROLES = ['Process Checker', 'Material Checker', 'Stress Checker'];
  const hasModeller = roles.includes('Modeller');
  const hasGL       = roles.includes('GL');
  const hasSGL      = roles.includes('SGL');
  const hasChecker  = CHECKER_ROLES.some(r => roles.includes(r));

  function show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }

  if (hasModeller) show('modeller-notif-btn');
  if (hasGL)       show('gl-notif-btn');
  if (hasChecker)  show('checker-notif-btn');
  if (hasSGL)      show('sgl-notif-btn');

  // Build a short role label for the topbar and user dropdown
  const labelParts = [];
  if (hasModeller) labelParts.push('Modeller');
  if (hasChecker)  labelParts.push('Checker');
  if (hasGL)       labelParts.push('GL');
  if (hasSGL)      labelParts.push('SGL');
  const roleLabel = labelParts.length ? labelParts.join(' / ') : 'Engineer';

  const topbarRole = document.getElementById('topbarUserRole');
  if (topbarRole) topbarRole.textContent = roleLabel;

  const ddRole = document.getElementById('tuDdRole');
  if (ddRole) ddRole.textContent = roleLabel;
}

(async function fillLoggedUserEverywhere() {
  async function doFill() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return false;
      const me = await res.json();
      if (!me || !me.name) return false;
      const label = `${me.name}${me.id ? ' [' + me.id + ']' : ''}`;
      document.querySelectorAll('.loggedUser').forEach(el => { el.textContent = label; });
      // Show/hide sidebar buttons and update role label based on session roles
      initSidebarForRoles(me.roles || []);
      return true;
    } catch (err) {
      console.error('fillLoggedUser error', err);
      return false;
    }
  }

  // Try immediately
  let ok = await doFill();

  // If not ok (maybe timing or session propagation), retry once after 400ms
  if (!ok) {
    setTimeout(async () => {
      await doFill();
    }, 400);
  }
})();


// ================= ADD UNITS MODAL FUNCTIONALITY =================
(function () {
  const modal = document.getElementById('addUnitsModal');
  const closeBtn = document.getElementById('closeModal');
  const cancelBtn = document.getElementById('cancelBtn');
  const addNewRowBtn = document.getElementById('addNewRowBtn');
  const saveUnitsBtn = document.getElementById('saveUnitsBtn');
  const unitFormContainer = document.getElementById('unitFormContainer');

  // Global variable to store selected project for modal
  window.selectedProjectForUnits = null;

  // Show modal function (will be called from SGL.html)
  window.showAddUnitsModal = function (projectId) {
    window.selectedProjectForUnits = projectId;
    modal.style.display = 'block';
  };

  // Close modal function
  function closeModal() {
    modal.style.display = 'none';
    // Reset form
    unitFormContainer.innerHTML = `
      <div class="unit-row">
        <div class="unit-name-section">
          <h4>Unit Name</h4>
          <input type="text" class="unit-name-input" maxlength="10" placeholder="e.g., SRU">
        </div>
        <div class="unit-numbers-section">
          <h4>Unit Numbers</h4>
          <div class="unit-numbers-row">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="414">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="415">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="416">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="455">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="456">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="457">
          </div>
        </div>
      </div>
    `;
    window.selectedProjectForUnits = null;
  }

  // Event listeners
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  // Add new row functionality
  if (addNewRowBtn) {
    addNewRowBtn.addEventListener('click', () => {
      const newRow = document.createElement('div');
      newRow.className = 'unit-row';
      newRow.innerHTML = `
        <div class="unit-name-section">
          <h4>Unit Name</h4>
          <input type="text" class="unit-name-input" maxlength="10" placeholder="e.g., PRU">
        </div>
        <div class="unit-numbers-section">
          <h4>Unit Numbers</h4>
          <div class="unit-numbers-row">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="451">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="452">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="">
            <input type="text" class="unit-number-input" maxlength="5" placeholder="">
          </div>
        </div>
      `;
      unitFormContainer.appendChild(newRow);
    });
  }

  // Save units functionality
  if (saveUnitsBtn) {
    saveUnitsBtn.addEventListener('click', async () => {
      if (!window.selectedProjectForUnits) {
        alert('No project selected');
        return;
      }

      const units = {};
      const unitRows = unitFormContainer.querySelectorAll('.unit-row');

      let hasValidData = false;

      unitRows.forEach(row => {
        const unitNameInput = row.querySelector('.unit-name-input');
        const unitNumberInputs = row.querySelectorAll('.unit-number-input');

        const unitName = unitNameInput.value.trim();
        const unitNumbers = [];

        unitNumberInputs.forEach(input => {
          const num = input.value.trim();
          if (num && /^\d{1,5}$/.test(num)) {
            unitNumbers.push(num);
          }
        });

        if (unitName && unitNumbers.length > 0) {
          units[unitName] = unitNumbers;
          hasValidData = true;
        }
      });

      if (!hasValidData) {
        alert('Please enter at least one unit name with valid unit numbers');
        return;
      }

      try {
        const response = await fetch('/api/projects/add-units', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            projectId: window.selectedProjectForUnits,
            units: units
          })
        });

        const result = await response.json();

        if (result.success) {
          alert('Units added successfully!');
          closeModal();
          // Trigger refresh of units display if we're on SGL page
          if (window.refreshUnitsDisplay) {
            window.refreshUnitsDisplay();
          }
        } else {
          alert('Failed to add units: ' + (result.message || 'Unknown error'));
        }
      } catch (error) {
        console.error('Error adding units:', error);
        alert('Failed to add units. Please try again.');
      }
    });
  }

  // Close modal when clicking outside
  window.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Prevent number inputs from accepting non-numeric characters
  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('unit-number-input')) {
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
      if (e.target.value.length > 5) {
        e.target.value = e.target.value.substring(0, 5);
      }
    }
  });

  // Prevent unit name inputs from exceeding 10 characters
  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('unit-name-input')) {
      if (e.target.value.length > 10) {
        e.target.value = e.target.value.substring(0, 10);
      }
    }
  });
})();

// ================= Initialize page =================
window.addEventListener('load', () => {
  // Initialize left-top panel if available
  if (window.leftTopPanel) {
    window.leftTopPanel.initialize();
  }
});