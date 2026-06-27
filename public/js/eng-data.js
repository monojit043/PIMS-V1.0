(function () {
  // Silence any version of loadLinelistDataStrip from cached perform.js
  window.loadLinelistDataStrip   = function () {};
  window._doLoadLinelistDataStrip = function () {};

  var lastKey = null;

  function run() {
    // Find the open task row
    var taskRow = document.querySelector('.task-details-table-container tbody tr');
    if (!taskRow) { lastKey = null; return; }

    var cells  = taskRow.querySelectorAll('td');
    var jobNo  = ((cells[0] && cells[0].textContent) || '').trim();
    var lineNo = ((cells[2] && cells[2].textContent) || '').trim();
    if (!jobNo || !lineNo) { lastKey = null; return; }

    var key = jobNo + '|' + lineNo;
    if (key === lastKey) return;   // already loaded for this task
    lastKey = key;

    // Find or create the strip right after the task table
    var anchor = document.querySelector('.task-details-table-container');
    if (!anchor) return;

    var strip = document.getElementById('ll-data-strip');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'll-data-strip';
      anchor.insertAdjacentElement('afterend', strip);
    }

    strip.style.cssText = 'margin:0 0 16px;border:1px solid #b8d4f8;border-radius:6px;overflow:hidden;';
    strip.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:#555;background:#edf4ff;">Loading line engineering data...</div>';

    fetch(
      '/api/linelist/line-data?jobNo=' + encodeURIComponent(jobNo) +
      '&lineNo=' + encodeURIComponent(lineNo),
      { credentials: 'same-origin' }
    )
    .then(function (r) { return r.json(); })
    .then(function (json) {
      var d = json.data;

      // Re-find strip in case old code removed it; re-insert if needed
      var s = document.getElementById('ll-data-strip');
      if (!s || !s.parentNode) {
        var a = document.querySelector('.task-details-table-container');
        if (!a) return;
        s = document.createElement('div');
        s.id = 'll-data-strip';
        s.style.cssText = 'margin:0 0 16px;border:1px solid #b8d4f8;border-radius:6px;overflow:hidden;';
        a.insertAdjacentElement('afterend', s);
      }

      if (!d) {
        s.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:#555;background:#edf4ff;">No line list data found for this line.</div>';
        return;
      }

      function fmt(v, u) {
        var val = (v || '').toString().trim(), unit = (u || '').toString().trim();
        return val ? (unit ? val + ' ' + unit : val) : '-';
      }

      var rows = [
        ['Design Temp',     fmt(d.design_temp,     d.design_temp_unit),    'Design Press',   fmt(d.design_press,   d.design_press_unit)],
        ['Oper. Temp',      fmt(d.operating_temp,  d.operating_temp_unit), 'Fluid State',    d.fluid_state          || '-'],
        ['Min Design Temp', fmt(d.min_design_temp, d.min_design_temp_unit),'Line Class',     d.line_class           || '-'],
        ['Insulation',      d.insulation           || '-',                  'Ins. Thickness', d.insulation_thickness || '-'],
      ];

      var tbody = rows.map(function (r, i) {
        return '<tr style="' + (i < rows.length - 1 ? 'border-bottom:1px solid #d1e8ff;' : '') + '">' +
          '<td style="padding:8px 14px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:16%;">' + r[0] + '</td>' +
          '<td style="padding:8px 14px;font-size:13px;font-weight:600;color:#1e3a5f;width:34%;border-right:1px solid #d1e8ff;">'                  + r[1] + '</td>' +
          '<td style="padding:8px 14px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;width:16%;">' + r[2] + '</td>' +
          '<td style="padding:8px 14px;font-size:13px;font-weight:600;color:#1e3a5f;width:34%;">'                                                 + r[3] + '</td>' +
          '</tr>';
      }).join('');

      s.innerHTML =
        '<div style="background:#dbeafe;padding:7px 14px;border-bottom:1px solid #b8d4f8;">' +
          '<span style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.8px;">Line Engineering Data</span>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;background:#f0f7ff;"><tbody>' + tbody + '</tbody></table>';
    })
    .catch(function (e) {
      var s = document.getElementById('ll-data-strip');
      if (s) s.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:#b91c1c;background:#fef2f2;">Error: ' + e.message + '</div>';
    });
  }

  // Poll every 400ms — lightweight check, stops re-fetching once key matches
  setInterval(run, 400);
})();
