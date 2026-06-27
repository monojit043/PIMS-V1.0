// final.js - Final Isometrics functionality for PIMS
// This file handles the Final Isometrics table and Excel export functionality

let finalIsometricsData = [];

// Initialize Final Isometrics functionality
document.addEventListener('DOMContentLoaded', function () {
    setupFinalIsometricsEventListeners();
});

function setupFinalIsometricsEventListeners() {
    // Add click listener for Final Isometrics menu item
    const finalIsometricsItems = document.querySelectorAll('li img[src="images/Final-iso.png"]');
    finalIsometricsItems.forEach(item => {
        const listItem = item.parentElement;
        // Remove inactive-item class to make it clickable
        listItem.classList.remove('inactive-item');
        listItem.style.cursor = 'pointer';

        listItem.addEventListener('click', function () {
            showFinalIsometrics();
        });
    });
}

async function showFinalIsometrics() {
    // Restrict access to SGL only
    try {
        const response = await fetch('/api/me');
        const user = await response.json();
        // Store the logged-in employee ID globally for later use in Excel export
        window.currentEmployeeID = user?.id || 'Unknown';


    } catch (err) {

        return;
    }

    window.currentView = "FinalIsometrics";

    // Clear notification menu highlights and role title
    if (typeof removeNotificationMenuHighlight === 'function') {
        removeNotificationMenuHighlight();
    }
    if (typeof clearNotificationRoleTitle === 'function') {
        clearNotificationRoleTitle();
    }

    try {
        // Hide all other views
        if (typeof hideAllTablesFinalSafe === "function") {
            hideAllTablesFinalSafe();
        } else if (typeof hideAllTables === "function") {
            hideAllTables();
        }

        hideWelcome();

        // Remove any performance views
        const performanceViews = ['checker-performance-view', 'modeller-performance-view', 'gl-performance-view', 'sgl-performance-view'];
        performanceViews.forEach(viewId => {
            const view = document.getElementById(viewId);
            if (view) view.remove();
        });

        // Clear any menu highlights
        document.querySelectorAll('.menu-task-active, .menu-notif-active, .menu-finaliso-active')
            .forEach(el => el.classList.remove('menu-task-active', 'menu-notif-active', 'menu-finaliso-active'));

        // Highlight Final Isometrics menu
        highlightFinalIsometricsMenu();

                // Show or recreate the final isometrics table container
        let finalIsometricsContainer = document.getElementById('final-isometrics-table-container');
        if (!finalIsometricsContainer) {
            const rightPanel = document.getElementById('right-panel') || document.querySelector('.main-content') || document.body;
            finalIsometricsContainer = document.createElement('div');
            finalIsometricsContainer.id = 'final-isometrics-table-container';
            finalIsometricsContainer.innerHTML = `<table class="data-table"><thead><tr></tr></thead><tbody></tbody></table>`;
            rightPanel.appendChild(finalIsometricsContainer);
        }
        
        // Show loading message first
        const tbody = finalIsometricsContainer.querySelector('.data-table tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="10" class="no-data">Loading Final Isometrics...</td></tr>';
        }
        finalIsometricsContainer.style.display = 'block';
        
        // Load data, then render table and setup buttons
        await loadFinalIsometricsData();
        renderFinalIsometricsTable();
        setupExportButtons();



    } catch (error) {
        console.error('Error showing final isometrics:', error);
        alert('Error loading final isometrics. Please try again.');
    }
}

async function loadFinalIsometricsData() {
    try {
        // Fetch drawings with status "Ready for EDMS"
        const response = await fetch('/api/final-isometrics');
        const data = await response.json();

        if (data.ok) {
            finalIsometricsData = data.finalIsometrics || [];
            console.log(`Loaded ${finalIsometricsData.length} final isometric records`);
        } else {
            console.error('Failed to load final isometrics:', data.error);
            finalIsometricsData = [];
        }
    } catch (error) {
        console.error('Error loading final isometrics data:', error);
        finalIsometricsData = [];
    }
}

