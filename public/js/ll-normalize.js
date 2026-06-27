// ═══════════════════════════════════════════════════════════════
// PIMS · Line List Normalizer — ll-normalize.js
// Full bulk converter (XLSX + PDF) + Save to PIMS
// ═══════════════════════════════════════════════════════════════

if (typeof pdfjsLib !== 'undefined')
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ─────────────────────────────────────────────────────
var fileQueue    = [];
var masterRows   = [];
var masterErrors = [];
var batchRunning = false;
var batchStart   = 0;

var OUTCOLS = [
  'PID_NO','SERVICE','UNIT_NO','LINE_NO','LINE_SIZE','LINE_SIZE_UNIT',
  'LINE_CLASS','LINE_FROM','LINE_TO',
  'MIN_DESIGN_PRESS','MIN_DESIGN_PRESS_UNIT',
  'MIN_DESIGN_TEMP','MIN_DESIGN_TEMP_UNIT',
  'MIN_OPERATING_PRESS','MIN_OPERATING_PRESS_UNIT',
  'MIN_OPERATING_TEMP','MIN_OPERATING_TEMP_UNIT',
  'OPERATING_TEMP','OPERATING_TEMP_UNIT',
  'OPERATING_PRESS','OPERATING_PRESS_UNIT',
  'DESIGN_TEMP','DESIGN_TEMP_UNIT',
  'DESIGN_PRESS','DESIGN_PRESS_UNIT',
  'INSULATION','FULL_VACCUM','FLUID_STATE',
  'MULTI PHASE (FLOW REGIME)','INSULATION THICKNESS'
];
var ERR_COLS = ['FILE_NAME','SHEET_NAME','ROW_INDEX','LINE_NUMBER','ERROR_TYPE','ERROR_DESCRIPTION'];

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  initDropzone();
  loadProjects();

  document.getElementById('concSlider').addEventListener('input', function () {
    document.getElementById('concLabel').textContent = this.value;
  });

  document.getElementById('jobSelect').addEventListener('change', function () {
    if (this.value) checkRev(this.value);
  });
});

// ── Helpers ───────────────────────────────────────────────────
var _BAD = { '#N/A':1,'N/A':1,'#REF!':1,'#VALUE!':1,'#NAME?':1,'#DIV/0!':1,'NONE':1 };
function safeStr(v) {
  try {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return '';
    var s = String(v).trim();
    return (s === '' || _BAD[s.toUpperCase()]) ? '' : s;
  } catch (e) { return ''; }
}
function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

var _renderTimer = null;
function scheduleRender() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(function () { _renderTimer = null; renderPanel(); }, 300);
}

function $ (id) { return document.getElementById(id); }

function showToast(msg, type) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(t._tmr);
  t._tmr = setTimeout(function () { t.classList.remove('show'); }, 3500);
}

