'use strict';
// ── GAD Upload Modal — multi-file, auto-parse GAD No from filename ──────────

const GAD_PATTERN = /([A-Z]\d+)-(\d+)-(\d{2}-\d{2})-(\d{5})/;
let _gadFileQueue = [];

function openGADUploadModal() {
  _gadFileQueue = [];
  document.getElementById('gadFileInput').value  = '';
  document.getElementById('gadUploadStatus').textContent = '';
  document.getElementById('gadUploadStatus').style.color = '';
  document.getElementById('gadQueueBody').innerHTML      = '';
  document.getElementById('gadFileQueue').style.display  = 'none';
  document.getElementById('gadUploadSubmitBtn').disabled = true;
  document.getElementById('gadUploadModal').classList.add('open');
}

function closeGADUploadModal() {
  document.getElementById('gadUploadModal').classList.remove('open');
  _gadFileQueue = [];
}

function gadHandleFiles(fileList) {
  const files = [...fileList];
  files.forEach(file => {
    // Skip exact duplicates already in queue
    if (_gadFileQueue.some(q => q.file.name === file.name && q.file.size === file.size)) return;

    if (!/\.pdf$/i.test(file.name)) {
      _gadFileQueue.push({ file, parsed: null, status: 'invalid', message: 'Not a PDF file' });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      _gadFileQueue.push({ file, parsed: null, status: 'invalid', message: 'Exceeds 50 MB limit' });
      return;
    }

    const namePart = file.name.replace(/\.pdf$/i, '');
    const m = namePart.toUpperCase().match(GAD_PATTERN);
    if (!m) {
      _gadFileQueue.push({ file, parsed: null, status: 'invalid', message: 'GAD No. not found in filename' });
      return;
    }

    const [, jobNo, unitNo, gadTypeSeq, serialNo] = m;
    const gadNo   = `${jobNo}-${unitNo}-${gadTypeSeq}-${serialNo}`;
    const areaNno = String(parseInt(serialNo.substring(0, 3), 10));
    _gadFileQueue.push({
      file,
      parsed: { valid: true, jobNo, unitNo, gadTypeSeq, serialNo, areaNno, gadNo },
      status: 'ready',
      message: '',
    });
  });

  renderGADQueue();
}

function renderGADQueue() {
  const tbody    = document.getElementById('gadQueueBody');
  const queueDiv = document.getElementById('gadFileQueue');

  if (!_gadFileQueue.length) {
    queueDiv.style.display = 'none';
    document.getElementById('gadUploadSubmitBtn').disabled = true;
    return;
  }

  queueDiv.style.display = 'block';

  tbody.innerHTML = _gadFileQueue.map((item, i) => {
    let statusHtml = '';
    let gadCell    = '<span style="color:#94a3b8;">—</span>';
    let areaCell   = '—';

    if (item.status === 'ready') {
      statusHtml = `<span style="color:#16a34a;font-weight:600;">Ready</span>`;
      gadCell    = `<span style="font-family:monospace;font-weight:600;">${item.parsed.gadNo}</span>`;
      areaCell   = item.parsed.areaNno;
    } else if (item.status === 'invalid') {
      statusHtml = `<span style="color:#dc2626;">${item.message}</span>`;
    } else if (item.status === 'uploading') {
      statusHtml = `<span style="color:#2563eb;">Uploading…</span>`;
      gadCell    = `<span style="font-family:monospace;">${item.parsed?.gadNo || '—'}</span>`;
      areaCell   = item.parsed?.areaNno || '—';
    } else if (item.status === 'done') {
      statusHtml = `<span style="color:#16a34a;font-weight:600;">✓ ${item.message || 'Uploaded'}</span>`;
      gadCell    = `<span style="font-family:monospace;">${item.parsed?.gadNo || '—'}</span>`;
      areaCell   = item.parsed?.areaNno || '—';
    } else if (item.status === 'error') {
      statusHtml = `<span style="color:#dc2626;">✗ ${item.message}</span>`;
      gadCell    = item.parsed ? `<span style="font-family:monospace;">${item.parsed.gadNo}</span>` : '<span style="color:#94a3b8;">—</span>';
      areaCell   = item.parsed?.areaNno || '—';
    }

    const canRemove = item.status === 'ready' || item.status === 'invalid' || item.status === 'error';
    const removeBtn = canRemove
      ? `<button onclick="gadRemoveQueueItem(${i})" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:15px;padding:2px 4px;line-height:1;" title="Remove">✕</button>`
      : '';

    const shortName = item.file.name.length > 42
      ? '…' + item.file.name.slice(-40)
      : item.file.name;

    return `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:6px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#334155;" title="${item.file.name}">${shortName}</td>
      <td style="padding:6px 8px;">${gadCell}</td>
      <td style="padding:6px 8px;text-align:center;color:#475569;">${areaCell}</td>
      <td style="padding:6px 8px;">${statusHtml}</td>
      <td style="padding:4px 4px;text-align:center;">${removeBtn}</td>
    </tr>`;
  }).join('');

  const hasReady = _gadFileQueue.some(q => q.status === 'ready');
  document.getElementById('gadUploadSubmitBtn').disabled = !hasReady;
}

function gadRemoveQueueItem(idx) {
  _gadFileQueue.splice(idx, 1);
  renderGADQueue();
}

async function submitGADUpload() {
  const btn      = document.getElementById('gadUploadSubmitBtn');
  const statusEl = document.getElementById('gadUploadStatus');
  btn.disabled   = true;

  const toUpload = _gadFileQueue.filter(q => q.status === 'ready');
  if (!toUpload.length) return;

  let successCount = 0;
  let errorCount   = 0;
  statusEl.style.color = '#2563eb';
  statusEl.textContent = `Uploading ${toUpload.length} file${toUpload.length > 1 ? 's' : ''}…`;

  for (const item of toUpload) {
    item.status = 'uploading';
    renderGADQueue();

    try {
      const fd = new FormData();
      fd.append('fileInfo', JSON.stringify(item.parsed));
      fd.append('file', item.file, item.file.name);

      const res  = await fetch('/api/gad/upload', { method: 'POST', body: fd });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        item.status  = 'error';
        item.message = data.error || 'Upload failed';
        errorCount++;
      } else {
        item.status  = 'done';
        item.message = data.message || 'Uploaded';
        successCount++;
      }
    } catch(e) {
      item.status  = 'error';
      item.message = 'Network error';
      errorCount++;
    }

    renderGADQueue();
  }

  if (successCount) {
    statusEl.style.color = '#16a34a';
    statusEl.textContent = `✓ ${successCount} file${successCount > 1 ? 's' : ''} uploaded successfully` +
      (errorCount ? ` · ${errorCount} failed` : '');
    const firstDone = toUpload.find(q => q.status === 'done');
    if (firstDone) {
      gadSelectedJob  = firstDone.parsed.jobNo;
      gadSelectedUnit = firstDone.parsed.unitNo;
      gadSelectedArea = firstDone.parsed.areaNno;
    }
    refreshGADTree();
    if (!errorCount) setTimeout(() => closeGADUploadModal(), 1800);
  } else {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = `All ${errorCount} upload${errorCount > 1 ? 's' : ''} failed`;
  }

  const stillReady = _gadFileQueue.some(q => q.status === 'ready');
  if (stillReady) btn.disabled = false;
}