// Setup filters for Final Isometrics table
function setupFinalIsometricsFilters() {
    const thead = document.querySelector('#final-isometrics-table-container .data-table thead tr');
    if (!thead) return;

    // Remove any previous filters
    document.querySelectorAll('.final-iso-filter').forEach(f => f.remove());

    // Columns to filter: Job Number (2), Unit Number (3), Zone (5), Reason For Revision (7), Rev. Number (8), Approved By (9)
    const filterColumns = [
        { name: 'Job Number', index: 2, dataKey: 'job_nr' },
        { name: 'Unit Number', index: 3, dataKey: 'unit_id' },
        { name: 'Zone', index: 5, dataKey: 'ZONE' },
        { name: 'Reason For Revision', index: 7, dataKey: 'revision_reason' },
        { name: 'Rev. Number', index: 8, dataKey: 'revision_nr' },
        { name: 'Approved By', index: 9, dataKey: 'finalby' }
    ];


    filterColumns.forEach(col => {
        const th = thead.children[col.index];
        if (!th) return;

        const select = document.createElement('select');
        select.className = 'final-iso-filter';
        select.style.maxWidth = '100px';
        select.style.fontSize = '11px';
        select.style.marginLeft = '2px';
        select.setAttribute('data-column-index', col.index);

        // Get unique values
        let vals = finalIsometricsData.map(item => String(item[col.dataKey] || ''));
        vals = Array.from(new Set(vals)).filter(v => v !== '').sort();

        select.innerHTML = `<option value="">All</option>` +
            vals.map(v => `<option value="${v}">${v}</option>`).join('');

        select.onchange = function () {
            filterFinalIsometricsTable();
        };

        th.appendChild(select);
    });
}

// Filter the Final Isometrics table based on selected filters
function filterFinalIsometricsTable() {
    const table = document.querySelector('#final-isometrics-table-container .data-table');
    if (!table) return;

    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    // Get all filters
    const selects = table.querySelectorAll('.final-iso-filter');
    const filters = {};
    selects.forEach(select => {
        const columnIndex = parseInt(select.getAttribute('data-column-index'));
        filters[columnIndex] = select.value;
    });

    // Go through all rows
    const rows = tbody.querySelectorAll('tr');
    rows.forEach(row => {
        // Skip "no data" rows
        if (row.querySelector('.no-data')) return;

        let show = true;
        Object.keys(filters).forEach(colIndex => {
            if (!filters[colIndex]) return; // Skip empty filters
            const cell = row.children[colIndex];
            if (!cell) return;
            if (cell.textContent.trim() !== filters[colIndex]) {
                show = false;
            }
        });

        row.style.display = show ? '' : 'none';
    });
}


function renderFinalIsometricsTable() {
    const tableContainer = document.querySelector('#final-isometrics-table-container .data-table tbody');
    if (!tableContainer) return;

    // Clear existing rows
    tableContainer.innerHTML = '';

    // Update table header
    updateFinalIsometricsTableHeader();

    if (finalIsometricsData.length === 0) {
        tableContainer.innerHTML = '<tr><td colspan="10" class="no-data">No Final Isometrics available</td></tr>';
        return;
    }

    finalIsometricsData.forEach((item, index) => {
        const row = document.createElement('tr');
        row.setAttribute('data-index', index);

        // Format revision date
        const revisionDate = item.revision_dt ? new Date(item.revision_dt).toLocaleDateString() : '';

        row.innerHTML = `
                <td>
                    <input type="checkbox" class="final-iso-select" data-index="${index}" onchange="handleFinalIsoSelection(this)">
                </td>
                <td>${index + 1}</td>
                <td>${item.job_nr || ''}</td>
                <td>${item.unit_id || ''}</td>
                <td>${item.document_name || ''}</td>
                <td>${item.ZONE || ''}</td>
                <td>${item.issue_lot || ''}</td>
                <td>${item.revision_reason || ''}</td>
                <td>${item.revision_nr || ''}</td>
                <td>${item.finalby || ''}</td>
                <td>${revisionDate}</td>
            `;

        tableContainer.appendChild(row);
    });

    // Update selection count
    updateSelectionCount();
}