// ── Dropzone ──────────────────────────────────────────────────
function initDropzone() {
  var dz = $('dropZone');
  var fi = $('fileInput');
  dz.addEventListener('dragover',  function (e) { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', function ()  { dz.classList.remove('over'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault(); dz.classList.remove('over');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  dz.addEventListener('click', function () { fi.click(); });
  fi.addEventListener('change', function (e) {
    if (e.target.files.length) addFiles(e.target.files);
    e.target.value = '';
  });
}

function addFiles(files) {
  Array.from(files).forEach(function (file, i) {
    fileQueue.push({ id: Date.now() + i, file: file, name: file.name,
                     status: 'pending', rowCount: 0, error: null, fmt: '' });
  });
  $('processingCard').style.display = '';
  updateBcTag();
  renderPanel();
}

function updateBcTag() {
  $('bcTag').innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;stroke:#007bff;">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/></svg> ' +
    fileQueue.length + ' file' + (fileQueue.length !== 1 ? 's' : '') + ' queued';
}

function clearAll() {
  if (batchRunning) return;
  fileQueue = []; masterRows = []; masterErrors = [];
  $('processingCard').style.display = 'none';
  $('saveCard').style.display        = 'none';
  $('successCard').style.display     = 'none';
  $('btnExport').style.display       = 'none';
  $('bcTag').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> No files loaded';
  renderPanel();
}

function resetAll() {
  clearAll();
  $('processingCard').style.display = 'none';
}

// ── Panel renderer ────────────────────────────────────────────
function renderPanel() {
  var total   = fileQueue.length;
  var done    = fileQueue.filter(function (f) { return f.status === 'done'; }).length;
  var failed  = fileQueue.filter(function (f) { return f.status === 'error'; }).length;
  var running = fileQueue.filter(function (f) { return f.status === 'running'; }).length;

  $('sv-total').textContent = total;
  $('sv-done').textContent  = done;
  $('sv-fail').textContent  = failed;
  $('sv-rows').textContent  = masterRows.length.toLocaleString();
  $('sv-warn').textContent  = masterErrors.length;

  var pct = total ? Math.round((done + failed) / total * 100) : 0;
  $('progressBar').style.width = pct + '%';

  var dot = $('statusDot'), lbl = $('statusLabel');
  if (batchRunning) {
    dot.className = 'norm-dot norm-dot--running';
    lbl.textContent = 'Processing ' + running + ' file' + (running !== 1 ? 's' : '') + ' in parallel…';
    if (done + failed > 0 && batchStart > 0) {
      var elapsed = (Date.now() - batchStart) / 1000;
      var rate    = (done + failed) / elapsed;
      var rem     = Math.ceil((total - done - failed) / (rate || 1));
      $('etaLabel').textContent = '~' + rem + 's remaining';
    }
  } else if (done + failed === total && total > 0) {
    dot.className = 'norm-dot norm-dot--done';
    lbl.textContent = 'Complete — ' + done + ' succeeded, ' + failed + ' failed';
    $('etaLabel').textContent = '';
  } else {
    dot.className = 'norm-dot norm-dot--idle';
    lbl.textContent = total + ' file' + (total !== 1 ? 's' : '') + ' queued';
    $('etaLabel').textContent = '';
  }

  // Virtual file list
  var active  = fileQueue.filter(function (f) { return f.status === 'running'; });
  var recent  = fileQueue.filter(function (f) { return f.status === 'done' || f.status === 'error'; });
  var visible = active.concat(recent.slice(-8));
  var html = '';
  visible.forEach(function (f) {
    var icon = f.name.match(/\.pdf$/i) ? '📄' : '📗';
    var sc, st;
    if      (f.status === 'running') { sc = 'nvs-running'; st = '⏳ Running'; }
    else if (f.status === 'done')    { sc = 'nvs-ok';      st = '✓ ' + f.rowCount + ' rows'; }
    else if (f.status === 'error')   { sc = 'nvs-err';     st = '✗ ' + f.error.substring(0, 35); }
    else                             { sc = 'nvs-pending';  st = 'Pending'; }
    var fmtBadge = '';
    if      (f.fmt === 'DIRECT_MAPPING') fmtBadge = "<span class='nfb nfb-dm'>DM</span>";
    else if (f.fmt === 'LINE_SCHEDULE')  fmtBadge = "<span class='nfb nfb-ls'>LS</span>";
    else if (f.fmt === 'LINE_INDEX')     fmtBadge = "<span class='nfb nfb-li'>LI</span>";
    else if (f.fmt === 'PDF')            fmtBadge = "<span class='nfb nfb-pdf'>PDF</span>";
    html += "<div class='norm-vlist-row'>" +
      "<div class='norm-vlist-icon'>" + icon + "</div>" +
      "<div class='norm-vlist-name' title='" + escHtml(f.name) + "'>" + escHtml(f.name) + "</div>" +
      fmtBadge + "<span class='norm-vlist-status " + sc + "'>" + st + "</span></div>";
  });
  var pending = fileQueue.filter(function (f) { return f.status === 'pending'; }).length;
  if (pending > 0) html += "<div class='norm-vlist-summary'>" + pending + " more file" + (pending !== 1 ? 's' : '') + " pending…</div>";
  $('vlist').innerHTML = html;

  // Format breakdown
  var fmts = { DIRECT_MAPPING:0, LINE_SCHEDULE:0, LINE_INDEX:0, PDF:0 };
  fileQueue.forEach(function (f) { if (fmts[f.fmt] !== undefined) fmts[f.fmt]++; });
  var fhtml = '';
  if (fmts.DIRECT_MAPPING) fhtml += "<span class='nfb nfb-dm'>"  + fmts.DIRECT_MAPPING + " Direct Mapping</span>";
  if (fmts.LINE_SCHEDULE)  fhtml += "<span class='nfb nfb-ls'>"  + fmts.LINE_SCHEDULE  + " Line Schedule</span>";
  if (fmts.LINE_INDEX)     fhtml += "<span class='nfb nfb-li'>"  + fmts.LINE_INDEX     + " Line Index</span>";
  if (fmts.PDF)            fhtml += "<span class='nfb nfb-pdf'>" + fmts.PDF            + " PDF</span>";
  $('fmtRow').innerHTML = fhtml;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Concurrent pool processor ─────────────────────────────────
async function startBulkProcess() {
  if (batchRunning || !fileQueue.length) return;
  batchRunning = true;
  masterRows = []; masterErrors = [];
  batchStart = Date.now();
  fileQueue.forEach(function (f) { f.status = 'pending'; f.rowCount = 0; f.error = null; f.fmt = ''; });
  $('btnProcess').disabled = true;
  $('btnExport').style.display = 'none';
  $('saveCard').style.display  = 'none';
  renderPanel();

  var CONCURRENCY = parseInt($('concSlider').value, 10) || 4;
  var idx = 0, active = 0;

  await new Promise(function (resolve) {
    function tryDispatch() {
      while (active < CONCURRENCY && idx < fileQueue.length) {
        (function (fi) {
          active++;
          fi.status = 'running';
          scheduleRender();
          processOneFile(fi).then(function (rows) {
            for (var i = 0; i < rows.length; i++) masterRows.push(rows[i]);
            fi.status = 'done'; fi.rowCount = rows.length;
          }).catch(function (err) {
            fi.status = 'error';
            fi.error  = String((err && err.message) || err || 'Unknown error').substring(0, 120);
            masterErrors.push({ FILE_NAME:fi.name, SHEET_NAME:'', ROW_INDEX:'', LINE_NUMBER:'',
                                 ERROR_TYPE:'FILE_ERROR', ERROR_DESCRIPTION:fi.error });
          }).finally(function () {
            active--;
            scheduleRender();
            if (idx < fileQueue.length) tryDispatch();
            else if (active === 0) resolve();
          });
        })(fileQueue[idx++]);
      }
    }
    tryDispatch();
    if (active === 0) resolve();
  });

  batchRunning = false;
  renderPanel();
  $('btnProcess').disabled = false;

  if (masterRows.length > 0) {
    $('btnExport').style.display = '';
    showSaveCard();
  }
}

function showSaveCard() {
  var units = new Set(masterRows.map(function (r) { return r['UNIT_NO'] || ''; }).filter(Boolean));
  $('previewRows').textContent  = masterRows.length.toLocaleString();
  $('previewUnits').textContent = units.size;
  $('previewFiles').textContent = fileQueue.filter(function (f) { return f.status === 'done'; }).length;
  $('previewErrors').textContent = masterErrors.length;
  $('saveCard').style.display = '';
  $('saveCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Process one file ──────────────────────────────────────────
function processOneFile(fileItem) {
  return new Promise(function (resolve, reject) {
    var file = fileItem.file;
    var ext  = file.name.split('.').pop().toLowerCase();
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('FileReader failed: ' + file.name)); };
    if (ext === 'pdf') {
      reader.onload = function (e) { handlePDF(e.target.result, file, fileItem).then(resolve).catch(reject); };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = function (e) { handleExcel(e.target.result, file, fileItem).then(resolve).catch(reject); };
      reader.readAsArrayBuffer(file);
    }
  });
}

function logError(fileName, sheetName, rowIndex, lineNumber, errorType, errorDescription) {
  masterErrors.push({
    FILE_NAME: safeStr(fileName)||'', SHEET_NAME: safeStr(sheetName)||'',
    ROW_INDEX: rowIndex != null ? rowIndex : '', LINE_NUMBER: safeStr(lineNumber)||'',
    ERROR_TYPE: safeStr(errorType)||'', ERROR_DESCRIPTION: safeStr(errorDescription)||''
  });
}

// ── Export (download only) ────────────────────────────────────
function exportMaster() {
  if (!masterRows.length && !masterErrors.length) { alert('No data to export.'); return; }
  var owb = XLSX.utils.book_new();
  if (masterRows.length) {
    var ws = XLSX.utils.json_to_sheet(masterRows, { header: OUTCOLS });
    ws['!cols'] = OUTCOLS.map(function (c) { return { wch: Math.max(c.length * 1.2, 14) }; });
    XLSX.utils.book_append_sheet(owb, ws, 'LINELIST');
  }
  var errData = masterErrors.length ? masterErrors
    : [{ FILE_NAME:'(no errors)', SHEET_NAME:'', ROW_INDEX:'', LINE_NUMBER:'', ERROR_TYPE:'', ERROR_DESCRIPTION:'' }];
  var errWs = XLSX.utils.json_to_sheet(errData, { header: ERR_COLS });
  errWs['!cols'] = ERR_COLS.map(function (c) { return { wch: Math.max(c.length * 1.5, 20) }; });
  XLSX.utils.book_append_sheet(owb, errWs, 'Processing_Errors');
  var ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  XLSX.writeFile(owb, 'PDH_MASTER_LINELIST_' + ts + '.xlsx');
}

// ── Load projects for job selector ────────────────────────────
async function loadProjects() {
  try {
    var res = await fetch('/api/projects');
    if (!res.ok) return;
    var data = await res.json();
    var projects = Array.isArray(data) ? data : (data.projects || []);
    var sel = $('jobSelect');
    projects.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id || p.project_id || p.job_no;
      opt.textContent = (p.id || p.project_id || '') + (p.name ? ' — ' + p.name : '');
      sel.appendChild(opt);
    });
  } catch (e) { /* silently fail — user can still type */ }
}

// ── Check revision ────────────────────────────────────────────
async function checkRev(jobNo) {
  var hint = $('revHint');
  hint.style.display = 'none';
  try {
    var res = await fetch('/api/linelist/check-rev/' + encodeURIComponent(jobNo));
    if (!res.ok) return;
    var data = await res.json();
    if (data.exists) {
      $('revInput').value = data.nextRev;
      hint.style.display = 'flex';
      hint.className = 'norm-rev-hint';
      hint.textContent = '⚠ Rev ' + data.currentRev + ' already exists — saving as Rev ' + data.nextRev;
    } else {
      $('revInput').value = 0;
      hint.style.display = 'flex';
      hint.className = 'norm-rev-hint ok';
      hint.textContent = '✓ No existing data for this job — will create Rev 0';
    }
  } catch (e) {}
}

// ── Save to PIMS ──────────────────────────────────────────────
async function saveToPims() {
  var jobNo  = $('jobSelect').value;
  var revNo  = parseInt($('revInput').value, 10);
  if (!jobNo) { showToast('Please select a job.', 'error'); return; }
  if (!masterRows.length) { showToast('No rows to save.', 'error'); return; }

  var btn = $('btnSave');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  var sourceFiles = [...new Set(fileQueue.filter(function (f) { return f.status === 'done'; }).map(function (f) { return f.name; }))];

  try {
    var res = await fetch('/api/linelist/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobNo: jobNo, revNo: revNo, sourceFiles: sourceFiles, rows: masterRows })
    });
    var data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Save failed');

    $('saveCard').style.display = 'none';
    $('successMsg').textContent = masterRows.length.toLocaleString() + ' lines saved for job ' + jobNo + ' (Rev ' + revNo + '). Upload ID: ' + data.uploadId;
    $('successCard').style.display = '';
    $('successCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Saved ' + masterRows.length.toLocaleString() + ' lines to PIMS!', 'success');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v14a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save to PIMS';
  }
}

