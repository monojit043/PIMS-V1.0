"use strict";
const fs = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
// Regex patterns
// ─────────────────────────────────────────────────────────────────────────────

// Body component records are identified by 6+ digit coordinates —
// distinguishes them from header config lines (small integers) and
// frame layout lines (4-digit numbers).
const RE_COMP = /^\s{1,6}(\d{1,4})\s{2,}(-?\d{6,})\s+(-?\d{6,})\s+(-?\d{6,})/;
const RE_ATTR = /^\s+(-\d+) (.*)/;
const RE_GEN_DT = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

// ─────────────────────────────────────────────────────────────────────────────
// Known body component record types (used to detect section boundaries)
// ─────────────────────────────────────────────────────────────────────────────
const BODY_REC_TYPES = new Set([
  "35", "36", "42", "47", "90", "93", "100", "105", "107", "108", "110",
  "115", "120", "126", "130", "140", "141", "149", "150", "999",
]);

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parse an IDF file and return structured data for precheck use.
 *
 * Extracts:
 *   lineNo, fullTag, spec, zone, generatedAt  — ISO metadata from header
 *   welds        → Check 1  (weld table)
 *   flowArrows   → Check 2  (flow direction)
 *   bomItems     → Check 3  (BOM table: itemCode + description only, no qty)
 *   nonReportableItems → Check 3a (blank-description or Non-Reportable entries
 *                                  that ARE in the BOM block)
 *   drawingOnlyItems   → Check 3b (body component skeys with NO matching -20
 *                                  entry in BOM — truly in drawing but not BOM)
 *   fittings: [] → Check 5  (populated later: fitting counts by skey + NB)
 *   pipeRuns: [] → Check 6  (populated later: pipe lengths from coordinates)
 *
 * NOTE ON QUANTITY
 * ─────────────────
 * Quantity is NOT present in the IDF BOM block. ISOGEN computes it from
 * geometry at drawing-generation time and never writes it back to the IDF.
 * bomItems therefore carries itemCode + description only.
 * Quantities will be derived in later checks:
 *   • Fitting qty  → Check 5  (count body records by skey + NB)
 *   • Pipe length  → Check 6  (Euclidean distance from type-100 coordinates)
 *   • Weld count   → Check 1  (already done)
 *
 * @param {string} filePath  Absolute path to the .IDF file
 * @param {string} lineNo    System line number, e.g. "AP-111-92202-C"
 */