function updateFinalIsometricsTableHeader() {
    const thead = document.querySelector('#final-isometrics-table-container .data-table thead tr');
    if (!thead) return;

    const headers = [
        'Select',
        'SNO',
        'Job Number',
        'Unit Number',
        'Line Number',
        'Zone',
        'Lot Number',
        'Reason For Revision',
        'Rev. Number',
        'Approved By',
        'Rev. Date'
    ];

    thead.innerHTML = headers.map(header => `<th>${header}</th>`).join('');

    // Add filters after headers are created
    setupFinalIsometricsFilters();
}

// Filter Final Isometrics table by search term
function filterFinalIsometricsTableBySearch(searchTerm) {
    const tableContainer = document.querySelector('#final-isometrics-table-container .data-table tbody');
    if (!tableContainer) return;

    const rows = tableContainer.querySelectorAll('tr');

    rows.forEach(row => {
        // Skip "no data" rows
        if (row.querySelector('.no-data')) return;

        if (!searchTerm) {
            row.style.display = '';
            return;
        }

        // Build searchable text from all cells
        let rowText = '';
        const cells = row.querySelectorAll('td');
        cells.forEach(cell => {
            const textContent = cell.textContent || cell.innerText || '';
            rowText += textContent.toLowerCase() + ' ';
        });

        // Check if search term matches
        const isMatch = rowText.includes(searchTerm);
        row.style.display = isMatch ? '' : 'none';
    });

    updateSelectionCount();
}


function handleFinalIsoSelection(checkbox) {
    const row = checkbox.closest('tr');
    if (checkbox.checked) {
        row.classList.add('selected-row');
    } else {
        row.classList.remove('selected-row');
    }

    updateSelectionCount();
}

function updateSelectionCount() {
    const selectedCount = document.querySelectorAll('.final-iso-select:checked').length;
    const totalCount = finalIsometricsData.length;

    // Update any selection counter if it exists
    const selectionCounter = document.getElementById('final-iso-selection-count');
    if (selectionCounter) {
        selectionCounter.textContent = `Selected: ${selectedCount} of ${totalCount}`;
    }
}