// ══════════════════════════════════════════════════════════════
// FORMAT DETECTION
// ══════════════════════════════════════════════════════════════
var HKWS_GLOBAL = ['SIZE','FLUID CODE','SERIAL NO','PIPE CLASS','FROM','TO','DESIGN','OPER','MDMT','UNIT NO'];

function findBestDataSheet(wb) {
  var best = wb.SheetNames[0], bestScore = -1;
  wb.SheetNames.forEach(function (sh) {
    try {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[sh], { header:1, defval:'', range:0, raw:true });
      var s    = rows.slice(0,10).map(function(r){return r.join(' ');}).join(' ').toUpperCase();
      var score= HKWS_GLOBAL.filter(function(k){return s.indexOf(k)!==-1;}).length;
      if (score > bestScore) { bestScore = score; best = sh; }
    } catch(e){}
  });
  return best;
}

function isDirectMappingFormat(rawRows) {
  if (!rawRows || rawRows.length < 2) return false;
  var h = (rawRows[0]||[]).map(function(c){return safeStr(c).toUpperCase();}).join(' ');
  return h.indexOf('LINENO')!==-1 && h.indexOf('DOCNO')!==-1 && h.indexOf('LINE_CLASS')!==-1;
}

function isLineScheduleFormat(rawRows) {
  if (!rawRows || rawRows.length < 8) return false;
  var r7 = (rawRows[6]||[]).map(function(c){return safeStr(c).toUpperCase();}).join(' ');
  var r8 = (rawRows[7]||[]).map(function(c){return safeStr(c).toUpperCase();}).join(' ');
  return r7.indexOf('LINE')!==-1 && r7.indexOf('NUMBER')!==-1 &&
         r7.indexOf('SERVICE')!==-1 && r7.indexOf('FLUID')!==-1 && r7.indexOf('STATE')!==-1 &&
         r8.indexOf('FROM')!==-1 && r8.indexOf('OPERATING')===-1;
}

// ══════════════════════════════════════════════════════════════
// EXCEL PROCESSING
// ══════════════════════════════════════════════════════════════
async function handleExcel(buffer, file, fileItem) {
  var wb = XLSX.read(buffer, { type:'array', cellDates:false, raw:true });
  var bestSh   = findBestDataSheet(wb);
  var firstRaw = XLSX.utils.sheet_to_json(wb.Sheets[bestSh], { header:1, defval:'', raw:true });
  var rows = [];
  try {
    if (isDirectMappingFormat(firstRaw)) {
      fileItem.fmt = 'DIRECT_MAPPING';
      rows = processDirectMapping(wb, file.name);
    } else if (isLineScheduleFormat(firstRaw)) {
      fileItem.fmt = 'LINE_SCHEDULE';
      var allRaw = [];
      wb.SheetNames.forEach(function (shName) {
        try {
          var rawRows = XLSX.utils.sheet_to_json(wb.Sheets[shName], { header:1, defval:'', raw:true });
          if (!isLineScheduleFormat(rawRows)) return;
          var r2 = rawRows[1]||[], r6 = rawRows[5]||[];
          var docNo = safeStr(r2[53]);
          if (!docNo) for (var ci=0;ci<r2.length;ci++){var v=safeStr(r2[ci]);if(/B224|331-|332-/.test(v)){docNo=v;break;}}
          var unitNo = safeStr(r6[55])||safeStr(r6[54]);
          if (!unitNo) for (var ci=0;ci<r6.length;ci++){var v=safeStr(r6[ci]);if(/^\d{3,4}$/.test(v)){unitNo=v;break;}}
          collectLineScheduleRows(rawRows, docNo, unitNo, file.name, shName).forEach(function(r){allRaw.push(r);});
        } catch (shErr) {
          logError(file.name, shName, '', '', 'PARSE_FAILURE', String(shErr.message||shErr));
        }
      });
      rows = deduplicateLineScheduleRows(allRaw, file.name);
    } else {
      fileItem.fmt = 'LINE_INDEX';
      rows = processStandardLineIndex(wb, file.name, firstRaw, bestSh);
    }
  } finally { wb = null; firstRaw = null; }
  await yieldUI();
  return rows;
}

