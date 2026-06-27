/**
 * Upload ISO Module
 *
 * Line No format:  {FLUID_CODE}-{UNIT_NO}-{SEQ_NO}[-{SUBLINE_NO}]-{ZONE}
 *   e.g.  P-111-12345-C  /  WCS-86-HSC001-A  /  TRM-111-VV1227-01-A
 *
 * Regex:  /([A-Za-z]+)-(\d+)-([A-Za-z0-9]{1,7})(?:-(\d{1,4}))?-([A-Za-z]+)/
 *   group 1 = Fluid Code   (letters, e.g. P / WCS / TRM)
 *   group 2 = Unit No      (digits)
 *   group 3 = Sequence No  (alphanumeric, 1–7 chars, e.g. 12345 / HSC001 / VV1227)
 *   group 4 = Subline No   (optional, 1–3 digits, e.g. 01)
 *   group 5 = Zone         (letters)
 *
 * NOTE: project + fileInfo must be appended to FormData BEFORE the file
 * so multer's destination callback can read req.body when it fires.
 */

document.addEventListener('DOMContentLoaded', function () {

  /* ── DOM refs ── */
  const modal           = document.getElementById('uploadModal');
  const openBtn         = document.getElementById('uploadIsoBtn');
  const closeBtn        = document.getElementById('closeUpload');
  const backdrop        = document.getElementById('uploadBackdrop');
  const projectSel      = document.getElementById('project-select');
  const dropArea        = document.getElementById('file-drop-area');
  const fileInput       = document.getElementById('file-input');
  const filesList       = document.getElementById('files-list');
  const fileCount       = document.getElementById('file-count');
  const statusEl        = document.getElementById('upload-speed');
  const uploadBtn       = document.getElementById('upload-btn');
  const progressSection = document.getElementById('uplProgressSection');
  const uplFileLabel    = document.getElementById('uplFileLabel');
  const uplFileFill     = document.getElementById('uplFileFill');
  const uplFilePct      = document.getElementById('uplFilePct');
  const uplOverallFill  = document.getElementById('uplOverallFill');
  const uplOverallPct   = document.getElementById('uplOverallPct');

  if (!openBtn) return;

  /* ── State ── */
  let parsedFiles   = [];  // [{ file, lineNo, unit, zone, valid, error }]
  let modellerUnits = [];  // units where current user has Modeller role

  /* ── LINE NO REGEX ── */
  const LINE_PATTERN = /([A-Za-z]+)-(\d+)-([A-Za-z0-9]{1,7})(?:-([A-Za-z0-9]{1,3}))?-([A-Za-z]{1,2})$/;

  // Strip OS-generated duplicate-file decoration ("- Copy", "- Copy - Copy",
  // "- Copy (2)", "(1)", "copy") so re-saved/duplicated PDFs still parse —
  // the LINE_PATTERN end-anchor requires the zone to be the last token.
  function stripCopySuffix(base) {
    return base
      .replace(/(\s*[-_]?\s*copy\s*(\(\d+\))?)+$/gi, '')
      .replace(/\s*\(\d+\)\s*$/, '')
      .trim();
  }

  function parseFilename(filename) {
    const base  = stripCopySuffix(filename.replace(/\.pdf$/i, ''));
    const match = base.match(LINE_PATTERN);
    if (!match) {
      return {
        valid: false,
        error: 'No line no pattern found. Expected: {FLUID}-{UNIT}-{SEQ}-{ZONE} or {FLUID}-{UNIT}-{SEQ}-{SUBLINE}-{ZONE} (e.g. P-111-12345-C / TRM-111-VV1227-01-A). Seq No: 1–7 alphanumeric chars.'
      };
    }
    return {
      valid:        true,
      lineNo:       match[0],               // e.g. "P-111-12345-C" or "TRM-111-VV1227-01-A"
      fluidCode:    match[1],               // e.g. "P" / "TRM"
      unit:         match[2],               // e.g. "111"
      seqNo:        match[3],               // e.g. "12345" / "VV1227"
      sublineNo:    match[4] || null,        // e.g. "01" or null
      zone:         match[5].toUpperCase(), // e.g. "C" / "A"
      newFilename:  `${match[0]}_R0-1.pdf`,
      originalName: filename,
    };
  }

  /* ── Open modal ── */
  openBtn.addEventListener('click', async () => {
    resetModal();
    modal.classList.add('active');
    await loadModellerProjects();
  });

  closeBtn?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', closeModal);

  function closeModal() {
    modal.classList.remove('active');
    resetModal();
  }

  function resetModal() {
    parsedFiles   = [];
    modellerUnits = [];
    fileInput.value = '';
    filesList.innerHTML = '';
    fileCount.textContent = '0';
    statusEl.textContent  = '—';
    uploadBtn.disabled = true;
    projectSel.innerHTML = '<option value="">— Select Job No —</option>';
    progressSection.classList.remove('visible');
    uplFileFill.className  = 'upl-bar-fill';
    uplFileFill.style.width = '0%';
    uplFilePct.textContent  = '0%';
    uplOverallFill.className = 'upl-bar-fill';
    uplOverallFill.style.width = '0%';
    uplOverallPct.textContent  = '0 / 0';
  }

  /* ── Progress helpers ── */
  function setFileProgress(pct, state = 'uploading') {
    uplFileFill.className  = 'upl-bar-fill ' + state;
    uplFileFill.style.width = pct + '%';
    uplFilePct.textContent  = pct + '%';
  }

  function setOverallProgress(done, total) {
    const pct = total ? Math.round(done / total * 100) : 0;
    uplOverallFill.style.width = pct + '%';
    uplOverallPct.textContent  = done + ' / ' + total;
    uplOverallFill.className   = 'upl-bar-fill' + (done === total && total > 0 ? ' done' : '');
  }

  /* ── XHR uploader with progress callback ── */
  function uploadFileXHR(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
      });
      xhr.addEventListener('load', () => {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid server response')); }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.open('POST', '/api/upload-isometric');
      xhr.send(fd);
    });
  }

  /* ── Load projects where logged-in user has Modeller role ── */
  async function loadModellerProjects() {
    try {
      const res  = await fetch('/api/projects/modeller-projects');
      const data = await res.json();
      if (!data.success || !data.projects.length) {
        projectSel.innerHTML = '<option value="">No projects assigned as Modeller</option>';
        return;
      }
      projectSel.innerHTML = '<option value="">— Select Job No —</option>';
      data.projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value       = p.id;
        opt.textContent = `${p.id}  —  ${p.name}`;
        projectSel.appendChild(opt);
      });
    } catch {
      projectSel.innerHTML = '<option value="">Failed to load projects</option>';
    }
  }

  /* ── On project change: load units where user has Modeller role ── */
  projectSel.addEventListener('change', async () => {
    modellerUnits = [];
    parsedFiles   = [];
    filesList.innerHTML   = '';
    fileCount.textContent = '0';
    statusEl.textContent  = '—';
    uploadBtn.disabled    = true;

    const pid = projectSel.value;
    if (!pid) return;

    try {
      const res  = await fetch(`/api/projects/${pid}/modeller-units`);
      const data = await res.json();
      if (data.success) modellerUnits = data.units;
    } catch { /* leave empty */ }

    if (fileInput.files.length) processFiles(fileInput.files);
  });

  /* ── File drop & browse ── */
  dropArea.addEventListener('click', () => fileInput.click());

  dropArea.addEventListener('dragover', e => {
    e.preventDefault();
    dropArea.classList.add('dz-over');
  });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dz-over'));
  dropArea.addEventListener('drop', e => {
    e.preventDefault();
    dropArea.classList.remove('dz-over');
    processFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => processFiles(fileInput.files));

  /* ── Parse + validate every file ── */
  function processFiles(fileList) {
    if (!projectSel.value) {
      alert('Please select a Job No first.');
      fileInput.value = '';
      return;
    }

    parsedFiles = Array.from(fileList).map(file => {
      if (!/\.pdf$/i.test(file.name)) {
        return { file, valid: false, error: 'Only PDF files are allowed' };
      }

      const parsed = parseFilename(file.name);
      if (!parsed.valid) return { file, ...parsed };

      if (modellerUnits.length && !modellerUnits.includes(parsed.unit)) {
        return {
          file, ...parsed, valid: false,
          error: `Unit "${parsed.unit}" not assigned to you as Modeller in this project`
        };
      }

      return { file, ...parsed };
    });

    renderFileList();
    fileCount.textContent = parsedFiles.length;

    const anyValid = parsedFiles.some(f => f.valid);
    uploadBtn.disabled   = !anyValid;
    statusEl.textContent = anyValid ? 'Ready' : 'No uploadable files';
  }

  /* ── Render file list ── */
  function renderFileList() {
    filesList.innerHTML = parsedFiles.map(f => `
      <div class="file-item ${f.valid ? '' : 'file-item--error'}">
        <div class="fi-name">${f.file.name}</div>
        ${f.valid
          ? `<div class="fi-meta">
               Fluid: <strong>${f.fluidCode}</strong> &nbsp;|&nbsp;
               Unit: <strong>${f.unit}</strong> &nbsp;|&nbsp;
               Seq: <strong>${f.seqNo}</strong> &nbsp;|&nbsp;
               ${f.sublineNo ? `Subline: <strong>${f.sublineNo}</strong> &nbsp;|&nbsp;` : ''}
               Zone: <strong>${f.zone}</strong> &nbsp;|&nbsp;
               Line No: <strong>${f.lineNo}</strong>
             </div>`
          : `<div class="fi-error">${f.error}</div>`
        }
      </div>
    `).join('');
  }

  /* ── Upload all valid files, then export Excel report ── */
  uploadBtn.addEventListener('click', async () => {
    const jobNo = projectSel.value;
    if (!jobNo || !parsedFiles.length) return;

    const validFiles = parsedFiles.filter(pf => pf.valid);
    const totalValid = validFiles.length;

    uploadBtn.disabled   = true;
    statusEl.textContent = 'Uploading…';

    // Show progress section
    progressSection.classList.add('visible');
    setOverallProgress(0, totalValid);

    const report = [];
    let doneCount = 0;

    for (const pf of parsedFiles) {
      if (!pf.valid) {
        report.push({
          'S.No':          report.length + 1,
          'Original File': pf.file.name,
          'Line No':       pf.lineNo    || '—',
          'Fluid Code':    pf.fluidCode || '—',
          'Unit No':       pf.unit      || '—',
          'Zone':          pf.zone      || '—',
          'Job No':        jobNo,
          'Status':        'Skipped',
          'Reason':        pf.error || 'Invalid file',
        });
        continue;
      }

      // Show current file in label
      uplFileLabel.textContent = `Uploading ${doneCount + 1} of ${totalValid}: ${pf.file.name}`;
      setFileProgress(0, 'uploading');

      try {
        const fd = new FormData();
        // IMPORTANT: project + fileInfo must come BEFORE file so multer
        // destination callback can read req.body when it fires.
        fd.append('project', jobNo);
        fd.append('fileInfo', JSON.stringify({
          unit:         pf.unit,
          zone:         pf.zone,
          lineNo:       pf.lineNo,
          newFilename:  pf.newFilename,
          originalName: pf.originalName,
          valid:        true,
        }));
        fd.append('file', pf.file);

        const data = await uploadFileXHR(fd, pct => setFileProgress(pct, 'uploading'));

        setFileProgress(100, data.ok ? 'done' : 'failed');
        doneCount++;
        setOverallProgress(doneCount, totalValid);

        report.push({
          'S.No':          report.length + 1,
          'Original File': pf.file.name,
          'Line No':       pf.lineNo,
          'Fluid Code':    pf.fluidCode,
          'Unit No':       pf.unit,
          'Zone':          pf.zone,
          'Job No':        jobNo,
          'Status':        data.ok ? 'Uploaded' : 'Failed',
          'Reason':        data.ok ? (data.message || 'Success') : (data.error || 'Unknown error'),
        });
      } catch (err) {
        setFileProgress(100, 'failed');
        doneCount++;
        setOverallProgress(doneCount, totalValid);

        report.push({
          'S.No':          report.length + 1,
          'Original File': pf.file.name,
          'Line No':       pf.lineNo,
          'Fluid Code':    pf.fluidCode,
          'Unit No':       pf.unit,
          'Zone':          pf.zone,
          'Job No':        jobNo,
          'Status':        'Failed',
          'Reason':        err.message || 'Network error',
        });
      }
    }

    const uploaded = report.filter(r => r.Status === 'Uploaded').length;
    const failed   = report.filter(r => r.Status === 'Failed').length;
    const skipped  = report.filter(r => r.Status === 'Skipped').length;

    uplFileLabel.textContent = `Done — ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`;
    statusEl.textContent     = `${uploaded} uploaded, ${skipped} skipped, ${failed} failed`;

    exportExcel(report, jobNo);

    if (typeof loadProjectTree === 'function') loadProjectTree();

    if (!failed) {
      setTimeout(closeModal, 2500);
    } else {
      uploadBtn.disabled = false;
    }
  });

  /* ── Generate & download Excel report ── */
  function exportExcel(rows, jobNo) {
    if (!window.XLSX) {
      console.warn('SheetJS not loaded — skipping Excel export');
      return;
    }

    const ws = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      { wch: 6 },   // S.No
      { wch: 40 },  // Original File
      { wch: 20 },  // Line No
      { wch: 12 },  // Fluid Code
      { wch: 10 },  // Unit No
      { wch: 8 },   // Zone
      { wch: 14 },  // Job No
      { wch: 12 },  // Status
      { wch: 50 },  // Reason
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');

    const ts   = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const name = `Upload_Report_${jobNo}_${ts}.xlsx`;
    XLSX.writeFile(wb, name);
  }

});
