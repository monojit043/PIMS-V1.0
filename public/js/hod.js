let currentUser = null;
let projects = [];
let employees = [];
let selectedProjectSgls = [];

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
      document.querySelectorAll('.loggedUser').forEach(el => {
        el.textContent = `${currentUser.name} (${currentUser.id})`;
      });
      const roleEls = [document.getElementById('topbarUserRole'), document.getElementById('tuDdRole')];
      roleEls.forEach(el => { if (el) el.textContent = 'Head of Department'; });
    }

    if (!currentUser.isHod) {
      alert('HOD access required.');
      closeWindow();
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const view = urlParams.get('view');

    if (view === 'create') {
      showCreateJobView();
    } else if (view === 'assign') {
      showAssignSglView();
    } else {
      showBothViews();
    }

    await loadProjects();
    await loadEmployees();
    await loadAllJobs();

    setupEventListeners();

  } catch (error) {
    console.error('Initialization error:', error);
    alert('Failed to initialize HOD console.');
  }
});

function showCreateJobView() {
  document.getElementById('create-job-section').classList.remove('hidden');
  document.getElementById('assign-sgl-section').classList.add('hidden');
}

function showAssignSglView() {
  document.getElementById('create-job-section').classList.add('hidden');
  document.getElementById('assign-sgl-section').classList.remove('hidden');
}

function showBothViews() {
  document.getElementById('create-job-section').classList.remove('hidden');
  document.getElementById('assign-sgl-section').classList.remove('hidden');
}

async function loadProjects() {
  try {
    const response = await fetch('/api/projects');
    const data = await response.json();
    if (data.success) {
      projects = data.projects;
      populateProjectDropdown();
    }
  } catch (error) {
    console.error('Error loading projects:', error);
  }
}

async function loadEmployees() {
  try {
    const response = await fetch('/api/users/sgls');
    const data = await response.json();
    if (data.success) {
      employees = data.users;
      populateSglDropdown();
    }
  } catch (error) {
    console.error('Error loading employees:', error);
  }
}