function parseIdf(filePath, lineNo) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);

  const header = _readHeaderAttrs(lines);
  const welds = _extractWelds(lines, lineNo);
  const flowArrows = _extractFlowArrows(lines);
  const {
    bomItems,
    nonReportableItems,
    drawingOnlyItems,
  } = _extractBom(lines);
  const couplingData = _extractCouplingGaps(lines);

  const dtM = RE_GEN_DT.exec(header["-609"] || "");

  return {
    // ── ISO metadata ──────────────────────────────────────────────────────────
    lineNo: header["-6"] || null,
    fullTag: header["-640"] || null,
    spec: header["-11"] || null,
    zone: header["-642"] || null,
    generatedAt: dtM ? new Date(dtM[1]) : null,

    // ── Check 1: Weld table ───────────────────────────────────────────────────
    welds,

    // ── Check 2: Flow direction ───────────────────────────────────────────────
    flowArrows,

    // ── Check 3: BOM items ────────────────────────────────────────────────────
    bomItems,
    nonReportableItems,
    drawingOnlyItems,

    // ── Check 6: Coupling spacing (applies to lines ≤ 1.5") ──────────────────
    // gaps[]: each segment of pipe between consecutive COSW couplings
    //   { segIdx, lengthMm, overLimit }  where overLimit = lengthMm > 5000
    // couplingCount: number of COSW couplings found
    couplingData,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOM extraction  (Check 3 / 3a / 3b)
// ─────────────────────────────────────────────────────────────────────────────
//
// IDF BOM structure (confirmed from real ISOGEN/Smart3D samples):
//
//   [body section]
//     component records (100, 35, 36, 105, 107, 110, 115, 120, 126, 130, 47 …)
//   -33           ← BOM section separator (may be followed by one stray body record)
//   -36           ← BOM list start marker
//   -20 <code>    ← item code (wraps onto -1 continuation lines)
//   -21 <desc>    ← description (wraps onto -1 continuation lines; may be blank)
//   -20 …         ← next item
//   999 …         ← end record
//
// The -20/-21 pairs after -36 form the complete BOM list.
// Items with blank -21 or code "Non-Reportable" go to nonReportableItems.
//
// drawingOnlyItems:
//   Walk all body records (before -33) and collect unique (skey, recType, nb).
//   Then compare against the set of item codes in the BOM block.
//   Any skey group that has NO corresponding -20 entry → drawingOnlyItem.
//   Matching is by skey because the IDF does not carry a direct body→BOM pointer.

function _extractBom(lines) {
  // ── Step 1: locate BOM section boundary ──────────────────────────────────
  // Rule (confirmed from real IDF samples):
  //   -33 marks end-of-body / BOM start. Some files have TWO -33 tags
  //   (one mid-body spool separator, one at true BOM start) — use the LAST one.
  //   -36 is an optional sub-separator between -33 and the first -20.
  //   When absent, -20 follows -33 directly.
  let bomSepLine = -1;   // last -33 position
  let bomListLine = -1;   // -36 position (if present)

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "-33") { bomSepLine = i; bomListLine = -1; }  // reset on each -33
    if (t === "-36" && bomSepLine !== -1) { bomListLine = i; }
  }
  // If no -36 found after last -33, BOM list starts right at last -33
  if (bomListLine === -1) bomListLine = bomSepLine;

  const bodyEnd = bomSepLine === -1 ? lines.length : bomSepLine;

  // ── Step 2: parse BOM list (-20/-21 pairs after -36) ──────────────────────
  const bomItems = [];
  const nonReportableItems = [];
  const bomCodeSet = new Set();   // all -20 codes, for drawingOnly check

  if (bomListLine !== -1) {
    let i = bomListLine + 1;
    while (i < lines.length) {
      const p = lines[i].trim().split(/\s+/);
      if (!p.length || p[0] === "") { i++; continue; }

      if (p[0] === "-20") {
        // Collect item code (with -1 continuations)
        const codeParts = [p.slice(1).join(" ")];
        let j = i + 1;
        while (j < lines.length) {
          const cl = lines[j].trim().split(/\s+/);
          if (cl[0] === "-1") { codeParts.push(cl.slice(1).join(" ")); j++; }
          else break;
        }
        const itemCode = codeParts.join("").trim();
        bomCodeSet.add(itemCode);

        // Collect description (-21 with -1 continuations)
        const descParts = [];
        if (j < lines.length && lines[j].trim().split(/\s+/)[0] === "-21") {
          const dp = lines[j].trim().split(/\s+/);
          descParts.push(dp.slice(1).join(" "));
          j++;
          while (j < lines.length) {
            const cl = lines[j].trim().split(/\s+/);
            if (cl[0] === "-1") { descParts.push(cl.slice(1).join(" ")); j++; }
            else break;
          }
        }
        const description = descParts.join("").trim();

        // Classify: non-reportable if code is "Non-Reportable" or desc is blank
        const isNonReportable =
          /^non-reportable$/i.test(itemCode) || description === "";

        if (isNonReportable) {
          nonReportableItems.push({ itemCode, description });
        } else {
          bomItems.push({ itemCode, description });
        }

        i = j;
      } else if (RE_COMP.exec(lines[i])) {
        // Stray body record between -33 and -36 — skip silently
        i++;
      } else if (lines[i].trim().startsWith("999")) {
        break;
      } else {
        i++;
      }
    }
  }

  // ── Step 3: collect body component skeys (before -33) ─────────────────────
  // Walk body records, collect unique (skey, recType, nb) groups.
  // Exclude welds (skey "WW"), flow symbols (skey "FLOW"), and
  // continuation/symbol records that are never expected in BOM.
  const SKIP_SKEYS = new Set(["WW", "FLOW", "IIPL", "II**", ""]);
  const SKIP_RECTYPES = new Set(["120", "149", "42", "999"]);

  // Use a map keyed by skey to deduplicate
  const bodySkeyMap = new Map();   // skey → { skey, recType, nb, count }

  for (let i = 0; i < bodyEnd; i++) {
    const m = RE_COMP.exec(lines[i]);
    if (!m) continue;
    const recType = m[1];
    if (SKIP_RECTYPES.has(recType)) continue;

    const leading = lines[i].split(",")[0].trim().split(/\s+/);
    const nbRaw = leading[7] || "0";
    const csvParts = lines[i].split(",");
    const skey = csvParts.length >= 4 ? csvParts[3].trim() : "";

    if (SKIP_SKEYS.has(skey)) continue;

    const key = skey || `rectype_${recType}`;
    if (!bodySkeyMap.has(key)) {
      bodySkeyMap.set(key, { skey, recType, nb: nbRaw, count: 0 });
    }
    bodySkeyMap.get(key).count++;
  }

  // ── Step 4: identify drawing-only items ───────────────────────────────────
  // A skey group is "drawing only" if none of the BOM item codes or
  // descriptions contains a keyword that matches the skey.
  // We use a simple skey→keyword map for matching.
  const SKEY_BOM_KEYWORDS = {
    "ELSW": ["ELBOW"],
    "ELBW": ["ELBOW"],
    "VGSW": ["VLV.GATE"],
    "VLSW": ["VLV.GLOBE"],
    "FLSW": ["FLNG.SW"],
    "FLSO": ["FLNG.SO"],
    "FLWN": ["FLNG.WN"],
    "FLBL": ["FLNG.BLIND"],
    "GASW": ["GASKET"],
    "BOLT": ["BOLT"],
    "TESW": ["TEE", "T.RED"],
    "COSW": ["CAP"],
    "TESW": ["TESW", "TEST"],    // test connection — rarely in BOM
  };

  const allBomDescriptions = [
    ...bomItems.map(b => b.description.toUpperCase()),
    ...nonReportableItems.map(b => b.description.toUpperCase()),
  ];

  const drawingOnlyItems = [];

  for (const [, entry] of bodySkeyMap) {
    const skey = entry.skey;
    const recType = entry.recType;

    // Check if BOM contains a description matching this skey
    const keywords = SKEY_BOM_KEYWORDS[skey] || [skey];
    const foundInBom = allBomDescriptions.some(desc =>
      keywords.some(kw => desc.includes(kw))
    );

    if (!foundInBom) {
      drawingOnlyItems.push({
        skey: skey || `(recType ${recType})`,
        recType,
        nb: entry.nb,
        count: entry.count,
      });
    }
  }

  return { bomItems, nonReportableItems, drawingOnlyItems };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coupling / pipe-spool check  (Check 6)