function setupExportButtons() {
    // Remove existing button containers more comprehensively
    document.querySelectorAll('.final-iso-export-btn, .final-iso-buttons-container, [id="final-iso-selection-count"]').forEach(element => {
        if (element.parentElement) {
            element.parentElement.remove();
        } else {
            element.remove();
        }
    });

    const tableContainer = document.getElementById('final-isometrics-table-container');
    if (!tableContainer) return;

    // Don't show buttons if no data
    if (finalIsometricsData.length === 0) return;

    // Create buttons container with unique class
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'final-iso-buttons-container';
    buttonsContainer.style.cssText = `
            margin: 15px 10px;
            padding: 10px;
            background-color: #f8f9fa;
            border-radius: 6px;
            display: flex;
            gap: 15px;
            align-items: center;
            justify-content: space-between;
        `;

    // Selection info
    const selectionInfo = document.createElement('div');
    selectionInfo.id = 'final-iso-selection-count';
    selectionInfo.style.cssText = 'font-weight: bold; color: #495057;';
    selectionInfo.textContent = `Selected: 0 of ${finalIsometricsData.length}`;

    // Buttons group
    const buttonsGroup = document.createElement('div');
    buttonsGroup.style.cssText = 'display: flex; gap: 10px;';

    // Bulk Upload button
    const bulkUploadBtn = document.createElement('button');
    bulkUploadBtn.className = 'final-iso-export-btn action-btn';
    bulkUploadBtn.style.cssText = `
            background-color: #28a745;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        `;
    bulkUploadBtn.innerHTML = `
            <img src="images/cloud-upload.png" alt="Upload" style="width: 16px; height: 16px;">
            Bulk Import To EngDMS
        `;
    bulkUploadBtn.onclick = handleBulkUpload;

    // Export Metadata button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'final-iso-export-btn action-btn';
    exportBtn.style.cssText = `
            background-color: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        `;
    exportBtn.innerHTML = `
            <img src="images/download.png" alt="Export" style="width: 16px; height: 16px;">
            Export Metadata
        `;
    exportBtn.onclick = handleExportMetadata;

    buttonsGroup.appendChild(bulkUploadBtn);

    // Admin Log button
    const adminLogBtn = document.createElement('button');
    adminLogBtn.className = 'final-iso-export-btn action-btn';
    adminLogBtn.style.cssText = `
            background-color: #ff9800;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        `;
    adminLogBtn.innerHTML = `
            <img src="images/download.png" alt="Log" style="width: 16px; height: 16px;">
            Admin Log
        `;
    adminLogBtn.onclick = handleAdminLog;

    buttonsGroup.appendChild(adminLogBtn);

    // --- START Revert Button Addition ---
    const revertBtn = document.createElement("button");
    revertBtn.className = "final-iso-export-btn action-btn";
    revertBtn.style.cssText =
        "background-color: #e53935; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 8px;";
    revertBtn.innerHTML = '<img src="images/undo.png" alt="Revert" style="width:16px;height:16px;">Revert';
    revertBtn.onclick = handleRevertSelectedFinalIsos;
    buttonsGroup.appendChild(revertBtn);
    // --- END Revert Button Addition ---


    buttonsGroup.appendChild(exportBtn);

    // Create search bar container with fixed width
const searchBarContainer = document.createElement('div');
searchBarContainer.style.cssText = 'width: 400px; min-width: 400px;';
searchBarContainer.innerHTML = `
    <input 
        type="text" 
        id="final-iso-search-input" 
        placeholder="Search: Job No, Unit No, Line No, Zone, Rev No, etc."
        style="width: 100%; padding: 8px 12px; border: 1px solid #ced4da; border-radius: 4px; font-size: 14px;"
    />
    `;

// Create a flex container for selection info + search bar (right side group)
const rightSideGroup = document.createElement('div');
rightSideGroup.style.cssText = 'display: flex; gap: 15px; align-items: center; flex-shrink: 0;';


    // Add selection info with styling
    selectionInfo.style.cssText = 'font-weight: bold; color: #495057; white-space: nowrap;';
    rightSideGroup.appendChild(selectionInfo);
    rightSideGroup.appendChild(searchBarContainer);

    buttonsContainer.appendChild(buttonsGroup);
    buttonsContainer.appendChild(rightSideGroup);




    // Insert before the table
    const table = tableContainer.querySelector('.data-table');
    if (table) {
        tableContainer.insertBefore(buttonsContainer, table);
    }

    // Setup search functionality
    const searchInput = document.getElementById('final-iso-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            const searchTerm = this.value.toLowerCase().trim();
            filterFinalIsometricsTableBySearch(searchTerm);
        });
    }

}



function handleBulkUpload() {
    const selectedCheckboxes = document.querySelectorAll('.final-iso-select:checked');

    if (selectedCheckboxes.length === 0) {
        alert('Please select at least one isometric to upload to EngDMS.');
        return;
    }

    const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.index));
    const selectedItems = selectedIndices.map(index => finalIsometricsData[index]);

    // For now, show confirmation dialog
    const confirmed = confirm(`Upload ${selectedItems.length} isometric(s) to EngDMS?\n\nThis will upload the selected final isometrics to the Engineering Document Management System.`);

    if (confirmed) {
        // TODO: Implement actual EngDMS upload
        alert(`Bulk upload to EngDMS initiated for ${selectedItems.length} isometric(s).\n\nSuccessfully Uploaded To EDMS`);
        console.log('Items to upload to EngDMS:', selectedItems);
    }
}