// ── Format 1: Direct Mapping ──
function processDirectMapping(wb, fileName) {
  var allRows = [];
  wb.SheetNames.forEach(function (shName) {
    try {
      var sh = wb.Sheets[shName]; if (!sh) return;
      var rawRows = XLSX.utils.sheet_to_json(sh, { header:1, defval:'', raw:true });
      if (!isDirectMappingFormat(rawRows)) return;
      var headers = rawRows[0].map(function(h){return safeStr(h).trim();});
      var hi = {};
      headers.forEach(function(h,ci){if(h&&hi[h]===undefined) hi[h]=ci;});
      function gv(row,col){var ci=hi[col];if(ci===undefined||ci>=row.length)return '';var v=row[ci];return(v!==null&&v!==undefined)?safeStr(v):'';}
      var sizeCol = headers.find(function(h){return/^LINE_SIZE/i.test(h);})||'';
      for (var ri=1;ri<rawRows.length;ri++) {
        try {
          var row=rawRows[ri];
          if(!row||!row.some(function(c){return safeStr(c)!=='';})) continue;
          var lineno=gv(row,'LINENO'); if(!lineno) continue;
          var parts=lineno.split('-'),unitNo=parts.length>=3?parts[1]:'';
          var out={}; OUTCOLS.forEach(function(c){out[c]='';});
          out['PID_NO']=gv(row,'DOCNO');out['SERVICE']=gv(row,'SERVICE');out['UNIT_NO']=unitNo;out['LINE_NO']=lineno;
          out['LINE_SIZE']=sizeCol?gv(row,sizeCol):'';out['LINE_SIZE_UNIT']=gv(row,'LINE_SIZE_UNIT');
          out['LINE_CLASS']=gv(row,'LINE_CLASS');out['LINE_FROM']=gv(row,'LINE_FROM');out['LINE_TO']=gv(row,'LINE_TO');
          out['MIN_DESIGN_PRESS']=gv(row,'MIN_DESIGN_PRESS');out['MIN_DESIGN_PRESS_UNIT']=gv(row,'MIN_DESIGN_PRESS_UNIT');
          out['MIN_DESIGN_TEMP']=gv(row,'MIN_DESIGN_TEMP');out['MIN_DESIGN_TEMP_UNIT']=gv(row,'MIN_DESIGN_TEMP_UNIT');
          out['MIN_OPERATING_PRESS']=gv(row,'MIN_OPERATING_PRESS');out['MIN_OPERATING_PRESS_UNIT']=gv(row,'MIN_OPERATING_PRESS_UNIT');
          out['MIN_OPERATING_TEMP']=gv(row,'MIN_OPERATING_TEMP');out['MIN_OPERATING_TEMP_UNIT']=gv(row,'MIN_OPERATING_TEMP_UNIT');
          out['OPERATING_TEMP']=gv(row,'OPERATING_TEMP');out['OPERATING_TEMP_UNIT']=gv(row,'OPERATING_TEMP_UNIT');
          out['OPERATING_PRESS']=gv(row,'OPERATING_PRESS');out['OPERATING_PRESS_UNIT']=gv(row,'OPERATING_PRESS_UNIT');
          out['DESIGN_TEMP']=gv(row,'DESIGN_TEMP');out['DESIGN_TEMP_UNIT']=gv(row,'DESIGN_TEMP_UNIT');
          out['DESIGN_PRESS']=gv(row,'DESIGN_PRESS');out['DESIGN_PRESS_UNIT']=gv(row,'DESIGN_PRESS_UNIT');
          out['INSULATION']=gv(row,'INS_TYPE');out['FULL_VACCUM']=gv(row,'FULL_VACCUM');out['FLUID_STATE']=gv(row,'FLUID_STATE');
          out['MULTI PHASE (FLOW REGIME)']=gv(row,'MULTI PHASE (FLOW REGIME)')||gv(row,'MULTI_PHASE')||'';
          out['INSULATION THICKNESS']=gv(row,'INSULATION THICKNESS')||gv(row,'INSULATION_THICKNESS')||gv(row,'INS_THICKNESS')||gv(row,'INS_THICK')||'';
          allRows.push(out);
        } catch(rowErr){logError(fileName,shName,ri+1,'','PARSE_FAILURE',String(rowErr.message||rowErr));}
      }
    } catch(shErr){logError(fileName,shName,'','','PARSE_FAILURE',String(shErr.message||shErr));}
  });
  return allRows;
}

// ── Format 2: Line Schedule ──
function collectLineScheduleRows(rawRows, docNo, unitNo, fileName, sheetName) {
  var COL={lineNo:0,service:6,fluidState:11,size:15,cls:17,from:20,to:25,operTemp:30,operPress:34,desTemp:38,desPress:42,insulation:58,insThickness:59};
  var SKIP=/^(NOTES?|FORMAT|DELETED|DATE|PREPARED|REVIEWED|APPROVED|REVISION)/i;
  var result=[], lastKey=null;
  for (var ri=9;ri<rawRows.length;ri++) {
    try {
      var row=rawRows[ri]; if(!row||row.length<30) continue;
      var col1=safeStr(row[COL.lineNo]),svc=safeStr(row[COL.service]);
      if(!svc) continue; if(col1&&SKIP.test(col1)) continue;
      var lineKey; if(col1){lineKey=col1;lastKey=col1;}else{lineKey=lastKey;}
      if(!lineKey){logError(fileName,sheetName,ri+1,'','MISSING_PRIMARY_KEY',"SERVICE='"+svc+"' no LINE NUMBER");continue;}
      var parsed=parseLineTag(lineKey);
      if(parsed.parseError==='UNPARSEABLE_LINE_NUMBER') logError(fileName,sheetName,ri+1,lineKey,'UNPARSEABLE_LINE_NUMBER',"'"+lineKey+"' has no hyphens.");
      result.push({line_key:lineKey,PID_NO:docNo||'',SERVICE:svc,UNIT_NO:unitNo||parsed.unitFromLine||'',LINE_NO:parsed.serialNo,
        size_raw:safeStr(row[COL.size]),LINE_CLASS:safeStr(row[COL.cls]),LINE_FROM:safeStr(row[COL.from]),LINE_TO:safeStr(row[COL.to]),
        OPER_T_raw:safeStr(row[COL.operTemp]),OPER_P_raw:safeStr(row[COL.operPress]),DES_T_raw:safeStr(row[COL.desTemp]),DES_P_raw:safeStr(row[COL.desPress]),
        INSULATION:safeStr(row[COL.insulation]),INS_THICKNESS:safeStr(row[COL.insThickness]),FLUID_STATE:safeStr(row[COL.fluidState]),
        _ri:ri+1,_sheet:sheetName});
    } catch(rowErr){logError(fileName,sheetName,ri+1,safeStr((rawRows[ri]||[])[0]),'PARSE_FAILURE',String(rowErr.message||rowErr));}
  }
  return result;
}

