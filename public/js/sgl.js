let currentUser = null;
let projects = [];
let employees = [];
let selectedProject = null;
let currentAssignments = {};
let projectSGLs = [];

function closeWindow() {
  if (window.opener) {
    window.opener.focus();
    window.close();
  } else {
    window.location.href = '/user.html';
  }
}

function showSuccessModal(message) {
  document.getElementById('successMessage').textContent = message;
  document.getElementById('successModal').style.display = 'block';
}

function closeSuccessModal() {
  document.getElementById('successModal').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', async function () {
  try {
    const userResponse = await fetch('/api/me');
    if (!userResponse.ok) {
      alert('Authentication required. Redirecting to login.');
      window.location.href = '/index.html';
      return;
    }
    currentUser = await userResponse.json();

    if (currentUser && currentUser.name && currentUser.id) {
      document.getElementById('userInfo').textContent = `${currentUser.name}   (${currentUser.id})`;
    }

    await loadProjects();
    await loadEmployees();

    const urlParams = new URLSearchParams(window.location.search);
    const view = urlParams.get('view');

    if (view === 'add') {
      showAddMembersView();
    } else if (view === 'remove') {
      showRemoveMembersView();
    } else {
      showBothViews();
    }

    setupEventListeners();

  } catch (error) {
    console.error('Initialization error:', error);
    alert('Failed to initialize SGL console.');
  }
});

function showAddMembersView() {
  document.getElementById('add-members-section').classList.remove('hidden');
  document.getElementById('remove-members-section').classList.add('hidden');
}

function showRemoveMembersView() {
  document.getElementById('add-members-section').classList.add('hidden');
  document.getElementById('remove-members-section').classList.remove('hidden');
}

function showBothViews() {
  document.getElementById('add-members-section').classList.remove('hidden');
  document.getElementById('remove-members-section').classList.remove('hidden');
}

async function loadProjects() {
  try {
    const res1 = await fetch('/api/projects/assigned', { credentials: 'same-origin' });
    const data1 = await res1.json();
    const bySgl = data1.success ? data1.projects : [];

    const res2 = await fetch('/api/projects', { credentials: 'same-origin' });
    const data2 = await res2.json();
    const byAssign = [];
    if (data2.success) {
      const userId = currentUser.id;
      for (const proj of data2.projects) {
        const ass = await fetch(`/api/projects/${proj.id}/assignments`, { credentials: 'same-origin' });
        const ad = await ass.json();
        if (ad.success && Object.values(ad.assignments).some(u => u[userId])) {
          byAssign.push(proj);
        }
      }
    }

    const map = new Map();
    bySgl.concat(byAssign).forEach(p => map.set(p.id, p));
    projects = Array.from(map.values());

    populateProjectDropdowns();
  } catch (error) {
    console.error('Error loading projects:', error);
  }
}

async function loadEmployees() {
  try {
    const response = await fetch('/api/users/employees');
    const data = await response.json();
    if (data.success) {
      employees = data.users;
    }
  } catch (error) {
    console.error('Error loading employees:', error);
  }
}

function populateProjectDropdowns() {
  const addSelect = document.getElementById('addProjectSelect');
  const removeSelect = document.getElementById('removeProjectSelect');

  [addSelect, removeSelect].forEach(select => {
    select.innerHTML = '<option value="">Select Project</option>';
    projects.forEach(project => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = `${project.id} - ${project.name}`;
      select.appendChild(option);
    });
  });
}

