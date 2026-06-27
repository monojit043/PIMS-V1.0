"use strict";
const fs   = require("fs");
const path = require("path");
const url  = require("url");

// ── pdfjs-dist (ESM) — loaded once, cached ───────────────────────────────────
let _pdfjs = null;
async function getPdfJs() {
  if (!_pdfjs) {
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Point to the bundled worker file using a proper file:// URL (required on Windows)
    lib.GlobalWorkerOptions.workerSrc = url.pathToFileURL(
      path.resolve(__dirname, "..", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs")
    ).href;
    _pdfjs = lib;
  }
  return _pdfjs;
}

// ── Patterns ──────────────────────────────────────────────────────────────────
// Full ISO piping tag: {size}"-{service}-{unitNo}-{seqNo}-{spec}-{insulType}-{zone}
// e.g.  8"-P-111-40201-B1A-NI-B   or   1.5"-F-201-10023-A11A-HI-A
const ISO_TAG_RE = /^(\d+(?:[./]\d+)?)"- ?([A-Z]+)-(\d+)-(\d+)-([A-Z0-9]+)-([A-Z]+)-([A-Z]{1,2})$/i;

// System line_no decomposition: {service}-{unitNo}-{seqNo}[-{subline}]-{zone}
// ISOGEN's printed ISO_TAG_RE tag has NO subline slot, so coreId comparisons
// against the PDF tag must strip an optional subline along with the zone —
// otherwise every subline'd line falsely fails the core-ID match below.
const SYS_CORE_RE = /^([A-Za-z]+)-(\d+)-(\w+?)(?:-([A-Za-z0-9]{1,3}))?-([A-Za-z]{1,2})$/i;

// Header text that identifies the start of a weld table
// WD = EIL (Engineers India Limited) ISO inspection strip column header
const WELD_HDR = /^(WELD|W\.?NO\.?|WELD\s*NO\.?|WLD\.?|JOINT|JT\.?NO\.?|WELD\s*DETAIL|WELD\s*TABLE|WD)$/i;
// Valid weld types used in piping
// S/F = EIL format: S=shop weld, F=field weld (in the SW column of EIL inspection strip)
const WELD_TYPE = /^(FW|SW|BW|HW|EW|GW|S|F)$/i;
// An integer that could be a weld number (1–999)
const INT_1_999 = /^\d{1,3}$/;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a PDF file and extract structured text content.
 * Returns: { ok, pageCount, pages:[{pageNo, items:[{str,x,y,w,h}]}], metadata, hash }
 */
async function parsePdf(filePath) {
  const pdfjsLib  = await getPdfJs();
  const fileBuffer = fs.readFileSync(filePath);
  const data       = new Uint8Array(fileBuffer);

  const pdf       = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
  const pageCount  = pdf.numPages;
  const pages      = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page        = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const items = textContent.items
      .filter(i => i.str && i.str.trim().length > 0)
      .map(i => ({
        str: i.str.trim(),
        x:   Math.round(i.transform[4]),
        y:   Math.round(i.transform[5]),
        w:   Math.round(i.width  || 0),
        h:   Math.round(i.height || 0),
      }));

    pages.push({ pageNo: pageNum, items });
  }

  let metadata = {};
  try {
    const meta = await pdf.getMetadata();
    metadata = {
      title:        meta.info?.Title        || null,
      creator:      meta.info?.Creator      || null,
      producer:     meta.info?.Producer     || null,
      creationDate: meta.info?.CreationDate || null,
    };
  } catch (_) {}

  return { ok: true, pageCount, pages, metadata };
}

/**
 * Search all pages for the line number stored in the system.
 * Returns: { found, extractedText, parsed }
 *
 * parsed is populated when a full ISO tag is found and decoded:
 *   { rawTag, size, sizeNum, service, unitNo, seqNo, spec, insulType, zone }
 * parsed is null when found only via plain text match (fallback path).
 *
 * Strategy:
 *   1. Scan every token for a full ISO piping tag whose coreId matches the system line_no
 *   2. Exact token match against system line_no (fallback)
 *   3. Substring match in concatenated page text (fallback)
 */