// ─────────────────────────────────────────────────────────────────────────────
//
// Rule: on lines ≤ 1.5", each individual STRAIGHT pipe spool must be ≤ 5 m.
// Elbows and other fittings are direction-change points — couplings (COSW)
// are placed at the ends of straight runs that approach the 5 m limit.
// We check each type-100 record INDIVIDUALLY, not accumulated across bends.
//
// Length source: -1021 attribute on each type-100 record (1/100 mm units).
// Fallback: Euclidean distance from record coordinates when -1021 is absent.
// Threshold: 5500 mm (5.5 m) — gives 500 mm tolerance for fitting allowances.
//
// Returns { longSpools, couplingCount, totalPipeMm }:
//   longSpools[]  — type-100 records whose length exceeds the threshold:
//                   { spoolIdx, lengthMm }
//   couplingCount — total COSW couplings found in the body
//   totalPipeMm   — sum of all pipe spool lengths (for informational display)

function _extractCouplingGaps(lines) {
  const LIMIT_MM = 5500;   // 5 500 mm = 5.5 m (tolerance for fitting allowances)

  const longSpools = [];
  let couplingCount = 0;
  let totalUnits = 0;
  let spoolIdx = 0;

  let curType = null;
  let curSkey = "";
  let pipe1021 = 0;    // -1021 attribute value for current type-100
  let coordDist = 0;    // Euclidean distance from coordinates (fallback)

  const _flushPipe = () => {
    // Prefer -1021; fall back to coordinate distance
    const lenUnits = pipe1021 > 0 ? pipe1021 : coordDist;
    if (lenUnits <= 0) return;
    const lenMm = lenUnits / 100;
    totalUnits += lenUnits;
    if (lenMm > LIMIT_MM) {
      longSpools.push({ spoolIdx: spoolIdx++, lengthMm: Math.round(lenMm * 10) / 10 });
    } else {
      spoolIdx++;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "-33") break;

    const compM = RE_COMP.exec(lines[i]);
    if (compM) {
      // Flush previous record
      if (curType === "100") _flushPipe();
      if (curSkey === "COSW") couplingCount++;

      // Start new record
      curType = compM[1];
      pipe1021 = 0;
      coordDist = 0;
      const csv = lines[i].split(",");
      curSkey = csv.length >= 4 ? csv[3].trim() : "";

      // Precompute coordinate distance for type-100 records (fallback)
      if (curType === "100") {
        const c = _parseCoords(lines[i]);
        if (c) {
          const dx = c.x2 - c.x1, dy = c.y2 - c.y1, dz = c.z2 - c.z1;
          coordDist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
      }
      continue;
    }

    // Capture -1021 (may be at column 0 or indented)
    if (curType === "100") {
      const m = /^\s*-1021\s+(\d+)/.exec(lines[i]);
      if (m) pipe1021 = parseInt(m[1], 10);
    }
  }

  // Flush final record
  if (curType === "100") _flushPipe();
  if (curSkey === "COSW") couplingCount++;

  return {
    longSpools,
    couplingCount,
    totalPipeMm: Math.round(totalUnits / 100),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weld extraction  (Check 1)  — UNCHANGED from original
// ─────────────────────────────────────────────────────────────────────────────
//
// Walks every 120 (weld) component block in the file.
// Only returns numbered welds (weldNo > 0) that belong to lineNo.
//
// Key field mapping confirmed from real IDF samples:
//   -67   → weld number as printed on the ISO drawing (0 = unnumbered spool weld)
//   -180  → "{lineNo}{weldNo}" — e.g. "AP-111-92202-C20" for weld 20 on this line
//   -181  → sheet number

function _extractWelds(lines, lineNo) {
  const welds = [];
  const lineNoUpper = lineNo.toUpperCase();

  let inWeld = false;
  let attrs = {};
  let coords = null;
  let lastKey = null;

  for (const raw of lines) {
    const compM = RE_COMP.exec(raw);
    if (compM) {
      if (inWeld) {
        const w = _buildWeld(attrs, coords, lineNoUpper);
        if (w) welds.push(w);
      }
      const type = parseInt(compM[1], 10);
      inWeld = (type === 120);
      attrs = {};
      coords = _parseCoords(raw);
      lastKey = null;
      continue;
    }

    if (!inWeld) continue;

    const attrM = RE_ATTR.exec(raw);
    if (!attrM) continue;

    const key = attrM[1];
    const val = attrM[2].trim();
    if (key === "-1") {
      if (lastKey) attrs[lastKey] = (attrs[lastKey] || "") + val;
    } else {
      lastKey = key;
      attrs[key] = val;
    }
  }

  // Flush last weld block
  if (inWeld) {
    const w = _buildWeld(attrs, coords, lineNoUpper);
    if (w) welds.push(w);
  }

  return welds;
}

function _buildWeld(attrs, coords, lineNoUpper) {
  const lineRef = (attrs["-180"] || "").toUpperCase();
  if (!_belongsToLine(lineRef, lineNoUpper)) return null;
  return {
    weldNo: parseInt(attrs["-67"] || "0", 10),
    lineRef: attrs["-180"] || "",
    sheetNo: parseInt(attrs["-181"] || "1", 10),
    x: coords ? coords.x1 : null,
    y: coords ? coords.y1 : null,
    z: coords ? coords.z1 : null,
  };
}

// lineRef belongs to lineNo if it equals lineNo or equals lineNo + a numeric suffix
// e.g. "AP-111-92202-C20" → belongs to "AP-111-92202-C"
// e.g. "AP-111-92202-E3"  → does NOT belong to "AP-111-92202-C"
function _belongsToLine(lineRef, lineNoUpper) {
  if (!lineRef.startsWith(lineNoUpper)) return false;
  const suffix = lineRef.slice(lineNoUpper.length);
  return suffix === "" || /^\d+$/.test(suffix);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow arrow extraction  (Check 2)  — UNCHANGED from original
// ─────────────────────────────────────────────────────────────────────────────
//
// Flow direction indicators in ISOGEN use skey "FLOW" in the 4th comma-delimited
// field of the component record's trailing section.  The component type number
// varies by S3D project configuration (149 confirmed in HSC022 IDFs).
//
// Example record (type 149, HSC022):
//   149  329760330  492296120  14713330  0  0  0  0
//        0,    ,    0,FLOW,    0  0
//
// Type 149 records WITHOUT the FLOW skey are other components (e.g. couplings
// with a -37 description) and must not be counted as flow arrows.
// No -180 line-ownership field exists on flow arrows — they are implicitly
// part of whichever line's IDF file they appear in.

function _extractFlowArrows(lines) {
  const arrows = [];
  for (const raw of lines) {
    const compM = RE_COMP.exec(raw);
    if (!compM) continue;
    const trailing = raw.slice(compM[0].length);
    const csv = trailing.split(",");
    if (csv.length >= 4 && csv[3].trim() === "FLOW") {
      const coords = _parseCoords(raw);
      arrows.push({
        x: coords ? coords.x1 : null,
        y: coords ? coords.y1 : null,
        z: coords ? coords.z1 : null,
      });
    }
  }
  return arrows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header attribute reader  — UNCHANGED from original
// ─────────────────────────────────────────────────────────────────────────────
// Collects all negative-coded fields from the entire file.
// When the same key appears multiple times the last value wins —
// acceptable because we only use single-occurrence header fields
// (-6, -11, -640 etc.)

function _readHeaderAttrs(lines) {
  const attrs = {};
  let lastKey = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*(-\d+) (.*)/);
    if (!m) { lastKey = null; continue; }
    const key = m[1];
    const val = m[2].trim();
    if (key === "-1") {
      if (lastKey) attrs[lastKey] = (attrs[lastKey] || "") + val;
    } else {
      lastKey = key;
      attrs[key] = val;
    }
  }
  return attrs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate parser  — UNCHANGED from original
// ─────────────────────────────────────────────────────────────────────────────

function _parseCoords(raw) {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 7) return null;
  return {
    x1: parseInt(parts[1], 10),
    y1: parseInt(parts[2], 10),
    z1: parseInt(parts[3], 10),
    x2: parseInt(parts[4], 10),
    y2: parseInt(parts[5], 10),
    z2: parseInt(parts[6], 10),
  };
}

module.exports = { parseIdf };