function deduplicateLineScheduleRows(rawRows, fileName) {
  var CRIT=['SERVICE','LINE_CLASS','OPER_T_raw','OPER_P_raw','DES_T_raw','DES_P_raw','FLUID_STATE'];
  var order=[],groups={};
  rawRows.forEach(function(r){
    var key=r.line_key;
    if(!groups[key]){groups[key]={base:r,size_raw:r.size_raw||'',insulation:r.INSULATION||'',insThickness:r.INS_THICKNESS||'',conflicts:[],conflictFields:[]};order.push(key);}
    else{var g=groups[key];if(!g.insulation&&r.INSULATION)g.insulation=r.INSULATION;if(!g.insThickness&&r.INS_THICKNESS)g.insThickness=r.INS_THICKNESS;
      CRIT.forEach(function(c){if(g.base[c]&&r[c]&&g.base[c]!==r[c]&&g.conflictFields.indexOf(c)===-1){g.conflictFields.push(c);g.conflicts.push(c+": '"+g.base[c]+"' vs '"+r[c]+"'");}});
      if(r.size_raw&&g.size_raw!==r.size_raw) g.size_raw=g.size_raw?g.size_raw+', '+r.size_raw:r.size_raw;}
  });
  var out=[];
  order.forEach(function(key){
    try{
      var g=groups[key],base=g.base;
      if(g.conflicts.length>0) logError(fileName,base._sheet,base._ri,key,'MERGE_CONFLICT','Conflicting: '+g.conflicts.join('; '));
      var oTp=parseDesignTemp(base.OPER_T_raw,'TEMP (°C)'),dTp=parseDesignTemp(base.DES_T_raw,'TEMP (°C)');
      var oPp=parseDesignPress(base.OPER_P_raw,'PRESS (kg/cm2g)'),dPp=parseDesignPress(base.DES_P_raw,'PRESS (kg/cm2g)');
      out.push({PID_NO:base.PID_NO,SERVICE:base.SERVICE,UNIT_NO:base.UNIT_NO,LINE_NO:base.LINE_NO,
        LINE_SIZE:g.size_raw,LINE_SIZE_UNIT:g.size_raw?'INCHES':'',
        LINE_CLASS:g.conflicts.length?'REVIEW - CONFLICTING CONDITIONS':base.LINE_CLASS,
        LINE_FROM:base.LINE_FROM,LINE_TO:base.LINE_TO,
        MIN_DESIGN_PRESS:dPp.min,MIN_DESIGN_PRESS_UNIT:dPp.min?dPp.unit:'',
        MIN_DESIGN_TEMP:dTp.min,MIN_DESIGN_TEMP_UNIT:dTp.min?'°C':'',
        MIN_OPERATING_PRESS:oPp.min,MIN_OPERATING_PRESS_UNIT:oPp.min?oPp.unit:'',
        MIN_OPERATING_TEMP:oTp.min,MIN_OPERATING_TEMP_UNIT:oTp.min?'°C':'',
        OPERATING_TEMP:oTp.design,OPERATING_TEMP_UNIT:oTp.design?'°C':'',
        OPERATING_PRESS:oPp.design,OPERATING_PRESS_UNIT:oPp.design?oPp.unit:'',
        DESIGN_TEMP:dTp.design,DESIGN_TEMP_UNIT:dTp.design?'°C':'',
        DESIGN_PRESS:dPp.design,DESIGN_PRESS_UNIT:dPp.design?dPp.unit:'',
        INSULATION:g.insulation||base.INSULATION||'',FULL_VACCUM:dPp.fv||(dPp.min==='FV'?'Yes':'No'),
        FLUID_STATE:base.FLUID_STATE,'MULTI PHASE (FLOW REGIME)':'','INSULATION THICKNESS':g.insThickness||base.INS_THICKNESS||''});
    }catch(e){logError(fileName,groups[key]?groups[key].base._sheet:'',groups[key]?groups[key].base._ri:'',key,'PARSE_FAILURE',String(e.message||e));}
  });
  return out;
}

// ── Format 3: Standard Line Index ──
function processStandardLineIndex(wb, fileName, firstRaw, bestSh) {
  var HKWS=['SIZE','FLUID CODE','SERIAL NO','PIPE CLASS','FROM','TO','DESIGN','OPER','MDMT','UNIT NO'];
  var rawRows=firstRaw,bestScore=0,headerRowIdx=0;
  for(var i=0;i<Math.min(rawRows.length,25);i++){
    var rowStr=rawRows[i].map(function(c){return String(c);}).join(' ').toUpperCase();
    var score=HKWS.filter(function(k){return rowStr.indexOf(k)!==-1;}).length;
    if(score>bestScore){bestScore=score;headerRowIdx=i;}
  }
  var headers=rawRows[headerRowIdx].map(function(h){return String(h).trim();});
  var firstColIdx={};
  headers.forEach(function(h,ci){if(h&&firstColIdx[h]===undefined)firstColIdx[h]=ci;});
  var data=[];
  for(var r=headerRowIdx+1;r<rawRows.length;r++){
    var rowArr=rawRows[r];
    if(!rowArr||!rowArr.some(function(c){return String(c).trim()!=='';})) continue;
    var rowObj={};
    headers.forEach(function(h,ci){if(h&&firstColIdx[h]===ci)rowObj[h]=(rowArr[ci]!==undefined)?rowArr[ci]:'';});
    data.push(rowObj);
  }
  var cm=getColMap(headers,false);
  var remarksKey=headers.find(function(h){return/REMARK/i.test(h);})||null;
  var processed=[];
  for(var i=0;i<data.length;i++){
    try{
      if(remarksKey&&safeStr(data[i][remarksKey]).toUpperCase().indexOf('NOT USED')!==-1) continue;
      var hasKey=cm.lineNo&&safeStr(data[i][cm.lineNo]),hasData=(cm.size&&safeStr(data[i][cm.size]))||(cm.lineClass&&safeStr(data[i][cm.lineClass]));
      if(!hasKey&&!hasData) continue;
      var row=transformRow(data[i],cm,false,fileName,headerRowIdx+1+i+1);
      if(row.LINE_NO||row.SERVICE||row.PID_NO) processed.push(row);
    }catch(rowErr){logError(fileName,bestSh,headerRowIdx+1+i+1,safeStr(data[i][cm.lineNo]),'PARSE_FAILURE',String(rowErr.message||rowErr));}
  }
  return processed;
}

// ══════════════════════════════════════════════════════════════
// PDF PROCESSING
// ══════════════════════════════════════════════════════════════
async function handlePDF(buffer, file, fileItem) {
  fileItem.fmt = 'PDF';
  var uint8 = new Uint8Array(buffer);
  var pdf   = await pdfjsLib.getDocument({ data: uint8 }).promise;
  var pPages = [];
  for (var p=1;p<=pdf.numPages;p++)
    pPages.push(pdf.getPage(p).then(function(pg){return pg.getTextContent().then(function(tc){return{items:tc.items,pageNum:pg.pageNumber};});}));
  var pages = (await Promise.all(pPages)).sort(function(a,b){return a.pageNum-b.pageNum;});
  var allSecs = [];
  pages.forEach(function(pg){
    try{
      var items=pg.items.map(function(item){return{text:safeStr(item.str),x:Math.round(item.transform[4]/10)*10,y:Math.round(item.transform[5]/10)*10,page:pg.pageNum};});
      var sec=extractPDFSection(items);
      if(sec&&sec.rows&&sec.rows.length>0) allSecs.push(sec);
    }catch(pgErr){logError(file.name,'Page '+pg.pageNum,'','','PARSE_FAILURE',String(pgErr.message||pgErr));}
  });
  var rawData=[];
  allSecs.forEach(function(sec){rawData=rawData.concat(sec.rows);});
  var processed=[];
  if(rawData.length>0){
    var cm=getColMap(Object.keys(rawData[0]),true);
    rawData.forEach(function(r,idx){
      try{var row=transformRow(r,cm,true,file.name,idx+1);if(row.LINE_NO||row.SERVICE||row.PID_NO) processed.push(row);}
      catch(rowErr){logError(file.name,'PDF',idx+1,safeStr(r['LINE_NO']),'PARSE_FAILURE',String(rowErr.message||rowErr));}
    });
  }
  await yieldUI();
  return processed;
}