function extractLineNo(pages, candidateLineNo) {
  if (!candidateLineNo) return { found: false, extractedText: null, parsed: null };

  const needle   = candidateLineNo.trim();
  const needleLc = needle.toLowerCase();

  // Derive coreId from system line_no: strip trailing zone AND optional subline
  // P-111-40201-B → coreId = P-111-40201
  // TRM-111-VV1227-VS-A → coreId = TRM-111-VV1227  (subline "VS" dropped — ISOGEN tags never carry it)
  const sysCoreM  = SYS_CORE_RE.exec(needle);
  const sysCoreId = (sysCoreM ? `${sysCoreM[1]}-${sysCoreM[2]}-${sysCoreM[3]}` : needle).toLowerCase();

  // ── Pass 1: find a full ISO tag token whose coreId matches ───────────────
  for (const page of pages) {
    for (const item of page.items) {
      const m = ISO_TAG_RE.exec(item.str);
      if (!m) continue;
      const [, rawSize, service, unitNo, seqNo, spec, insulType, zone] = m;
      const pdfCoreId = `${service}-${unitNo}-${seqNo}`.toLowerCase();
      if (pdfCoreId === sysCoreId) {
        return {
          found:         true,
          extractedText: item.str,
          parsed: {
            rawTag:    item.str,
            size:      rawSize + '"',
            sizeNum:   _normSize(rawSize),
            service:   service.toUpperCase(),
            unitNo,
            seqNo,
            spec:      spec.toUpperCase(),
            insulType: insulType.toUpperCase(),
            zone:      zone.toUpperCase(),
          },
        };
      }
    }
  }

  // ── Pass 2: exact token match or substring in page text (fallback) ───────
  for (const page of pages) {
    for (const item of page.items) {
      if (item.str.toLowerCase() === needleLc) {
        return { found: true, extractedText: item.str, parsed: null };
      }
    }
    const pageText = page.items.map(i => i.str).join(" ");
    if (pageText.toLowerCase().includes(needleLc)) {
      return { found: true, extractedText: needle, parsed: null };
    }
  }

  return { found: false, extractedText: null, parsed: null };
}