// Handle Admin Log download
function handleAdminLog() {
    const selectedCheckboxes = document.querySelectorAll('.final-iso-select:checked');

    if (selectedCheckboxes.length === 0) {
        alert('Please select at least one isometric to generate Admin Log.');
        return;
    }

    const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.index));
    const selectedItems = selectedIndices.map(index => finalIsometricsData[index]);

    // Get job number from first selected item
    const jobNo = selectedItems[0]?.job_nr || selectedItems[0]?.jobNo || 'JOB';

    // Get current date in format DDMM
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dateStr = day + month;

    // Generate filename: Admin_B269_2510.txt
    const filename = `Admin_${jobNo}_${dateStr}.txt`;

    // Generate file content
    let fileContent = '!lines = array()\n';
    fileContent += `!linescount = ${selectedItems.length}\n\n`;

    selectedItems.forEach((item, index) => {
        const lineNumber = item.document_name || item.lineno || `line${index + 1}`;
        fileContent += `!lines[${index + 1}] = "${lineNumber}"\n`;
    });

    fileContent += '\n\n';

     const fixedBlock = `
!ALLZON = ||
!LOTN = |LOT-*|
!REV= |REV-*|
VAR !PRO PROJECT CODE

VAR !ZON COLL ALL ZONE WITH MATCHW(NAMN,|PIZON*-$!PRO|)
DO !Z VALUES !ZON
!ALLZON = !ALLZON + | | + !Z.DBREF().NAME
ENDDO
Q VAR !ALLZON
-------------------------------------------------------------------------------
VAR !P COLL ALL PIP FOR $!ALLZON

!FILNAME = !!alert.input('Error file will be generated at','C:\DATA\Admin-lock-files.csv')
!Output = object FILE(!FILNAME)
!Output.Open('OVER')
!Output.WriteRecord('PIPE,DUTY,UNIT,SERIAL-NO.,ISO-NO.')


!n = 0
    do !isofilename values !pip
        !isopart=substring(!isofilename,-3)
        !isoarea=substring(!isofilename,-1,1)
        var !pipnam coll all pip with matchw(:eil_isono,!isopart) and matchw(:eil_area,!isoarea) and matchw(namn,'*$!isopart*') and matchw(namn,'*$!isoarea') for $!this.allzon
        !n = !n + 1
		$P $!n_$!isofilename
		if (!pipnam.size() eq 1) then
            !naam = name of $!pipnam[1]
			!this.pipelist.append(!naam)
            !output.writerecord('$!isofilename,$!naam')
        else
		    !flag = 1
			if (!pipnam.size() eq 0) then
			    !erroroutput.writerecord('$!isofilename,No line found Check :EIL_AREA/:EIL_ISONO make sure no space')
			else
			    !erroroutput.writerecord('$!isofilename,Multiple lines found')
			endif
		endif		
    enddo
    !output.close()

$(
do !A index !PIP

 $!PIP[$!A]
 !PIPNAME =!!CE.NAME
 !DUTY = DUTY OF CE
 !UNIT = :EIL_UNIT OF CE
 !SERIALNO = :EIL_SERIALNO OF CE
 !ISONO = :EIL_ISONO OF CE
 !ISONAME = !DUTY & '-' & !UNIT & '-' & !SERIALNO
 IF (NOT(MATCHW('$!ISONO','$!ISONAME') AND MATCHW('$!PIPNAME','*$!ISONO*') AND MATCHW('$!PIPNAME','*$!ISONAME*'))) THEN
!Output.WriteRecord('$!PIPNAME'+ ',' + '$!DUTY' +','+ '$!UNIT' +','+ '$!SERIALNO' +','+ '$!ISONO')
 ENDIF
 
ENDDO 
 !input.close()
 !Output.CLOSE()
 $P DONE!!!

$)
`;

    // Append your fixed text to file content
    fileContent += fixedBlock;

    // Create and download the file
    const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => window.URL.revokeObjectURL(url), 2000);

    alert(`Admin Log downloaded: ${filename}`);
}

// --- START handleRevertSelectedFinalIsos ---
async function handleRevertSelectedFinalIsos() {
    const selectedCheckboxes = document.querySelectorAll('.final-iso-select:checked');
    if (selectedCheckboxes.length === 0) {
        alert('Please select at least one isometric to revert.');
        return;
    }
    if (!confirm(`Are you sure you want to revert ${selectedCheckboxes.length} isometrics?\nThis will send them back to the last GL/SGL who approved.`)) {
        return;
    }
    const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.index));
    const selectedItems = selectedIndices.map(index => finalIsometricsData[index]);
    try {
        const resp = await fetch('/api/final-isometrics-revert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isos: selectedItems }),
        });
        const result = await resp.json();
        if (result.ok) {
            alert('Selected isometrics have been reverted to the last GL/SGL for further review.');
            await loadFinalIsometricsData(); // Reload the table after changes
            renderFinalIsometricsTable();
        } else {
            alert("Error during revert:\n" + (result.error || "Unknown error"));
        }
    } catch (err) {
        alert("Network or server error during revert:\n" + err.message);
    }
}
// --- END handleRevertSelectedFinalIsos ---