function setupEventListeners() {
  document.getElementById('addUnitsBtn').addEventListener('click', () => {
    const projectId = document.getElementById('addProjectSelect').value;
    if (!projectId) {
      alert('Please select a project first.');
      return;
    }
    selectedProject = projectId;
    document.getElementById('addUnitsModal').style.display = 'block';
  });

  document.getElementById('closeModal').addEventListener('click', closeModal);
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('addNewRowBtn').addEventListener('click', addNewUnitRow);
  document.getElementById('saveUnitsBtn').addEventListener('click', saveUnits);

  document.getElementById('addProjectSelect').addEventListener('change', onAddProjectChange);
  document.getElementById('removeProjectSelect').addEventListener('change', onRemoveProjectChange);

  document.getElementById('assignRolesBtn').addEventListener('click', assignRoles);
  document.getElementById('removeSelectedBtn').addEventListener('click', removeSelected);

  document.addEventListener('change', (e) => {
    if (e.target.closest('#unitsGrid')) {
      updateEmployeeCheckboxes();
    }
    if (e.target.closest('#removeUnitsGrid')) {
      updateRemoveTable();
    }

    // GL hierarchy
    if (e.target.type === 'checkbox' && e.target.value === 'GL') {
      const row = e.target.closest('tr');
      const roleOrder = ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker', 'GL'];
      const checkboxes = roleOrder.map(role => row.querySelector(`input[value="${role}"]`)).filter(Boolean);
      if (e.target.checked) {
        checkboxes.forEach(cb => cb.checked = true);
      } else {
        e.target.checked = false;
      }
    }

    if (e.target.type === 'checkbox' && ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker'].includes(e.target.value)) {
      const row = e.target.closest('tr');
      const glCb = row.querySelector('input[value="GL"]');
      const anyUnticked = ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker']
        .some(role => !row.querySelector(`input[value="${role}"]`).checked);
      if (anyUnticked && glCb) glCb.checked = false;
    }

    // SGL hierarchy
    if (e.target.type === 'checkbox' && e.target.value === 'SGL') {
      const row = e.target.closest('tr');
      const roleOrder = ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker', 'GL', 'SGL'];
      const checkboxes = roleOrder.map(role => row.querySelector(`input[value="${role}"]`)).filter(Boolean);
      if (e.target.checked) {
        checkboxes.forEach(cb => cb.checked = true);
      } else {
        e.target.checked = false;
      }
    }

    if (e.target.type === 'checkbox' && ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker', 'GL'].includes(e.target.value)) {
      const row = e.target.closest('tr');
      const sglCb = row.querySelector('input[value="SGL"]');
      const anyUnticked = ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker', 'GL']
        .some(role => !row.querySelector(`input[value="${role}"]`).checked);
      if (anyUnticked && sglCb) sglCb.checked = false;
    }
  });

  window.addEventListener('click', (e) => {
    if (e.target === document.getElementById('addUnitsModal')) {
      closeModal();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('unit-number-input')) {
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
      if (e.target.value.length > 5) {
        e.target.value = e.target.value.substring(0, 5);
      }
    }
  });
}

function closeModal() {
  document.getElementById('addUnitsModal').style.display = 'none';
  document.getElementById('unitFormContainer').innerHTML = `
    <div class="unit-row">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
      <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    </div>
  `;
}

function addNewUnitRow() {
  const container = document.getElementById('unitFormContainer');
  const newRow = document.createElement('div');
  newRow.className = 'unit-row';
  newRow.innerHTML = `
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
    <input type="text" class="unit-number-input" maxlength="5" placeholder="type">
  `;
  container.appendChild(newRow);
}

function enableAllUnitCheckboxes() {
  document.querySelectorAll('#unitsGrid input[type="checkbox"]').forEach(cb => {
    cb.disabled = false;
  });
}