// ══════════════════════════════════════════════════════════════
// PARSERS
// ══════════════════════════════════════════════════════════════
function parseLineTag(v){
  try{var s=safeStr(v);if(!s)return{fluidCode:'',unitFromLine:'',serialNo:'',parseError:'MISSING_PRIMARY_KEY'};
    var p=s.split('-');if(p.length>=3)return{fluidCode:safeStr(p[0]),unitFromLine:safeStr(p[1]),serialNo:p.slice(2).map(safeStr).join('-'),parseError:''};
    return{fluidCode:'',unitFromLine:'',serialNo:s,parseError:p.length===1?'UNPARSEABLE_LINE_NUMBER':''};}
  catch(e){return{fluidCode:'',unitFromLine:'',serialNo:safeStr(v),parseError:'PARSE_FAILURE'};}
}

function parseDesignPress(val,header){
  try{
    var unit='';if(header){var hh=String(header),pm=hh.match(/\(([^)]+)\)/);if(pm)unit=pm[1].trim();}
    var s=safeStr(val);if(!s||s==='*')return{design:'',min:'',unit:'',fv:'No'};
    if(s.indexOf('\\')!==-1||(/[A-Za-z]{4,}/.test(s)&&!/^FV$/i.test(s.trim())))return{design:s,min:'',unit:unit,fv:'No',malformed:true};
    var hasFV=/\bFV\b/i.test(s);
    if(s.indexOf('/')!==-1){var p=s.split('/'),p1=p[0].trim(),p2=p.slice(1).join('/').trim(),fv1=p1.toUpperCase()==='FV',fv2=p2.toUpperCase()==='FV';
      if(fv1||fv2){var rv=fv1?p2:p1,n=parseFloat(rv);return{design:isNaN(n)?rv:String(n),min:'',unit:unit,fv:'Yes'};}
      var n1=parseFloat(p1),n2=parseFloat(p2);
      if(!isNaN(n1)&&!isNaN(n2))return n1>=n2?{design:String(n1),min:String(n2),unit:unit,fv:hasFV?'Yes':'No'}:{design:String(n2),min:String(n1),unit:unit,fv:hasFV?'Yes':'No'};
      return{design:p1,min:'',unit:unit,fv:hasFV?'Yes':'No'};}
    var dr=s.match(/^([\d.]+)\s*-\s*([\d.]+)$/);
    if(dr){var v1=parseFloat(dr[1]),v2=parseFloat(dr[2]);if(v1>=0&&v2>0){var lo=Math.min(v1,v2),hi=Math.max(v1,v2);return{design:String(hi),min:String(lo),unit:unit,fv:'No'};}}
    var n=parseFloat(s);return{design:isNaN(n)?s:String(n),min:'',unit:unit,fv:hasFV?'Yes':'No'};
  }catch(e){return{design:safeStr(val),min:'',unit:'',fv:'No'};}
}

function parseDesignTemp(val,header){
  try{
    var unit='';if(header){var hh=String(header),pm=hh.match(/\(([^)]+)\)/);if(pm)unit=pm[1].trim();}
    var s=safeStr(val);if(!s||s==='*')return{design:'',min:'',unit:''};
    if(/[A-Za-z]{4,}/.test(s))return{design:s,min:'',unit:unit,malformed:true};
    function numOrNull(x){var n=parseFloat(x);return isNaN(n)?null:n;}
    var minVal='',designVal='',slashIdx=s.indexOf('/');
    if(slashIdx>0){var t1=s.slice(0,slashIdx).trim(),t2=s.slice(slashIdx+1).trim(),n1=numOrNull(t1),n2=numOrNull(t2);
      if(n1!=null&&n2!=null){minVal=n1<n2?t1:t2;designVal=n1<n2?t2:t1;}else{minVal=t1;designVal=t2;}}
    else{var dm=s.match(/^([-]?[\d.]+)-([\d.]+)$/);
      if(dm){var n1=numOrNull(dm[1]),n2=numOrNull(dm[2]);if(n1!=null&&n2!=null){minVal=n1<n2?dm[1]:dm[2];designVal=n1<n2?dm[2]:dm[1];}else designVal=s;}
      else designVal=s;}
    return{design:designVal,min:minVal,unit:(designVal||minVal)?unit:''};
  }catch(e){return{design:safeStr(val),min:'',unit:''};}
}