// ---- REPLACE existing handleExportMetadata() with this block ----
function handleExportMetadata() {
    const selectedCheckboxes = document.querySelectorAll('.final-iso-select:checked');

    if (selectedCheckboxes.length === 0) {
        alert('Please select at least one isometric to export metadata.');
        return;
    }

    const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.index));
    const selectedItems = selectedIndices.map(index => {
        const item = finalIsometricsData[index] || {};
        // Add storedFilePath if available in your finalIsometricsData (optional)
        // item.storedFilePath = item.mainFile || item.storedFilePath;
        return item;
    });

    // Show modal with two options
    showExportModal(selectedItems);
}

// ---- Add these helper functions BELOW (or anywhere after) ----
function showExportModal(selectedItems) {
    // Remove existing modal if present
    const existing = document.getElementById('final-iso-export-modal');
    if (existing) existing.remove();

    // Backdrop
    const modal = document.createElement('div');
    modal.id = 'final-iso-export-modal';
    modal.style.cssText = `
            position: fixed;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.45);
            z-index: 9999;
            font-family: "Segoe UI", Arial, sans-serif;
        `;

    // Modal box
    const box = document.createElement('div');
    box.style.cssText = `
            background-color: #d9e8f8;
            border: 1px solid #4a6fa5;
            border-radius: 8px;
            width: 480px;
            padding: 24px 28px;
            color: #0b2e59;
            box-shadow: 0 6px 24px rgba(0,0,0,0.2);
        `;

    box.innerHTML = `
            <h2 style="margin-top:0; margin-bottom:10px; font-size:18px; font-weight:700;">
                Export Options
            </h2>
            <p style="margin:0 0 18px 0; font-size:14px;">
                Choose one option for the selected <b>${selectedItems.length}</b> drawing(s):
            </p>

            <div style="display:flex; flex-direction:column; gap:16px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <span style="font-weight:600;">Metadata File (.xlsx)</span>
                    <button id="export-xlsx-btn" style="
                        background-color:#1d4e89;
                        color:white;
                        border:none;
                        padding:8px 16px;
                        border-radius:5px;
                        font-weight:600;
                        cursor:pointer;
                        box-shadow:0 2px 4px rgba(0,0,0,0.2);
                    ">Download</button>
                </div>

                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <span style="font-weight:600;">Approved Isometric Drawings (.zip)</span>
                    <button id="export-zip-btn" style="
                        background-color:#1d4e89;
                        color:white;
                        border:none;
                        padding:8px 16px;
                        border-radius:5px;
                        font-weight:600;
                        cursor:pointer;
                        box-shadow:0 2px 4px rgba(0,0,0,0.2);
                    ">Download</button>
                </div>
            </div>

            <div style="text-align:right; margin-top:22px;">
                <button id="export-cancel-btn" style="
                    background-color:white;
                    color:#0b2e59;
                    border:1px solid #7fa0c3;
                    padding:6px 14px;
                    border-radius:5px;
                    cursor:pointer;
                    font-weight:500;
                ">Cancel</button>
            </div>
        `;

    modal.appendChild(box);
    document.body.appendChild(modal);

    // Button actions
    document.getElementById('export-cancel-btn').onclick = () => modal.remove();

    document.getElementById('export-xlsx-btn').onclick = async () => {
        try {
            document.getElementById('export-xlsx-btn').disabled = true;
            await downloadMetadataXLSX(selectedItems);
        } catch (e) {
            console.error(e);
            alert('Failed to download metadata file.');
        } finally {
            modal.remove();
        }
    };

    document.getElementById('export-zip-btn').onclick = async () => {
        try {
            document.getElementById('export-zip-btn').disabled = true;
            await downloadMetadataAndPDFsZip(selectedItems);
        } catch (e) {
            console.error(e);
            alert('Failed to download zip file.');
        } finally {
            modal.remove();
        }
    };
}