async function loadAllJobs() {
  const loading = document.getElementById('jobs-loading');
  const table = document.getElementById('jobs-table');
  const empty = document.getElementById('jobs-empty');
  const tbody = document.getElementById('jobs-tbody');

  loading.style.display = 'block';
  table.style.display = 'none';
  empty.style.display = 'none';

  try {
    const response = await fetch('/api/projects');
    const data = await response.json();

    loading.style.display = 'none';

    if (!data.success || !data.projects.length) {
      empty.style.display = 'block';
      return;
    }

    tbody.innerHTML = data.projects.map((p, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${p.id}</strong></td>
        <td>${p.name}</td>
      </tr>
    `).join('');

    table.style.display = 'table';
  } catch (err) {
    loading.style.display = 'none';
    empty.style.display = 'block';
    console.error('Error loading jobs:', err);
  }
}

function populateProjectDropdown() {
  const select = document.getElementById('projectSelect');
  select.innerHTML = '<option value="">Select Project</option>';
  projects.forEach(project => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = `${project.id} - ${project.name}`;
    select.appendChild(option);
  });
}

function populateSglDropdown() {
  const select = document.getElementById('sglSelect');
  select.innerHTML = '<option value="">Select SGL</option>';
  employees.forEach(employee => {
    const option = document.createElement('option');
    option.value = employee.id;
    option.textContent = `${employee.id} (${employee.name})`;
    select.appendChild(option);
  });
}

function setupEventListeners() {
  document.getElementById('createJobBtn').addEventListener('click', createJob);
  document.getElementById('assignSglBtn').addEventListener('click', assignSgl);
  document.getElementById('removeSglBtn').addEventListener('click', removeSgls);
  document.getElementById('projectSelect').addEventListener('change', onProjectSelectChange);
}

async function createJob() {
  const projectId = document.getElementById('projectId').value.trim();
  const projectName = document.getElementById('projectName').value.trim();
  const loadingDiv = document.getElementById('create-loading');

  if (!projectId || !projectName) {
    alert('Please fill in all fields.');
    return;
  }

  try {
    loadingDiv.style.display = 'block';

    const response = await fetch('/api/projects/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: projectName })
    });

    const data = await response.json();

    if (data.success) {
      showSuccessModal(`Project "${projectId}" created successfully! HOD automatically assigned as SGL.`);
      document.getElementById('projectId').value = '';
      document.getElementById('projectName').value = '';
      await loadProjects();
      await loadAllJobs();
    } else {
      alert(data.message || 'Failed to create project.');
    }
  } catch (error) {
    console.error('Error creating project:', error);
    alert('Error creating project. Please try again.');
  } finally {
    loadingDiv.style.display = 'none';
  }
}

async function assignSgl() {
  const projectId = document.getElementById('projectSelect').value;
  const sglId = document.getElementById('sglSelect').value;
  const loadingDiv = document.getElementById('assign-loading');

  if (!projectId || !sglId) {
    alert('Please select both project and SGL.');
    return;
  }

  try {
    loadingDiv.style.display = 'block';

    const response = await fetch('/api/projects/assign-sgls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId, sgls: [sglId] })
    });

    const data = await response.json();

    if (data.success) {
      showSuccessModal(data.message);
      document.getElementById('sglSelect').value = '';
      await loadAssignedSgls(projectId);
    } else {
      alert(data.message || 'Failed to assign SGL.');
    }
  } catch (error) {
    console.error('Error assigning SGL:', error);
    alert('Error assigning SGL. Please try again.');
  } finally {
    loadingDiv.style.display = 'none';
  }
}

async function removeSgls() {
  const projectId = document.getElementById('projectSelect').value;

  if (!projectId) {
    alert('Please select a project first.');
    return;
  }

  const selectedSgls = Array.from(document.querySelectorAll('.sgl-checkbox:checked')).map(cb => cb.value);

  if (selectedSgls.length === 0) {
    alert('Please select SGLs to remove.');
    return;
  }

  if (!confirm(`Are you sure you want to remove ${selectedSgls.length} SGL(s) from this project?`)) {
    return;
  }

  try {
    const response = await fetch('/api/projects/remove-sgls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId, sgls: selectedSgls })
    });

    const data = await response.json();

    if (data.success) {
      showSuccessModal(data.message);
      await loadAssignedSgls(projectId);
    } else {
      alert(data.message || 'Failed to remove SGLs.');
    }
  } catch (error) {
    console.error('Error removing SGLs:', error);
    alert('Error removing SGLs. Please try again.');
  }
}

async function onProjectSelectChange() {
  const projectId = document.getElementById('projectSelect').value;

  if (projectId) {
    await loadAssignedSgls(projectId);
  } else {
    document.getElementById('sglsList').innerHTML =
      '<p style="text-align:center;color:#666;padding:20px;">Select a project to view assigned SGLs</p>';
  }
}

async function loadAssignedSgls(projectId) {
  try {
    const response = await fetch(`/api/projects/${projectId}/sgls`);
    const data = await response.json();

    if (data.success) {
      selectedProjectSgls = data.sgls || [];
      displayAssignedSgls();
    }
  } catch (error) {
    console.error('Error loading assigned SGLs:', error);
  }
}

function displayAssignedSgls() {
  const sglsList = document.getElementById('sglsList');

  if (selectedProjectSgls.length === 0) {
    sglsList.innerHTML = '<p style="text-align:center;color:#666;padding:20px;">No SGLs assigned to this project</p>';
    return;
  }

  sglsList.innerHTML = selectedProjectSgls.map(sglId => {
    const employee = employees.find(emp => emp.id === sglId);
    if (!employee) return '';
    return `
      <div class="sgl-item">
        <input type="checkbox" class="sgl-checkbox" value="${sglId}">
        <span><strong>${employee.id}</strong> - ${employee.name}</span>
      </div>
    `;
  }).join('');
}