// ══════════════════════════════════════════════════════════════
// COLUMN MAP + TRANSFORM
// ══════════════════════════════════════════════════════════════
function gv(row,col){try{return col&&row[col]!==undefined?row[col]:'';}catch(e){return '';}}
function buildPidFromHeaderAndCell(header,cell){
  try{var h=safeStr(header),v=safeStr(cell);if(!h)return '';var m=h.match(/P&ID\s*(.*)/i),tail=m?m[1].trim():'',prefix=tail&&/^[0-9-].*[0-9]/.test(tail)?tail:'';if(!v)return'';return prefix?prefix+v:v;}
  catch(e){return safeStr(cell);}
}
function findCol(headers,candidates){
  try{for(var i=0;i<candidates.length;i++){var c=candidates[i],found=typeof c==='string'?headers.find(function(h){return h.trim()===c.trim();}):headers.find(function(h){return c.test(h);});if(found)return found;}return null;}
  catch(e){return null;}
}
function getColMap(headers,isPdf){
  function f(c){return findCol(headers,c);}
  if(isPdf)return{pid:f(['PID_NO']),service:f(['SERVICE',/SERVICE/i,/FLUID.*CODE/i]),unitNo:f(['UNIT_NO_COL',/UNIT.*NO/i]),lineNo:f(['LINE_NO',/LINE.*NO/i]),size:f(['LINE_SIZE',/^SIZE/i]),lineClass:f(['LINE_CLASS',/CLASS/i]),from:f(['LINE_FROM']),to:f(['LINE_TO']),designPress:f(['DESIGN_PRESS',/DESIGN.*PRESS/i]),designTemp:f(['DESIGN_TEMP',/DESIGN.*TEMP/i]),operPress:f(['OPERATING_PRESS',/OPER.*PRESS/i]),operTemp:f(['OPERATING_TEMP',/OPER.*TEMP/i]),mdmt:f(['MDMT']),phase:f(['FLUID_STATE',/STATE/i]),insulation:f(['INSULATION',/^INSUL(?!.*THICK)/i]),insThickness:f(['INSULATION THICKNESS','INSULATION_THICKNESS',/INSUL.*THICK/i,/INS.*THICK/i]),multiPhase:f(['MULTIPHASE(FLOWREGIME)',/MULTIPHASE.*FLOW/i,/MULTI.*PHASE/i])};
  return{pid:f(['P&ID Name',/^P&ID/i]),service:f(['SERVICE','FLUID CODE.1','FLUID CODE',/FLUID.*CODE/i,/SERVICE/i]),unitNo:f(['UNIT NO.1','UNIT NO','UNIT NO.','UNIT',/UNIT.*NO/i]),lineNo:f(['LINE NUMBER','SERIAL NO..1','SERIAL NO.',/SERIAL.*NO/i]),size:f(['SIZE INCHES','SIZE (INCHES)','SIZE MM','SIZE (MM)','SIZE (in).1','SIZE (in)',/^SIZE/i]),lineClass:f(['CLASS','PIPE CLASS.1','PIPE CLASS',/PIPE.*CLASS/i]),from:f(['FROM','LOCATION FROM','FROM.1']),to:f(['TO','LOCATION TO','TO.1']),designPress:f(['DESIGN PRESS (kg/cm2g).1','DESIGN PRESS (kg/cm2g)','DESIGN PRESS (kg/cm2g) / FV)','DESIGN PRESS (kg/cm2g) / FV','PRESSURE KGCM2 G (DESIGN)',/DESIGN.*PRESS/i,/DESIGN CONDITIONS.*PRESSURE/i]),designTemp:f(['DESIGN TEMP (°C).1','DESIGN TEMP (°C)','TEMP DEG.C',/DESIGN.*TEMP/i,/DESIGN CONDITIONS.*TEMP/i]),operPress:f(['OPER. PRESS (kg/cm2g).1','OPER. PRESS (kg/cm2g)','OPER. PRESS (kg/cm² g)','PRESSURE KGCM2 G',/OPER.*PRESS/i,/OPERATING CONDITIONS.*PRESSURE/i]),operTemp:f(['OPER. TEMP (°C).1','OPER. TEMP (°C)','TEMP DEG. C',/OPER.*TEMP/i,/OPERATING CONDITIONS.*TEMP/i]),mdmt:f(['MDMT (°C).1','MDMT (°C)',/^MDMT/i]),insulation:f(['INSULATION.1','INSULATION',/^INSUL(?!.*THICK)/i]),insThickness:f(['INSULATION THICKNESS.1','INSULATION THICKNESS','INSULATION_THICKNESS',/INSUL.*THICK/i,/INS.*THICK/i]),phase:f(['FLUID STATE','PHASE (L/V)',/^PHASE/i,/FLUID.*STATE/i,/^FLUID.*CODE/i]),multiPhase:f(['MULTIPHASE(FLOWREGIME)',/MULTIPHASE.*FLOW/i,/MULTI.*PHASE/i])};
}