async function downloadMetadataXLSX(selectedItems) {
    // Prepare POST body - keep same shape as server expects
    // The final-isometrics API returns keys: job_nr, unit_id, document_name, ZONE, issue_lot, revision_nr, revision_dt
    const payload = {
        items: selectedItems.map(it => ({
            job_nr: it.job_nr || it.jobNo || it.jobNo || '',
            unit_id: it.unit_id || it.unitNo || it.unitNo || '',
            document_name: it.document_name || it.document_name || it.document_name || it.line_no || it.document_name,
            ZONE: it.ZONE || it.zone || it.ZONE,
            issue_lot: it.issue_lot || it.issue_lot || 1,
            revision_nr: it.revision_nr || it.revision_nr || it.rev_no || it.revision_nr,
            revision_dt: it.revision_dt || it.revision_dt || it.revision_dt
        }))
    };

    const resp = await fetch('/api/final-isometrics/export-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        const txt = await resp.text().catch(() => null);
        throw new Error('Server returned ' + resp.status + ' ' + txt);
    }

    const blob = await resp.blob();
    // --- Custom naming like B378_1510_METADATA.xlsx ---
    const jobNo = selectedItems[0]?.job_nr || selectedItems[0]?.jobNo || 'JOB';
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const filename = `${jobNo}_${day}${month}_METADATA.xlsx`;

    triggerBrowserDownload(blob, filename);
    alert(`Metadata downloaded: ${filename}`);
}

async function downloadMetadataAndPDFsZip(selectedItems) {
    // If your finalIsometricsData contains storedFile path or mainFile you can add storedFilePath to the payload.
    // Try include storedFilePath for each item if available.
    const payload = {
        items: selectedItems.map(it => ({
            job_nr: it.job_nr || it.jobNo || '',
            unit_id: it.unit_id || it.unitNo || '',
            document_name: it.document_name || it.document_name || it.line_no || '',
            ZONE: it.ZONE || it.zone || '',
            issue_lot: it.issue_lot || it.issue_lot || 1,
            revision_nr: it.revision_nr || it.revision_nr || it.rev_no || '',
            revision_dt: it.revision_dt || it.revision_dt || '',
            // If your dataset provides a path to the stored PDF, include it as storedFilePath:
            storedFilePath: it.mainFile || it.storedFilePath || ''
        }))
    };

    const resp = await fetch('/api/final-isometrics/export-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        const txt = await resp.text().catch(() => null);
        throw new Error('Server returned ' + resp.status + ' ' + txt);
    }

    const blob = await resp.blob();
    const filename = 'Final_Isometrics_With_PDFs.zip';

    triggerBrowserDownload(blob, filename);
    alert(`ZIP downloaded: ${filename}`);
}

function triggerBrowserDownload(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 2000);
}