async function saveUnits() {
  if (!selectedProject) {
    alert('No project selected');
    return;
  }

  const unitRows = document.querySelectorAll('.unit-row');
  const allUnits = [];

  unitRows.forEach(row => {
    row.querySelectorAll('.unit-number-input').forEach(input => {
      const num = input.value.trim();
      if (num && /^\d{1,5}$/.test(num)) {
        allUnits.push(num);
      }
    });
  });

  if (allUnits.length === 0) {
    alert('Please enter at least one valid unit number');
    return;
  }

  let combinedUnits = [...allUnits];
  try {
    const resp = await fetch(`/api/projects/${selectedProject}/units`);
    const data = await resp.json();
    if (data.success && data.units) {
      const existingUnits = Object.values(data.units).flat();
      combinedUnits = Array.from(new Set(existingUnits.concat(allUnits)));
    }
  } catch (e) {
    // use new units only
  }

  try {
    const response = await fetch('/api/projects/add-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: selectedProject, units: { units: combinedUnits } })
    });

    const result = await response.json();

    if (result.success) {
      showSuccessModal('Units added successfully!');
      closeModal();
      await loadUnitsForProject(selectedProject);
      enableAllUnitCheckboxes();
    } else {
      alert('Failed to add units: ' + (result.message || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error adding units:', error);
    alert('Failed to add units. Please try again.');
  }
}

async function onAddProjectChange() {
  const pid = document.getElementById('addProjectSelect').value;
  if (!pid) {
    document.getElementById('unitsDisplay').style.display = 'none';
    document.getElementById('employeesSection').style.display = 'none';
    return;
  }
  selectedProject = pid;
  await loadProjectSGLs(pid);
  await loadCurrentAssignments(pid);
  const resp = await fetch(`/api/projects/${pid}/units`);
  const data = await resp.json();
  displayUnits(data.units);
  populateEmployeesTable();
  document.getElementById('unitsDisplay').style.display = 'block';
  document.getElementById('employeesSection').style.display = 'block';
}

async function onRemoveProjectChange() {
  const projectId = document.getElementById('removeProjectSelect').value;
  if (projectId) {
    await loadUnitsForRemove(projectId);
  } else {
    document.getElementById('removeUnitsDisplay').style.display = 'none';
    document.getElementById('removeMembersSection').style.display = 'none';
  }
}

async function loadProjectSGLs(projectId) {
  try {
    const response = await fetch(`/api/projects/${projectId}/sgls`);
    const data = await response.json();
    if (data.success) {
      projectSGLs = data.sgls || [];
    }
  } catch (error) {
    console.error('Error loading project SGLs:', error);
    projectSGLs = [];
  }
}

async function loadUnitsForProject(projectId) {
  try {
    const response = await fetch(`/api/projects/${projectId}/units`);
    const data = await response.json();

    if (data.success && Object.keys(data.units).length > 0) {
      displayUnits(data.units);
      populateEmployeesTable();
      document.getElementById('unitsDisplay').style.display = 'block';
      document.getElementById('employeesSection').style.display = 'block';
    } else {
      document.getElementById('unitsDisplay').style.display = 'none';
      document.getElementById('employeesSection').style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading units:', error);
  }
}

async function loadUnitsForRemove(projectId) {
  try {
    const response = await fetch(`/api/projects/${projectId}/units`);
    const data = await response.json();

    if (data.success && Object.keys(data.units).length > 0) {
      displayRemoveUnits(data.units);
      document.getElementById('removeUnitsDisplay').style.display = 'block';
    } else {
      document.getElementById('removeUnitsDisplay').style.display = 'none';
      document.getElementById('removeMembersSection').style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading units:', error);
  }
}

function displayUnits(units) {
  const grid = document.getElementById('unitsGrid');
  grid.innerHTML = '';

  const allUnits = Object.values(units).flat();

  const isHOD = currentUser.isHod;
  const allowedUnits = isHOD
    ? allUnits
    : allUnits.filter(u =>
      currentAssignments[u] &&
      Array.isArray(currentAssignments[u][currentUser.id]) &&
      currentAssignments[u][currentUser.id].includes('SGL')
    );

  allUnits.forEach(u => {
    const div = document.createElement('div');
    div.className = 'unit-checkbox';
    div.innerHTML = `
      <input type="checkbox" id="unit-${u}" value="${u}" ${allowedUnits.includes(u) ? '' : 'disabled'} />
      <label for="unit-${u}">${u}</label>
    `;
    grid.appendChild(div);
  });
}

function displayRemoveUnits(units) {
  const grid = document.getElementById('removeUnitsGrid');
  grid.innerHTML = '';

  Object.entries(units).forEach(([, unitNumbers]) => {
    unitNumbers.forEach(unitNumber => {
      const checkbox = document.createElement('div');
      checkbox.className = 'unit-checkbox';
      checkbox.innerHTML = `
        <input type="checkbox" id="remove-unit-${unitNumber}" value="${unitNumber}">
        <label for="remove-unit-${unitNumber}">${unitNumber}</label>
      `;
      grid.appendChild(checkbox);
    });
  });
}

function populateEmployeesTable() {
  const tbody = document.getElementById('employeesTableBody');
  tbody.innerHTML = '';

  employees.forEach(employee => {
    const tr = document.createElement('tr');
    const isCurrentSGL = employee.id === currentUser.id;
    const isAssignedSGL = projectSGLs.includes(employee.id);
    const isDisabled = isCurrentSGL || isAssignedSGL;

    tr.innerHTML = `
      <td>${employee.name}</td>
      <td>${employee.id}</td>
      <td><input type="checkbox" name="role-${employee.id}" value="Modeller" ${isDisabled ? 'checked disabled' : ''}></td>
      <td><input type="checkbox" name="role-${employee.id}" value="Process Checker" ${isDisabled ? 'checked disabled' : ''}></td>
      <td><input type="checkbox" name="role-${employee.id}" value="Material Checker" ${isDisabled ? 'checked disabled' : ''}></td>
      <td><input type="checkbox" name="role-${employee.id}" value="Stress Checker" ${isDisabled ? 'checked disabled' : ''}></td>
      <td><input type="checkbox" name="role-${employee.id}" value="GL" ${isDisabled ? 'checked disabled' : ''}></td>
      <td><input type="checkbox" name="role-${employee.id}" value="SGL" ${isDisabled ? 'checked disabled' : ''}></td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadCurrentAssignments(projectId) {
  try {
    const response = await fetch(`/api/projects/${projectId}/assignments`);
    const data = await response.json();

    if (data.success) {
      currentAssignments = data.assignments;
      updateEmployeeCheckboxes();
    }
  } catch (error) {
    console.error('Error loading assignments:', error);
  }
}

function updateEmployeeCheckboxes() {
  const selectedUnits = Array.from(document.querySelectorAll('#unitsGrid input[type="checkbox"]:checked')).map(cb => cb.value);

  employees.forEach(employee => {
    document.querySelectorAll(`input[name="role-${employee.id}"]`).forEach(checkbox => {
      if (!checkbox.disabled) {
        let shouldCheck = false;
        selectedUnits.forEach(unit => {
          if (currentAssignments[unit] && currentAssignments[unit][employee.id]) {
            if (currentAssignments[unit][employee.id].includes(checkbox.value)) {
              shouldCheck = true;
            }
          }
        });
        checkbox.checked = shouldCheck;
      }
    });
  });
}

async function assignRoles() {
  const pid = document.getElementById('addProjectSelect').value;
  const units = [...document.querySelectorAll('#unitsGrid input:checked')].map(i => i.value);

  const assignments = {};
  const rolesToRemove = {};
  employees.forEach(emp => {
    const cbs = [...document.querySelectorAll(`input[name="role-${emp.id}"]`)];
    const sel = cbs.filter(c => c.checked && !c.disabled).map(c => c.value);
    const un = cbs.filter(c => !c.checked && !c.disabled).map(c => c.value);
    if (sel.length) assignments[emp.id] = sel;
    if (un.length) rolesToRemove[emp.id] = un;
  });

  if (units.length === 0) {
    alert('Please select at least one unit.');
    return;
  }
  if (Object.keys(assignments).length === 0 && Object.keys(rolesToRemove).length === 0) {
    alert('Please select roles to assign or remove.');
    return;
  }

  try {
    if (Object.keys(assignments).length > 0) {
      const assignResp = await fetch('/api/projects/assign-roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: pid, units, assignments }),
      });
      if (!assignResp.ok) throw new Error(await assignResp.text() || 'Failed to assign roles');
    }

    if (Object.keys(rolesToRemove).length > 0) {
      const removeResp = await fetch('/api/projects/remove-roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: pid, units, rolesToRemove }),
      });
      if (!removeResp.ok) throw new Error(await removeResp.text() || 'Failed to remove roles');
    }

    const newSGLs = Object.entries(assignments)
      .filter(([, roles]) => roles.includes('SGL'))
      .map(([empId]) => empId);

    if (newSGLs.length > 0) {
      await fetch('/api/projects/assign-sgls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: pid, sgls: newSGLs }),
      });
    }

    showSuccessModal('Roles assigned successfully!');
    await loadCurrentAssignments(pid);
    await loadProjectSGLs(pid);
    await loadProjects();

  } catch (error) {
    console.error('Error assigning/removing roles:', error);
    alert('Failed to assign roles. Please try again.');
  }
}

async function updateRemoveTable() {
  const projectId = document.getElementById('removeProjectSelect').value;
  const selectedUnits = Array.from(document.querySelectorAll('#removeUnitsGrid input[type="checkbox"]:checked')).map(cb => cb.value);

  if (selectedUnits.length === 0) {
    document.getElementById('removeMembersSection').style.display = 'none';
    return;
  }

  try {
    const response = await fetch(`/api/projects/${projectId}/assignments`);
    const data = await response.json();

    if (data.success) {
      displayRemoveTableMerged(data.assignments, selectedUnits);
      document.getElementById('removeMembersSection').style.display = 'block';
    }
  } catch (error) {
    console.error('Error loading assignments:', error);
  }
}

function displayRemoveTableMerged(assignments, selectedUnits) {
  const tbody = document.getElementById('removeMembersTableBody');
  tbody.innerHTML = '';

  const employeeData = {};

  selectedUnits.forEach(unit => {
    if (assignments[unit]) {
      Object.entries(assignments[unit]).forEach(([employeeId, roles]) => {
        if (!employeeData[employeeId]) {
          const employee = employees.find(emp => emp.id === employeeId);
          employeeData[employeeId] = { name: employee ? employee.name : employeeId, units: {} };
        }
        employeeData[employeeId].units[unit] = roles;
      });
    }
  });

  Object.entries(employeeData).forEach(([employeeId, data]) => {
    const units = Object.keys(data.units);
    const unitCount = units.length;

    units.forEach((unit, index) => {
      const row = document.createElement('tr');
      if (index === 0) {
        row.innerHTML = `
          <td rowspan="${unitCount}" class="merged-cell">${employeeId}</td>
          <td rowspan="${unitCount}" class="merged-cell">${data.name}</td>
          <td>${unit}</td>
          <td class="unit-roles-cell">${data.units[unit].join(', ')}</td>
          <td><input type="checkbox" value="${employeeId}-${unit}"></td>
        `;
      } else {
        row.innerHTML = `
          <td>${unit}</td>
          <td class="unit-roles-cell">${data.units[unit].join(', ')}</td>
          <td><input type="checkbox" value="${employeeId}-${unit}"></td>
        `;
      }
      tbody.appendChild(row);
    });
  });
}

async function removeSelected() {
  const selectedItems = Array.from(document.querySelectorAll('#removeMembersTable input[type="checkbox"]:checked')).map(cb => cb.value);

  if (selectedItems.length === 0) {
    alert('Please select employee-unit combinations to remove.');
    return;
  }

  if (!confirm(`Are you sure you want to remove ${selectedItems.length} assignment(s)?`)) {
    return;
  }

  try {
    const projectId = document.getElementById('removeProjectSelect').value;

    const unitGroups = {};
    selectedItems.forEach(item => {
      const [employeeId, unit] = item.split('-');
      if (!unitGroups[unit]) unitGroups[unit] = [];
      unitGroups[unit].push(employeeId);
    });

    for (const [unit, employeeIds] of Object.entries(unitGroups)) {
      const unitRolesToRemove = {};
      employeeIds.forEach(employeeId => {
        unitRolesToRemove[employeeId] = ['Modeller', 'Process Checker', 'Material Checker', 'Stress Checker', 'GL', 'SGL'];
      });

      const response = await fetch('/api/projects/remove-roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, units: [unit], rolesToRemove: unitRolesToRemove })
      });

      if (!response.ok) throw new Error('Failed to remove roles');
    }

    showSuccessModal('Selected assignments removed successfully!');
    await updateRemoveTable();

  } catch (error) {
    console.error('Error removing assignments:', error);
    alert('Failed to remove assignments. Please try again.');
  }
}