function transformRow(row,cm,isPdf,_fn,_ri){
  var out={};OUTCOLS.forEach(function(c){out[c]='';});
  var rawLineStr='',lnP={serviceFromLine:'',unitFromLine:'',lineNo:''};
  try{rawLineStr=safeStr(gv(row,cm.lineNo));lnP=parseLineNumber(rawLineStr);}catch(e){}
  var rawLN=lnP.lineNo,finalLN=lnP.lineNo,finalUN='';
  try{
    finalUN=safeStr(gv(row,cm.unitNo))||lnP.unitFromLine;
    if(isPdf&&rawLN){var p=rawLN.split('-');if(p.length>=3){finalUN=p[1];finalLN=p.slice(2).join('-');}var cu=gv(row,'UNIT_NO_COL');if(cu&&safeStr(cu))finalUN=safeStr(cu);}
    if(!isPdf&&rawLN){var n=parseFloat(rawLN);if(!isNaN(n)&&String(rawLN).indexOf('.')!==-1)finalLN=String(Math.round(n));}
  }catch(e){}
  out['LINE_NO']=finalLN;out['UNIT_NO']=finalUN;
  try{out['PID_NO']=isPdf?safeStr(gv(row,'PID_NO')):(cm.pid?buildPidFromHeaderAndCell(cm.pid,gv(row,cm.pid)):'');}catch(e){}
  try{out['SERVICE']=safeStr(gv(row,cm.service))||lnP.serviceFromLine;}catch(e){}
  try{out['LINE_CLASS']=safeStr(gv(row,cm.lineClass));}catch(e){}
  try{out['LINE_FROM']=safeStr(gv(row,cm.from));}catch(e){}
  try{out['LINE_TO']=safeStr(gv(row,cm.to));}catch(e){}
  try{out['FLUID_STATE']=safeStr(gv(row,cm.phase));}catch(e){}
  try{out['MULTI PHASE (FLOW REGIME)']=safeStr(gv(row,cm.multiPhase));}catch(e){}
  try{out['INSULATION']=safeStr(gv(row,cm.insulation));}catch(e){}
  try{out['INSULATION THICKNESS']=safeStr(gv(row,cm.insThickness));}catch(e){}
  try{var sz=safeStr(gv(row,cm.size));out['LINE_SIZE']=sz;var u='';if(cm.size){var hh=String(cm.size).toUpperCase();if(hh.indexOf('INCH')!==-1||/\(IN\b/.test(hh))u='INCHES';else if(hh.indexOf('MM')!==-1)u='MM';}out['LINE_SIZE_UNIT']=sz?u:'';}catch(e){}
  try{var dp=parseDesignPress(gv(row,cm.designPress),cm.designPress);out['DESIGN_PRESS']=dp.design;out['DESIGN_PRESS_UNIT']=dp.design?dp.unit:'';out['MIN_DESIGN_PRESS']=dp.min;out['MIN_DESIGN_PRESS_UNIT']=dp.min?dp.unit:'';out['FULL_VACCUM']=dp.min==='FV'?'Yes':dp.fv||'No';}catch(e){}
  try{var op=parseDesignPress(gv(row,cm.operPress),cm.operPress);out['OPERATING_PRESS']=op.design;out['OPERATING_PRESS_UNIT']=op.design?op.unit:'';out['MIN_OPERATING_PRESS']=op.min;out['MIN_OPERATING_PRESS_UNIT']=op.min?op.unit:'';}catch(e){}
  try{var dt=parseDesignTemp(gv(row,cm.designTemp),cm.designTemp),mdmt=safeStr(gv(row,cm.mdmt)),minDT=mdmt||dt.min||'';out['DESIGN_TEMP']=dt.design;out['DESIGN_TEMP_UNIT']=dt.design?dt.unit:'';out['MIN_DESIGN_TEMP']=minDT;out['MIN_DESIGN_TEMP_UNIT']=minDT?dt.unit:'';}catch(e){}
  try{var ot=parseDesignTemp(gv(row,cm.operTemp),cm.operTemp);out['OPERATING_TEMP']=ot.design;out['OPERATING_TEMP_UNIT']=ot.design?ot.unit:'';}catch(e){}
  return out;
}

function parseLineNumber(raw){
  try{var s=safeStr(raw),p=s.split('-');if(p.length!==3)return{serviceFromLine:'',unitFromLine:'',lineNo:s};return{serviceFromLine:p[0]||'',unitFromLine:p[1]||'',lineNo:p[2]||''};}
  catch(e){return{serviceFromLine:'',unitFromLine:'',lineNo:safeStr(raw)};}
}

// ══════════════════════════════════════════════════════════════
// PDF TABLE EXTRACTOR
// ══════════════════════════════════════════════════════════════
function extractPDFSection(items){
  try{
    items.sort(function(a,b){return b.y-a.y;});
    var rows=[],curRow=[],curY=items.length>0?items[0].y:0;
    items.forEach(function(item){if(Math.abs(item.y-curY)>5){if(curRow.length>0)rows.push({y:curY,cells:curRow.sort(function(a,b){return a.x-b.x;})});curRow=[];curY=item.y;}curRow.push(item);});
    if(curRow.length>0)rows.push({y:curY,cells:curRow.sort(function(a,b){return a.x-b.x;})});
    var operX=-1,designX=-1,grpIdx=-1;
    for(var gi=0;gi<Math.min(rows.length,60);gi++){var rt=rows[gi].cells.map(function(c){return c.text;}).join(' ');if(/oper/i.test(rt)&&/design/i.test(rt)){rows[gi].cells.forEach(function(cell){if(/oper/i.test(cell.text)&&operX<0)operX=cell.x;if(/design/i.test(cell.text)&&designX<0)designX=cell.x;});grpIdx=gi;break;}}
    var LINERE=/[A-Z0-9]{1,6}-[0-9]{2,4}-[0-9]{3,6}/i,dataStart=-1;
    for(var di=0;di<rows.length;di++){for(var ci=0;ci<Math.min(4,rows[di].cells.length);ci++){if(LINERE.test(rows[di].cells[ci].text.trim())){dataStart=di;break;}}if(dataStart>=0)break;}
    if(dataStart<0&&grpIdx>=0)dataStart=grpIdx+4;if(dataStart<0)return null;
    var hStart=grpIdx>=0?grpIdx:Math.max(0,dataStart-10),hCells=[],docNo='';
    for(var hi=hStart;hi<dataStart;hi++){rows[hi].cells.forEach(function(cell){var t=safeStr(cell.text);if(!t||t.length>80)return;if(/[A-Z0-9]{3,4}-[0-9]{2,3}-[0-9]{2,3}-[A-Z\-0-9]/.test(t)){docNo=t;return;}if(/PDH|PETRONET|PROPYLENE|ETHANE|PROPANE|EILB|EDP|DS|IS|Copyright|Format No|Issued|Prepared|Reviewed|Approved|Purpose|Date|Rev\. No/i.test(t))return;if(/Process|Utility|interconnecting|Mounded Bullet|Hydrogen Bullet/i.test(t))return;hCells.push({text:t,x:cell.x});});}
    var XTOL=20,clusters=[];
    hCells.forEach(function(cell){var found=false;for(var k=0;k<clusters.length;k++){if(Math.abs(clusters[k].x-cell.x)<=XTOL){clusters[k].texts.push(cell.text);clusters[k].x=(clusters[k].x*clusters[k].n+cell.x)/(clusters[k].n+1);clusters[k].n++;found=true;break;}}if(!found)clusters.push({x:cell.x,texts:[cell.text],n:1});});
    clusters.sort(function(a,b){return a.x-b.x;});
    var colDefs=clusters.map(function(cl,i){
      var seen={},uniq=cl.texts.filter(function(t){var k=t.toLowerCase().replace(/[^a-z0-9]/g,'');if(!k||/[0-9]/.test(t)||seen[k])return false;seen[k]=true;return true;});
      var combined=uniq.join(' ').replace(/  +/g,' ').trim(),x=cl.x,xEnd=clusters[i+1]?clusters[i+1].x-1:99999;
      var inOper=operX>=0&&designX>=0&&x>operX-15&&x<designX-15,u=combined.toUpperCase(),name=combined;
      if(/S\.No|S\.No\./i.test(u))name='SNO_IGNORE';
      else if(/LINE\.NO|SERIAL\.NO/i.test(u))name='LINE_NO';
      else if(/SERVICE/i.test(u))name='SERVICE';
      else if(/FLUID\.STATE|STATE|FLUID/i.test(u))name='FLUID_STATE';
      else if(/CLASS/i.test(u))name='LINE_CLASS';
      else if(/SIZE/i.test(u))name='LINE_SIZE';
      else if(/FROM/i.test(u)||/ TO/i.test(u))name=/FROM/i.test(u)?'LINE_FROM':'LINE_TO';
      else if(/MDMT/i.test(u))name='MDMT';
      else if(/P\.?I\.?D/i.test(u))name='PID_NO';
      else if(/UNIT\.NO/i.test(u))name='UNIT_NO_COL';
      else if(/INSUL.*THICK|INS.*THICK/i.test(u))name='INSULATION THICKNESS';
      else if(/^INSUL/i.test(u))name='INSULATION';
      else if(/TEMP|TEMPERATURE/i.test(u)){if(operX>=0&&designX>=0)name=inOper?'OPERATING_TEMP':'DESIGN_TEMP';else name='TEMP_'+i;}
      else if(/PRESS|PRESSSURE/i.test(u)&&!/SIZE|MEDIUM|MED/i.test(u)){if(operX>=0&&designX>=0)name=inOper?'OPERATING_PRESS':'DESIGN_PRESS';else name='PRESS_'+i;}
      return{name:name,x:x,xStart:x-XTOL,xEnd:xEnd};
    });
    var tAmb=colDefs.filter(function(c){return c.name.indexOf('TEMP')===0;}),pAmb=colDefs.filter(function(c){return c.name.indexOf('PRESS')===0;});
    if(tAmb.length===2){tAmb[0].name='OPERATING_TEMP';tAmb[1].name='DESIGN_TEMP';}else if(tAmb.length===1)tAmb[0].name='OPERATING_TEMP';
    if(pAmb.length===2){pAmb[0].name='OPERATING_PRESS';pAmb[1].name='DESIGN_PRESS';}else if(pAmb.length===1)pAmb[0].name='OPERATING_PRESS';
    var tableData=[];
    rows.slice(dataStart).forEach(function(row){
      try{
        var rowObj={PID_NO:docNo};colDefs.forEach(function(c){rowObj[c.name]='';});
        row.cells.forEach(function(cell){var best=null,bestDist=99999;colDefs.forEach(function(col){if(cell.x>=col.xStart&&cell.x<=col.xEnd){var d=Math.abs(cell.x-col.x);if(d<bestDist){bestDist=d;best=col;}}});if(!best){colDefs.forEach(function(col){var d=Math.abs(cell.x-col.x);if(d<bestDist){bestDist=d;best=col;}});}if(best)rowObj[best.name]=rowObj[best.name]?rowObj[best.name]+' '+safeStr(cell.text):safeStr(cell.text);});
        var ln=safeStr(rowObj['LINE_NO']);if(LINERE.test(ln)||/[0-9]/.test(ln))tableData.push(rowObj);
      }catch(e){}
    });
    return{rows:tableData,colNames:colDefs.map(function(c){return c.name;}),operX:operX,designX:designX};
  }catch(e){return null;}
}