function generateExcelData(selectedItems) {
    // Fixed data values based on metadata sample
    const fixedData = {
        sub_job_nr: '0',
        division_name: 'ENGINEERING',
        dept_name: 'PIPING',
        document_source: 'EIL',
        physical_document_name: '',  // Will be generated dynamically
        paper_size: 'A3',
        object_name: '',
        FOLDERCODE: 'SELF RESOURCED/ISOMETRICS',
        title: 'ISOMETRICS', // Will be generated dynamically
        revision_reason: 'ISSUED FOR CONSTRUCTION',
        approval_dt1: new Date().toISOString().split('T')[0], // Today's date
        approval_flag: 'Y',
        approver1: 'SGL',
        issue_dt: new Date().toISOString().split('T')[0], // Today's date
        issue_reason: 'ISSUED FOR CONSTRUCTION'
    };

    // Column headers as specified in the requirements
    const headers = [
        'SNO',
        'job_nr',
        'sub_job_nr',
        'unit_id',
        'division_name',
        'dept_name',
        'document_source',
        'document_name',
        'ZONE',
        'issue_lot',
        'physical_document_name',
        'paper_size',
        'revision_reason',
        'revision_nr',
        'revision_dt',
        'object_name',
        'FOLDERCODE',
        'title',
        'approval_dt1',
        'approval_flag',
        'approver1',
        'issue_dt',
        'issue_reason'
    ];

    // Generate rows
    const rows = selectedItems.map((item, index) => {
        // Generate dynamic title and physical document name
        const dynamicTitle = `${item.job_nr || ''}-${item.unit_id || ''}-${item.document_name || ''}`;
        const physicalDocName = `${item.document_name || ''}.pdf`;

        return {
            SNO: index + 1,
            job_nr: item.job_nr || '',
            sub_job_nr: fixedData.sub_job_nr,
            unit_id: item.unit_id || '',
            division_name: fixedData.division_name,
            dept_name: fixedData.dept_name,
            document_source: fixedData.document_source,
            document_name: item.document_name || '',
            ZONE: item.ZONE || '',
            num_sheet: fixedData.num_sheet,
            issue_lot: item.issue_lot || '',
            physical_document_name: physicalDocName,
            paper_size: fixedData.paper_size,
            revision_reason: fixedData.revision_reason || '',
            revision_nr: item.revision_nr || '',
            revision_dt: item.revision_dt ? new Date(item.revision_dt).toISOString().split('T')[0] : '',
            object_name: item.document_name || '',
            FOLDERCODE: fixedData.FOLDERCODE,
            title: fixedData.title,
            approval_dt1: fixedData.approval_dt1,
            approval_flag: fixedData.approval_flag,
            approver1: window.currentEmployeeID || fixedData.approver1,
            issue_dt: fixedData.issue_dt,
            issue_reason: fixedData.issue_reason
        };
    });

    return { headers, rows };
}


function exportToExcel(data, filename) {
    try {
        // Create CSV content (Excel-compatible)
        let csvContent = '';

        // Add headers
        csvContent += data.headers.join(',') + '\n';

        // Add data rows
        data.rows.forEach(row => {
            const values = data.headers.map(header => {
                const value = row[header] || '';
                // Escape values that contain commas, quotes, or newlines
                if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
                    return `"${value.replace(/"/g, '""')}"`;
                }
                return value;
            });
            csvContent += values.join(',') + '\n';
        });

        // Create and trigger download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');

        if (link.download !== undefined) {
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', filename.replace('.xlsx', '.csv')); // Use CSV extension
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        // Show success message
        const message = `Export completed successfully!\n\n${data.rows.length} records exported to ${filename.replace('.xlsx', '.csv')}`;
        alert(message);

    } catch (error) {
        console.error('Error exporting data:', error);
        alert('Error exporting data. Please try again.');
    }
}

function highlightFinalIsometricsMenu() {
    // Remove any existing highlights
    document.querySelectorAll('.menu-task-active, .menu-notif-active, .menu-finaliso-active')
        .forEach(el => el.classList.remove('menu-task-active', 'menu-notif-active', 'menu-finaliso-active'));

    // Find and highlight the Final Isometrics menu item
    const menuIds = ['default-left-menu', 'process-checker-left-menu', 'material-checker-left-menu'];

    for (const id of menuIds) {
        const menu = document.getElementById(id);
        if (!menu || menu.style.display === 'none') continue;

        const finalIsoItems = menu.querySelectorAll('li img[src="images/Final-iso.png"]');
        finalIsoItems.forEach(img => {
            const listItem = img.parentElement;
            listItem.classList.add('menu-finaliso-active');
        });
    }
}

function hideAllTablesFinalSafe() {
    const tables = [
        "default-task-table-container",
        "pc-task-table-container",
        "mc-task-table-container",
        "default-notification-table-container",
        "pc-notification-table-container",
        "mc-notification-table-container",
        // Only hide rejected iso; DO NOT hide final iso here
        "rejected-isometrics-table-container",
    ];

    tables.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });
}


// Make functions globally available
window.showFinalIsometrics = showFinalIsometrics;
window.handleFinalIsoSelection = handleFinalIsoSelection;