// Normalize a size string to a float — handles "8", "8\"", "1.5\"", "3/4\""
function _normSize(sizeStr) {
  const s = String(sizeStr).replace(/"/g, "").trim();
  if (s.includes("/")) {
    const [num, den] = s.split("/").map(Number);
    return den ? num / den : NaN;
  }
  return parseFloat(s);
}

/**
 * Extract weld table entries from all pages.
 * Returns: [{ weldNo:int, weldType:string|null, sheetNo:int, method:string }]
 *
 * Tries two strategies per page:
 *   COORDINATE — find WELD header, use column positions to extract rows below it
 *   PATTERN    — scan token stream after WELD header for integer+type pairs
 */
function extractWeldTable(pages) {
  const allWelds = [];

  for (const page of pages) {
    const pageWelds = _extractFromPage(page.items, page.pageNo);
    allWelds.push(...pageWelds);
  }

  // Remove exact duplicates (same weld_no AND same sheet_no)
  const seen = new Set();
  return allWelds.filter(w => {
    const key = `${w.weldNo}|${w.sheetNo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _extractFromPage(items, pageNo) {
  if (items.length === 0) return [];

  // Strategy 1: coordinate-based (preferred — works well for CAD/Isogen PDFs)
  const coordWelds = _extractByCoordinates(items, pageNo);
  if (coordWelds.length > 0) return coordWelds;

  // Strategy 2: token-stream pattern scan (fallback for unusual layouts)
  return _extractByPattern(items, pageNo);
}

// ── Strategy 1: Coordinate-based ─────────────────────────────────────────────

function _extractByCoordinates(items, pageNo) {
  const rows = _groupIntoRows(items, 4);

  // Find the row that contains a WELD header item
  const hdrRowIdx = rows.findIndex(r => r.items.some(i => WELD_HDR.test(i.str)));
  if (hdrRowIdx === -1) return [];

  const hdrRow = rows[hdrRowIdx];
  const hdrY   = hdrRow.y;

  // Determine column X for weld number and for type
  const weldHdrItem = hdrRow.items.find(i => WELD_HDR.test(i.str));
  // TYPE = standard column header; SW = EIL format (shop/field weld column)
  const typeHdrItem = hdrRow.items.find(i => /^(TYPE|SW)$/i.test(i.str));
  const weldColX    = weldHdrItem ? weldHdrItem.x : null;
  const typeColX    = typeHdrItem ? typeHdrItem.x : null;

  // Items physically below the header row (lower Y in PDF space = lower on page)
  const below = items.filter(i => i.y < hdrY - 3);
  if (below.length === 0) return [];

  const dataRows = _groupIntoRows(below, 4);
  const welds    = [];

  const COL_TOLERANCE = 80; // px — restrict candidates to their column's x range when known

  for (const row of dataRows) {
    // Candidate integer items in this row — restrict to weld-number column area if column x known
    const numItems  = weldColX !== null
      ? row.items.filter(i => INT_1_999.test(i.str) && parseInt(i.str, 10) >= 1 && Math.abs(i.x - weldColX) <= COL_TOLERANCE)
      : row.items.filter(i => INT_1_999.test(i.str) && parseInt(i.str, 10) >= 1);
    const typeItems = typeColX !== null
      ? row.items.filter(i => WELD_TYPE.test(i.str) && Math.abs(i.x - typeColX) <= COL_TOLERANCE)
      : row.items.filter(i => WELD_TYPE.test(i.str));

    if (numItems.length === 0) continue;

    // Pick the integer closest to the weld-number column (if column position known)
    let numItem = numItems[0];
    if (weldColX !== null && numItems.length > 1) {
      numItem = numItems.reduce((best, it) =>
        Math.abs(it.x - weldColX) < Math.abs(best.x - weldColX) ? it : best
      );
    }

    // Pick the type item closest to the type column
    let typeItem = typeItems[0] || null;
    if (typeColX !== null && typeItems.length > 1) {
      typeItem = typeItems.reduce((best, it) =>
        Math.abs(it.x - typeColX) < Math.abs(best.x - typeColX) ? it : best
      );
    }

    const n = parseInt(numItem.str, 10);
    if (n >= 1 && n <= 999) {
      welds.push({
        weldNo:   n,
        weldType: typeItem ? typeItem.str.toUpperCase() : null,
        sheetNo:  pageNo,
        method:   "COORDINATE",
      });
    }
  }

  return welds;
}

// ── Strategy 2: Pattern scan ──────────────────────────────────────────────────

function _extractByPattern(items, pageNo) {
  // Sort in reading order: top-to-bottom (Y desc), left-to-right (X asc)
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(b.y - a.y) > 4) return b.y - a.y;
    return a.x - b.x;
  });
  const tokens = sorted.map(i => i.str);

  // Find first WELD header index
  const hdrIdx = tokens.findIndex(t => WELD_HDR.test(t));
  if (hdrIdx === -1) return [];

  const welds    = [];
  let lastInt    = null;
  let gapCount   = 0;
  const MAX_GAP  = 6;   // allow up to 6 non-matching tokens between table items
  const SCAN_WIN = 600; // only look at tokens within this window after the header

  const end = Math.min(hdrIdx + 1 + SCAN_WIN, tokens.length);

  for (let i = hdrIdx + 1; i < end; i++) {
    const t = tokens[i];

    if (INT_1_999.test(t)) {
      const n = parseInt(t, 10);
      if (n >= 1 && n <= 999) {
        // If a previous integer is waiting without a type, record it with null type
        if (lastInt !== null) {
          welds.push({ weldNo: lastInt, weldType: null, sheetNo: pageNo, method: "PATTERN" });
        }
        lastInt  = n;
        gapCount = 0;
        continue;
      }
    }

    if (WELD_TYPE.test(t)) {
      if (lastInt !== null) {
        welds.push({ weldNo: lastInt, weldType: t.toUpperCase(), sheetNo: pageNo, method: "PATTERN" });
        lastInt  = null;
        gapCount = 0;
      }
      continue;
    }

    // Non-matching token
    gapCount++;
    if (gapCount >= MAX_GAP) {
      if (lastInt !== null) {
        welds.push({ weldNo: lastInt, weldType: null, sheetNo: pageNo, method: "PATTERN" });
        lastInt = null;
      }
      gapCount = 0;
    }
  }

  // Flush any remaining pending integer
  if (lastInt !== null && welds.length > 0) {
    welds.push({ weldNo: lastInt, weldType: null, sheetNo: pageNo, method: "PATTERN" });
  }

  return welds;
}

// ── Utility: group text items into rows by Y coordinate ───────────────────────

function _groupIntoRows(items, tolerance) {
  if (items.length === 0) return [];

  // Sort top-to-bottom (Y desc), then left-to-right (X asc) within same row
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(b.y - a.y) > tolerance) return b.y - a.y;
    return a.x - b.x;
  });

  const rows = [];
  let currentRow = null;

  for (const item of sorted) {
    if (!currentRow || Math.abs(item.y - currentRow.y) > tolerance) {
      currentRow = { y: item.y, items: [item] };
      rows.push(currentRow);
    } else {
      currentRow.items.push(item);
    }
  }

  return rows;
}

// ── Pipe schedule extraction ──────────────────────────────────────────────────
//
// Reads four title-block fields that ISOGEN prints on EVERY sheet:
//   PIPE NS (IN)            — nominal bore in inches       (same on all sheets)
//   CURVILINEAR LENGTH (M)  — centre-line pipe length (m) for this sheet
//   INCH DIA:               — inch-dia units for this sheet (size × weld count)
//   INCH MTR:               — inch-metre for this sheet    (size × pipe length)
//
// Also reads the PIPE row from the BOM table on each sheet:
//   item code from the ITEM CODE column
//   description from the COMPONENT DESCRIPTION column (two-line, merged)
//   quantity from the QTY column (e.g. "29.5 M" → 29.5)
//
// All numeric fields are SUMMED across pages. PIPE NS (IN) is taken from the
// first page (it is the same on every sheet of a single-line ISO).
//
// Returns { pipeNsIn, curvLengthM, inchDia, inchMeter, bomPipeItems[] }
//   bomPipeItems: [{ itemCode, description, qtyM }] — one per unique item code

function extractPipeSchedule(pages) {
  let pipeNsIn    = null;
  let curvLengthM = 0;
  let inchDia     = 0;
  let inchMeter   = 0;
  const bomMap    = new Map();   // itemCode → { itemCode, description, qtyM }

  for (const page of pages) {
    const its = page.items;

    // ── Title block fields ────────────────────────────────────────────────────
    // Each label + its value occupy the same visual row (y difference ≤ 3 px).
    // Value token is to the RIGHT of the label, in the left portion of the page.

    const nsVal  = _labelValue(its, 'PIPE NS (IN)',          0, 400);
    const clVal  = _labelValue(its, 'CURVILINEAR LENGTH (M)', 0, 400);
    const idVal  = _labelValue(its, 'INCH DIA:',              0, 370);
    const imVal  = _labelValue(its, 'INCH MTR:',            340, 700);

    if (nsVal  != null && pipeNsIn == null) pipeNsIn = nsVal;
    if (clVal  != null) curvLengthM += clVal;
    if (idVal  != null) inchDia     += idVal;
    if (imVal  != null) inchMeter   += imVal;

    // ── BOM pipe entries ──────────────────────────────────────────────────────
    // BOM header row contains "ITEM CODE" and "QTY" as separate tokens.
    // Pipe rows appear just below the "PIPE" section label and have a description
    // starting "PIPE," in the description column (x ≈ 175-200).
    _extractBomPipeRows(its).forEach(row => {
      const existing = bomMap.get(row.itemCode);
      if (existing) {
        existing.qtyM += row.qtyM || 0;
      } else {
        bomMap.set(row.itemCode, { ...row });
      }
    });
  }

  return {
    pipeNsIn,
    curvLengthM: _round3(curvLengthM),
    inchDia:     _round4(inchDia),
    inchMeter:   _round4(inchMeter),
    bomPipeItems: [...bomMap.values()],
  };
}

// Returns the numeric value token to the right of a label on the same visual row.
// xMin/xMax constrain the search to avoid picking up tokens from adjacent sections.
function _labelValue(items, labelText, xMin, xMax) {
  const label = items.find(it =>
    it.str === labelText && it.x >= xMin && it.x <= xMax
  );
  if (!label) return null;

  const value = items
    .filter(it =>
      it.y >= label.y - 3 && it.y <= label.y + 3 &&   // same row
      it.x > label.x + (label.w || 0) &&               // right of label
      it.x < xMax + 50 &&                              // not too far right
      /^\d+(\.\d+)?$/.test(it.str)                     // numeric
    )
    .sort((a, b) => a.x - b.x)[0];   // leftmost (closest to label)

  return value ? parseFloat(value.str) : null;
}

// Returns pipe BOM rows for one page: [{ itemCode, description, qtyM }]
function _extractBomPipeRows(items) {
  // Locate BOM header — must have both "ITEM CODE" and "QTY" tokens
  const itemCodeHdr = items.find(it => it.str === 'ITEM CODE');
  const qtyHdr      = items.find(it => it.str === 'QTY');
  if (!itemCodeHdr || !qtyHdr) return [];

  const hdrY      = itemCodeHdr.y;
  const itemCodeX = itemCodeHdr.x;
  const qtyX      = qtyHdr.x;

  // Find rows below the header that start a PIPE entry (description starts "PIPE,")
  const YSLACK = 3;
  const pipeDescRows = items.filter(it =>
    it.y < hdrY - YSLACK &&         // below BOM header
    it.y > hdrY - 300 &&            // within BOM section (not too far down)
    /^PIPE,\s+/i.test(it.str) &&    // description starts with "PIPE, "
    it.x >= 160 && it.x <= 250      // description column range
  );

  const result = [];

  for (const descRow of pipeDescRows) {
    const rowY = descRow.y;

    // Item code: token in ITEM CODE column at same y
    const codeItem = items
      .filter(it =>
        Math.abs(it.y - rowY) <= YSLACK &&
        Math.abs(it.x - itemCodeX) <= 60
      )
      .sort((a, b) => Math.abs(a.x - itemCodeX) - Math.abs(b.x - itemCodeX))[0];

    // Quantity: "29.5 M" token in QTY column at same y
    const qtyItem = items
      .filter(it =>
        Math.abs(it.y - rowY) <= YSLACK &&
        Math.abs(it.x - qtyX) <= 60
      )
      .sort((a, b) => Math.abs(a.x - qtyX) - Math.abs(b.x - qtyX))[0];

    // Continuation line(s): description overflows to the line immediately below
    const contLines = items
      .filter(it =>
        it.y < rowY && it.y >= rowY - 15 &&
        it.x >= 185 && it.x <= 400 &&
        it.str !== descRow.str
      )
      .sort((a, b) => b.y - a.y)   // top-down within range
      .map(it => it.str);

    const fullDesc = [descRow.str, ...contLines].join(' ').trim();
    const qtyM     = qtyItem ? parseFloat(qtyItem.str) || null : null;

    result.push({
      itemCode:    codeItem ? codeItem.str.trim() : '',
      description: fullDesc,
      qtyM:        qtyM || 0,
    });
  }

  return result;
}

function _round3(v) { return Math.round(v * 1000) / 1000; }
function _round4(v) { return Math.round(v * 10000) / 10000; }

module.exports = { parsePdf, extractLineNo, extractWeldTable, extractPipeSchedule, SYS_CORE_RE };
