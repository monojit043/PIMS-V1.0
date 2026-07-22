"use strict";
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const preCheckQ  = require("../db/queries/isoPreCheckQueries");
const pdfParser  = require("./isoPdfParser");
const idfFetcher = require("./isoIdfFetcher");
const idfParser  = require("./isoIdfParser");

// ── Public entry point ────────────────────────────────────────────────────────
// Called fire-and-forget from upload handlers.  Must never throw.
// Params: { drawingId, revNo, lineNo, storedFile, filePath, uploadedBy }
async function triggerPreCheck(params) {
  try {
    await _run(params);
  } catch (err) {
    console.error(
      `[PRECHECK] Unhandled error drawing=${params.drawingId} rev=${params.revNo}:`,
      err.message
    );
  }
}

// ── Core orchestration ────────────────────────────────────────────────────────

async function _run({ drawingId, revNo, lineNo, storedFile, filePath, uploadedBy }) {
  console.log(`[PRECHECK] Start drawing=${drawingId} R${revNo} file=${storedFile}`);

  // 1. Compute PDF hash for duplicate detection (read file once here)
  let pdfHash = null;
  if (fs.existsSync(filePath)) {
    try {
      pdfHash = crypto.createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
    } catch (e) {
      console.warn(`[PRECHECK] Could not hash file: ${e.message}`);
    }
  } else {
    console.warn(`[PRECHECK] File not found: ${filePath}`);
    // Still create the submission so the record exists; mark it FAILED
  }

  // 2. Create submission record — cycle_no assigned inside transaction
  const sub = await preCheckQ.createSubmission({
    drawingId,
    revNo,
    pdfFileName: path.basename(filePath),
    pdfFilePath: filePath,
    pdfHash,
    uploadedBy,
  });

  console.log(`[PRECHECK] Submission id=${sub.id} cycle=R${revNo}-${sub.cycle_no}`);

  // 2a. Fetch IDF — when found, IDF-based checks replace PDF-based equivalents
  const jobNo     = await preCheckQ.getJobNoForDrawing(drawingId);
  const idfResult = idfFetcher.findIdfForLine(lineNo, jobNo, null);
  if (idfResult.found) {
    console.log(
      `[PRECHECK][IDF] ✓ Found — ${path.basename(idfResult.filePath)}` +
      ` | generatedAt=${idfResult.generatedAt?.toISOString() ?? "unknown"}` +
      ` | mtime=${idfResult.mtime.toISOString()}`
    );
  } else {
    console.warn(`[PRECHECK][IDF] ✗ Not found — ${idfResult.reason}`);
  }

  // 3. If file missing, mark as failed and write ERROR results for all checks
  if (!fs.existsSync(filePath)) {
    const msg = `PDF file not found: ${filePath}`;
    await preCheckQ.markParseFailed(sub.id, msg);
    await _writeAllError(sub.id, msg);
    return;
  }

  // 4. Parse the PDF
  await preCheckQ.markParsingStarted(sub.id);

  let parsed;
  try {
    parsed = await pdfParser.parsePdf(filePath);
  } catch (err) {
    console.error(`[PRECHECK] Parse failed sub=${sub.id}:`, err.message);
    await preCheckQ.markParseFailed(sub.id, err.message);
    await _writeAllError(sub.id, err.message);
    return;
  }

  // 5. Extract line number and weld table from parsed pages
  const lineNoResult = pdfParser.extractLineNo(parsed.pages, lineNo);
  const weldRecords  = pdfParser.extractWeldTable(parsed.pages);

  console.log(
    `[PRECHECK] sub=${sub.id} pages=${parsed.pageCount}` +
    ` lineNoFound=${lineNoResult.found} welds=${weldRecords.length}`
  );

  // 6. Parse PDF creation date from metadata (for IDF matching, stored for future use)
  let pdfGeneratedAt = null;
  if (parsed.metadata?.creationDate) {
    try {
      const d = new Date(parsed.metadata.creationDate);
      if (!isNaN(d.getTime())) pdfGeneratedAt = d;
    } catch (_) {}
  }

  // 7. Persist parse summary on submission record
  await preCheckQ.markParseDone(sub.id, {
    extractedLineNo:     lineNoResult.found ? lineNoResult.extractedText : null,
    extractedRev:        null, // future: extract from title block
    extractedDate:       null, // future: extract from title block
    extractedSheetCount: parsed.pageCount,
    pdfGeneratedAt,
  });

  // 8. Persist weld records
  const weldRows = weldRecords.map(w => ({ submissionId: sub.id, ...w }));
  await preCheckQ.bulkInsertWelds(weldRows);

  // 9–11. Run all checks — IDF path when IDF available, PDF fallback otherwise.
  // When IDF parses successfully, it replaces every PDF-based check.
  // When IDF is absent or fails to parse, all PDF checks run as fallback.
  if (idfResult.found) {
    let idfParsed;
    try {
      idfParsed = idfParser.parseIdf(idfResult.filePath, lineNo);
      console.log(`[PRECHECK][IDF] Parsed ${idfParsed.welds.length} weld(s) for ${lineNo}`);
    } catch (err) {
      console.error(`[PRECHECK][IDF] Parse failed: ${err.message} — falling back to PDF checks`);
      idfParsed = null;
    }
    if (idfParsed) {
      await _idfCheckLineNo(sub.id, lineNo, idfParsed.lineNo, idfParsed.zone);
      await _idfCheckLineSpec(sub.id, drawingId, lineNo, idfParsed.spec, idfParsed.fullTag);
      await _idfCheckWeldTable(sub.id, drawingId, revNo, sub.cycle_no, idfParsed.welds);
      await _idfCheckFlowDirection(sub.id, idfParsed.flowArrows);
      await _idfCheckBomData(sub.id, idfParsed.bomItems, idfParsed.nonReportableItems);
      await _idfCheckCouplingSpacing(sub.id, idfParsed.fullTag, idfParsed.couplingData);
    } else {
      await _checkLineNo(sub.id, lineNo, lineNoResult);
      await _checkLineSpec(sub.id, drawingId, lineNo, lineNoResult);
      await _checkWeldTable(sub, drawingId, revNo, weldRecords);
    }
  } else {
    await _checkLineNo(sub.id, lineNo, lineNoResult);
    await _checkLineSpec(sub.id, drawingId, lineNo, lineNoResult);
    await _checkWeldTable(sub, drawingId, revNo, weldRecords);
  }

  // Always extract pipe schedule from PDF (runs regardless of IDF availability)
  await _pdfStorePipeSchedule(sub.id, parsed.pages);

  console.log(`[PRECHECK] Done sub=${sub.id}`);
}

// ── IDF Check 4a: Line number — IDF -6 vs system ─────────────────────────────
//
// IDF -6 field is the authoritative line number written by S3D at generation
// time. Direct string comparison — no OCR ambiguity.
//
// PASS — exact match between IDF -6 and system line_no
// FLAG — core ID matches but zone letter differs (e.g. IDF says C, system says B)
// FAIL — core ID mismatch (wrong drawing attached)

async function _idfCheckLineNo(submissionId, systemLineNo, idfLineNo, idfZone) {
  const sysUpper = (systemLineNo || "").trim().toUpperCase();
  const idfUpper = (idfLineNo   || "").trim().toUpperCase();

  const detail = {
    system_line_no: systemLineNo,
    idf_line_no:    idfLineNo,
    idf_zone:       idfZone,
    source:         "IDF",
  };

  let result;

  if (!idfLineNo) {
    result = "FLAG";
    detail.note = "IDF -6 field (line number) is blank";
  } else if (idfUpper === sysUpper) {
    result = "PASS";
  } else {
    const sysZoneM = /^(.+)-([A-Z]{1,2})$/i.exec(sysUpper);
    const idfZoneM = /^(.+)-([A-Z]{1,2})$/i.exec(idfUpper);
    const sysCoreId = sysZoneM ? sysZoneM[1] : sysUpper;
    const idfCoreId = idfZoneM ? idfZoneM[1] : idfUpper;
    const sysZoneL  = sysZoneM ? sysZoneM[2] : null;
    const idfZoneL  = idfZoneM ? idfZoneM[2] : null;

    if (idfCoreId === sysCoreId) {
      result = "FLAG";
      detail.note = `Core ID matches but zone differs — IDF: ${idfZoneL}, system: ${sysZoneL}`;
    } else {
      result = "FAIL";
      detail.note = `Line number mismatch — IDF: ${idfLineNo}, system expects: ${systemLineNo}`;
    }
  }

  await preCheckQ.upsertCheckResult(
    submissionId, "LINE_NO_MATCH", "Line Number in IDF Matches System", result, detail
  );
}

// ── IDF Check 4b: Pipe size / spec / insulation — IDF vs line list ────────────
//
// IDF -11  → spec / pipe class  (e.g. A3K)
// IDF -640 → full tag including size and insulation (e.g. 2"-AI-111-92215-A3K-NI-C)
//
// Format: <size>"-<service>-<unit>-<seq>-<spec>-<insul>-<zone>
// Size and insulation are parsed from the full tag; spec is used from -11 directly.

function _parseIdfFullTag(fullTag) {
  if (!fullTag) return null;
  const parts = fullTag.split("-");
  // Need at least: size + service + unit + seq + spec + insul + zone = 7 parts
  if (parts.length < 7) return null;

  const sizeRaw    = parts[0].replace(/"/g, "").trim();
  const insulation = parts[parts.length - 2] || null;

  let sizeNum;
  if (sizeRaw.includes("/")) {
    const [n, d] = sizeRaw.split("/").map(Number);
    sizeNum = d ? n / d : NaN;
  } else {
    sizeNum = parseFloat(sizeRaw);
  }

  return isNaN(sizeNum) ? null : { sizeDisplay: parts[0], sizeNum, insulation };
}

async function _idfCheckLineSpec(submissionId, drawingId, systemLineNo, idfSpec, idfFullTag) {
  const CHECK = ["LINE_SPEC_MATCH", "Pipe Size / Spec / Insulation vs Line List"];

  const tagParsed = _parseIdfFullTag(idfFullTag);
  if (!tagParsed) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG",
      { note: `Cannot parse IDF full tag: ${idfFullTag}`, source: "IDF" });
    return;
  }

  // Service / unit / seq extracted from system line_no for linelist lookup
  // Uses pdfParser.SYS_CORE_RE so alphanumeric seq (HSC022) AND an optional
  // subline (TRM-111-VV1227-VS-A) are both tolerated — the linelist is keyed
  // by base seq only, so subline is intentionally not captured here.
  const sysM = pdfParser.SYS_CORE_RE.exec((systemLineNo || "").trim());
  if (!sysM) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG",
      { note: `Cannot parse system line_no format: ${systemLineNo}`, source: "IDF" });
    return;
  }
  const [, service, unitNo, seqNo] = sysM;

  const jobNo = await preCheckQ.getJobNoForDrawing(drawingId);
  if (!jobNo) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG",
      { note: "Could not determine job number for this drawing", source: "IDF" });
    return;
  }

  const llRows = await preCheckQ.getLinelistData(jobNo, service, unitNo, seqNo);
  if (!llRows.length) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG", {
      note: "Line not found in line list — data may not be uploaded yet",
      job_no: jobNo, service, unit_no: unitNo, line_no: seqNo, source: "IDF",
    });
    return;
  }

  const dbSizes    = llRows.map(r => r.line_size);
  const dbSizeNums = dbSizes.map(s => _normLineSize(s)).filter(n => !isNaN(n));
  const dbClass    = (llRows[0].line_class || "").toUpperCase();
  const dbInsul    = (llRows[0].insulation || "").toUpperCase();

  const idfSpecUpper  = (idfSpec                  || "").toUpperCase();
  const idfInsulUpper = (tagParsed.insulation      || "").toUpperCase();

  const sizeOk  = dbSizeNums.some(n => Math.abs(n - tagParsed.sizeNum) < 0.01);
  const specOk  = dbClass && idfSpecUpper === dbClass;
  const insulOk = dbInsul && idfInsulUpper === dbInsul;

  const mismatches = [];
  if (!sizeOk)  mismatches.push("size");
  if (!specOk)  mismatches.push("spec");
  if (!insulOk) mismatches.push("insulation");

  await preCheckQ.upsertCheckResult(submissionId, ...CHECK,
    mismatches.length === 0 ? "PASS" : "FAIL",
    {
      idf_size:  tagParsed.sizeDisplay, db_sizes:  dbSizes,  size_ok:  sizeOk,
      idf_spec:  idfSpec,               db_spec:   dbClass,  spec_ok:  specOk,
      idf_insul: tagParsed.insulation,  db_insul:  dbInsul,  insul_ok: insulOk,
      mismatches,
      source: "IDF",
    }
  );
}

// ── Check A: LINE_NO_MATCH ────────────────────────────────────────────────────

async function _checkLineNo(submissionId, systemLineNo, lineNoResult) {
  // Derive coreId + zone from system line_no  (P-111-40201-B → P-111-40201, B)
  // Subline (if any) is stripped along with zone — pdfCore below never carries
  // a subline either, since ISOGEN's printed tag format has no subline slot.
  const sysCoreM  = pdfParser.SYS_CORE_RE.exec((systemLineNo || "").trim());
  const sysCoreId = sysCoreM ? `${sysCoreM[1]}-${sysCoreM[2]}-${sysCoreM[3]}`.toUpperCase() : null;
  const sysZone   = sysCoreM ? sysCoreM[5].toUpperCase() : null;

  const detail = { system_line_no: systemLineNo, sys_core_id: sysCoreId, sys_zone: sysZone };
  let result;

  if (lineNoResult.parsed) {
    // Full ISO tag was found and decoded in the PDF
    const p       = lineNoResult.parsed;
    const pdfCore = `${p.service}-${p.unitNo}-${p.seqNo}`;
    detail.pdf_tag     = p.rawTag;
    detail.pdf_core_id = pdfCore;
    detail.pdf_zone    = p.zone;

    const coreMatch = sysCoreId && pdfCore === sysCoreId;
    const zoneMatch = sysZone   && p.zone  === sysZone;

    if (coreMatch && zoneMatch) {
      result = "PASS";
    } else if (coreMatch && !zoneMatch) {
      result = "FLAG";
      detail.note = `Core ID matches but zone differs — PDF: ${p.zone}, system: ${sysZone}`;
    } else {
      result = "FAIL";
      detail.note = `Core ID mismatch — PDF tag is for ${pdfCore}, system expects ${sysCoreId}`;
    }
  } else if (lineNoResult.found) {
    // Found via plain text match (no ISO tag parsed)
    result = "PASS";
    detail.pdf_tag = lineNoResult.extractedText;
    detail.note    = "Matched via text search — ISO tag format not detected";
  } else {
    result = "FAIL";
    detail.note = "Line number not found in any page of the PDF";
  }

  await preCheckQ.upsertCheckResult(
    submissionId, "LINE_NO_MATCH", "Line Number in PDF Matches System", result, detail
  );
}

// ── Check A2: LINE_SPEC_MATCH ─────────────────────────────────────────────────

async function _checkLineSpec(submissionId, drawingId, systemLineNo, lineNoResult) {
  const CHECK = ["LINE_SPEC_MATCH", "Pipe Size / Spec / Insulation vs Line List"];

  // Need a parsed ISO tag to extract size, spec, insulation from the PDF
  if (!lineNoResult.parsed) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG",
      { note: "ISO tag not found in PDF — cannot extract spec data for comparison" });
    return;
  }

  const { sizeNum, size: pdfSize, spec: pdfSpec, insulType: pdfInsul } = lineNoResult.parsed;

  // Parse system line_no into linelist lookup keys  (P-111-40201-B → P, 111, 40201)
  const sysM = /^([A-Z]+)-(\d+)-(\d+)-[A-Z]$/i.exec((systemLineNo || "").trim());
  if (!sysM) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG",
      { note: `Cannot parse system line_no format: ${systemLineNo}` });
    return;
  }
  const [, service, unitNo, seqNo] = sysM;

  // Get job_no to scope the linelist query
  const jobNo = await preCheckQ.getJobNoForDrawing(drawingId);
  if (!jobNo) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG",
      { note: "Could not determine job number for this drawing" });
    return;
  }

  // Fetch all linelist rows for this line (one per nominal size)
  const llRows = await preCheckQ.getLinelistData(jobNo, service, unitNo, seqNo);
  if (!llRows.length) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG", {
      note:    "Line not found in line list — data may not be uploaded yet",
      job_no:  jobNo, service, unit_no: unitNo, line_no: seqNo,
    });
    return;
  }

  // Normalize DB sizes to floats and build comparison values
  const dbSizes    = llRows.map(r => r.line_size);
  const dbSizeNums = dbSizes.map(s => _normLineSize(s)).filter(n => !isNaN(n));
  const dbClass    = (llRows[0].line_class  || "").toUpperCase();
  const dbInsul    = (llRows[0].insulation  || "").toUpperCase();

  const sizeOk  = dbSizeNums.some(n => Math.abs(n - sizeNum) < 0.01);
  const specOk  = dbClass && pdfSpec  === dbClass;
  const insulOk = dbInsul && pdfInsul === dbInsul;

  const mismatches = [];
  if (!sizeOk)  mismatches.push("size");
  if (!specOk)  mismatches.push("spec");
  if (!insulOk) mismatches.push("insulation");

  await preCheckQ.upsertCheckResult(submissionId, ...CHECK,
    mismatches.length === 0 ? "PASS" : "FAIL",
    {
      pdf_size:  pdfSize,  db_sizes:  dbSizes,  size_ok:  sizeOk,
      pdf_spec:  pdfSpec,  db_spec:   dbClass,  spec_ok:  specOk,
      pdf_insul: pdfInsul, db_insul:  dbInsul,  insul_ok: insulOk,
      mismatches,
    }
  );
}

// ── IDF Check 1: Weld table (replaces PDF Check B when IDF is available) ─────
//
// Two sub-checks:
//   WELD_TABLE_PRESENT  — at least one numbered weld found for this line
//   WELD_NO_DUPLICATES  — no two welds share the same weld number

async function _idfCheckWeldTable(submissionId, drawingId, revNo, cycleNo, welds) {
  const numbered   = welds.filter(w => w.weldNo > 0);
  const unnumbered = welds.filter(w => w.weldNo === 0);

  // 1a. Weld table present + all welds must have a number
  //   FAIL  — no welds at all found for this line
  //   FLAG  — welds exist but some have no weld number assigned in S3D
  //   PASS  — all welds are numbered
  let presentResult, presentDetail;
  if (welds.length === 0) {
    presentResult = "FAIL";
    presentDetail = {
      total_welds: 0,
      note: "No weld joints found in IDF for this line",
    };
  } else if (unnumbered.length > 0) {
    presentResult = "FLAG";
    presentDetail = {
      total_welds:    welds.length,
      numbered:       numbered.length,
      unnumbered:     unnumbered.length,
      note: `${unnumbered.length} weld(s) have no weld number assigned in the S3D model — modeller action required`,
    };
  } else {
    presentResult = "PASS";
    presentDetail = {
      total_welds: welds.length,
      numbered:    numbered.length,
      unnumbered:  0,
    };
  }

  await preCheckQ.upsertCheckResult(
    submissionId,
    "WELD_TABLE_PRESENT",
    "Weld Table",
    presentResult,
    { ...presentDetail, source: "IDF" }
  );

  // 1b. No duplicate weld numbers (checked on numbered welds only)
  if (numbered.length === 0) {
    await preCheckQ.upsertCheckResult(
      submissionId,
      "WELD_NO_DUPLICATES",
      "No Duplicate Weld Numbers",
      "FLAG",
      { note: "No numbered welds — cannot check duplicates", source: "IDF" }
    );
    await _checkCountDelta(submissionId, drawingId, revNo, cycleNo, 0);
    return;
  }

  const byNo = {};
  for (const w of numbered) {
    if (!byNo[w.weldNo]) byNo[w.weldNo] = [];
    byNo[w.weldNo].push(w.sheetNo);
  }
  const duplicates = Object.entries(byNo)
    .filter(([, sheets]) => sheets.length > 1)
    .map(([no, sheets]) => ({ weld_no: parseInt(no, 10), on_sheets: sheets }));

  await preCheckQ.upsertCheckResult(
    submissionId,
    "WELD_NO_DUPLICATES",
    "No Duplicate Weld Numbers",
    duplicates.length === 0 ? "PASS" : "FAIL",
    {
      numbered_count:  numbered.length,
      duplicate_count: duplicates.length,
      duplicates,
      source:          "IDF",
    }
  );

  // Weld count delta — IDF-only comparison (never crosses PDF counts)
  await _idfCheckCountDelta(submissionId, drawingId, revNo, cycleNo, welds.length);
}

// ── IDF weld count delta ──────────────────────────────────────────────────────
// Compares IDF weld counts against previous IDF cycle only.
// If the previous cycle used the PDF parser (no WELD_TABLE_PRESENT row), treats
// this cycle as a new baseline so PDF and IDF counts are never mixed.

async function _idfCheckCountDelta(submissionId, drawingId, revNo, cycleNo, currentCount) {
  const prevCheck = await preCheckQ.getPreviousCheckResult(
    drawingId, revNo, cycleNo, "WELD_TABLE_PRESENT"
  );

  const prevIsIdf = prevCheck && prevCheck.detail && prevCheck.detail.source === "IDF";

  if (!prevIsIdf) {
    await preCheckQ.upsertCheckResult(
      submissionId, "WELD_COUNT_DELTA", "Weld Count vs Previous Cycle", "PASS",
      {
        current_count:  currentCount,
        previous_cycle: null,
        source:         "IDF",
        note: prevCheck
          ? "Previous cycle used PDF parser — IDF count accepted as new baseline"
          : "First upload for this revision — no previous cycle to compare",
      }
    );
    return;
  }

  const prevCount       = prevCheck.detail.total_welds ?? 0;
  const prevCycleLabel  = `R${revNo}-${prevCheck.cycle_no}`;
  const diff            = currentCount - prevCount;

  await preCheckQ.upsertCheckResult(
    submissionId, "WELD_COUNT_DELTA", "Weld Count vs Previous Cycle",
    diff === 0 ? "PASS" : "FLAG",
    {
      current_count:  currentCount,
      previous_count: prevCount,
      diff,
      previous_cycle: prevCycleLabel,
      source:         "IDF",
    }
  );
}

// ── IDF Check 2: Flow direction present ───────────────────────────────────────
//
// PASS — at least one FLWN flow arrow found in the IDF
// FAIL — no flow arrow found (modeller forgot to add it in S3D)

async function _idfCheckFlowDirection(submissionId, flowArrows) {
  const count = flowArrows.length;

  await preCheckQ.upsertCheckResult(
    submissionId,
    "FLOW_DIRECTION_PRESENT",
    "Flow Direction",
    count > 0 ? "PASS" : "FAIL",
    count > 0
      ? { arrow_count: count, source: "IDF" }
      : { arrow_count: 0, source: "IDF",
          note: "No flow direction indicator found in IDF — add flow arrow in S3D model" }
  );
}

// ── IDF Check 3: BOM data complete ───────────────────────────────────────────
//
// Stores every -20/-21 pair from the IDF BOM block into iso_bom_items,
// then writes a BOM_DATA_COMPLETE check result:
//
//   FAIL  — no BOM items found in IDF at all
//   FLAG  — one or more real items are missing tag (-20) or description (-21)
//   PASS  — all real procurement items have both tag and description
//
// Routing references ("Design Pipe Assembly…") are stored but excluded from
// the procurement check and from the flagged_items list.

async function _idfCheckBomData(submissionId, bomItems, nonReportableItems) {
  // Build a flat list from both parser buckets, adding classification flags.
  // bomItems       → items with non-blank description (may still have blank code)
  // nonReportableItems → blank description OR code = "Non-Reportable"
  const allItems = [
    ...bomItems.map(item => ({
      itemCode:    item.itemCode,
      description: item.description,
      hasTag:      item.itemCode !== "",
      hasDesc:     item.description !== "",
      isRoutingRef: /^design pipe/i.test(item.description),
      isNonReportable: /^non-reportable$/i.test(item.itemCode),
    })),
    ...nonReportableItems.map(item => ({
      itemCode:    item.itemCode,
      description: item.description,
      hasTag:      item.itemCode !== "" && !/^non-reportable$/i.test(item.itemCode),
      hasDesc:     item.description !== "",
      isRoutingRef: false,
      isNonReportable: /^non-reportable$/i.test(item.itemCode),
    })),
  ];

  // Persist all BOM entries to iso_bom_items
  if (allItems.length > 0) {
    await preCheckQ.bulkInsertBomItems(
      allItems.map(i => ({ submissionId, ...i }))
    );
  }

  const realItems = allItems.filter(i => !i.isRoutingRef);
  const routingCount = allItems.length - realItems.length;

  // "Non-Reportable" is a tag S3D writes deliberately when a BOM line is
  // intentionally excluded from procurement — it's expected to have no
  // tag/description, so it's not an actionable data-entry gap. Keep it out
  // of flaggedItems (which drives the inline table + modeller-action count);
  // it's only reachable via the "View Non-Reportable Items" button.
  const nonReportableTagged = realItems.filter(i => i.isNonReportable);
  const actionableItems     = realItems.filter(i => !i.isNonReportable);
  const flaggedItems        = actionableItems.filter(i => !i.hasTag || !i.hasDesc);

  let result, detail;

  if (allItems.length === 0) {
    result = "FAIL";
    detail = {
      total_items: 0, real_items: 0, routing_refs: 0, flagged: 0, non_reportable_count: 0,
      source: "IDF",
      note: "No BOM items found in IDF",
    };
  } else if (realItems.length === 0) {
    result = "FLAG";
    detail = {
      total_items:  allItems.length,
      real_items:   0,
      routing_refs: routingCount,
      flagged:      0,
      non_reportable_count: 0,
      source:       "IDF",
      note: "BOM contains only routing references — no procurement items found",
    };
  } else if (flaggedItems.length > 0 || nonReportableTagged.length > 0) {
    result = "FLAG";
    detail = {
      total_items:   allItems.length,
      real_items:    realItems.length,
      routing_refs:  routingCount,
      flagged:       flaggedItems.length,
      flagged_items: flaggedItems.map(i => ({
        item_code:   i.itemCode,
        description: i.description,
        issue: (!i.hasTag && !i.hasDesc) ? "missing_tag_and_description"
             : !i.hasTag                 ? "missing_tag"
             :                             "missing_description",
      })),
      non_reportable_count: nonReportableTagged.length,
      source: "IDF",
      note: flaggedItems.length === 0
        ? `${nonReportableTagged.length} Non-Reportable item(s) present — no modeller action required`
        : undefined,
    };
  } else {
    result = "PASS";
    detail = {
      total_items:  allItems.length,
      real_items:   realItems.length,
      routing_refs: routingCount,
      flagged:      0,
      non_reportable_count: 0,
      source:       "IDF",
    };
  }

  await preCheckQ.upsertCheckResult(
    submissionId, "BOM_DATA_COMPLETE", "BOM Data", result, detail
  );
}

// ── IDF Check 6: Coupling spacing (lines ≤ 1.5") ─────────────────────────────
//
// For small-bore lines (≤ 1.5"), a COSW full coupling must appear at least
// once every 5 m of pipe to allow section removal for maintenance.
//
// Checks each individual straight pipe spool independently.
// A spool (type-100 record) > 5 500 mm is flagged — it is too long and needs a coupling
// to allow maintenance disassembly.  Elbows are natural break points and do NOT cause
// length accumulation; each straight segment is checked on its own.
//
// Data from parser: { longSpools[], couplingCount, totalPipeMm }
//
// PASS  — pipe size > 1.5" (not applicable)
// PASS  — no individual spool exceeds 5 500 mm
// FLAG  — one or more spools > 5 500 mm
// FLAG  — no pipe length data found at all (cannot verify)

async function _idfCheckCouplingSpacing(submissionId, fullTag, couplingData) {
  const CHECK = ["COUPLING_SPACING", "Coupling Spacing (≤1.5\" lines)"];

  const tagParsed   = _parseIdfFullTag(fullTag);
  const sizeDisplay = tagParsed ? tagParsed.sizeDisplay : null;
  const sizeNum     = tagParsed ? tagParsed.sizeNum     : null;

  // Not applicable for lines > 1.5"
  if (!sizeNum || sizeNum > 1.5) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "PASS", {
      source:    "IDF",
      pipe_size: sizeDisplay,
      note:      `Not applicable — pipe size ${sizeDisplay || "unknown"} exceeds 1.5"`,
    });
    return;
  }

  const { longSpools = [], couplingCount = 0, totalPipeMm = 0 } = couplingData || {};

  // No pipe length data in IDF (totalPipeMm = 0 means nothing was measurable)
  if (totalPipeMm === 0) {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG", {
      source:    "IDF",
      pipe_size: sizeDisplay,
      note:      "No pipe length data found in IDF — cannot verify coupling spacing",
    });
    return;
  }

  if (longSpools.length > 0) {
    // One or more individual pipe spools exceed 5.5 m
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "FLAG", {
      source:           "IDF",
      pipe_size:        sizeDisplay,
      coupling_count:   couplingCount,
      total_pipe_mm:    totalPipeMm,
      over_limit_count: longSpools.length,
      limit_mm:         5500,
      spools:           longSpools.map(s => ({
        spool:     s.spoolIdx + 1,
        length_mm: s.lengthMm,
      })),
      note: `${longSpools.length} pipe spool(s) exceed 5.5 m — add COSW coupling to shorten`,
    });
  } else {
    await preCheckQ.upsertCheckResult(submissionId, ...CHECK, "PASS", {
      source:         "IDF",
      pipe_size:      sizeDisplay,
      coupling_count: couplingCount,
      total_pipe_mm:  totalPipeMm,
      limit_mm:       5500,
    });
  }
}

// ── Pipe schedule storage — PDF-based, runs every upload ─────────────────────
//
// Reads ISOGEN-printed title-block fields and BOM table from every sheet and
// sums across sheets:
//   PIPE NS (IN)            → pipe_ns_in  (same on all sheets, taken once)
//   CURVILINEAR LENGTH (M)  → curv_length_m (sum)
//   INCH DIA:               → inch_dia     (sum)
//   INCH MTR:               → inch_meter   (sum)
//   BOM pipe row qty (M)    → bom_qty_m   (sum, per item code)
//
// One row per unique pipe item code.  For single-spec lines: one row.
// For reducer lines: one row per material (each with the same summed totals
// since ISOGEN prints totals for the whole line, not per material).

async function _pdfStorePipeSchedule(submissionId, pages) {
  try {
    const sched = pdfParser.extractPipeSchedule(pages);

    // Nothing useful found — skip
    if (!sched.pipeNsIn && sched.curvLengthM === 0 && sched.bomPipeItems.length === 0) return;

    let rows;
    if (sched.bomPipeItems.length > 0) {
      // One row per pipe BOM entry; title-block totals apply to the whole line
      rows = sched.bomPipeItems.map(b => ({
        submissionId,
        itemCode:    b.itemCode    || "",
        description: b.description || "",
        pipeNsIn:    sched.pipeNsIn,
        curvLengthM: sched.curvLengthM || null,
        inchDia:     sched.inchDia     || null,
        inchMeter:   sched.inchMeter   || null,
        bomQtyM:     b.qtyM            || null,
      }));
    } else {
      // BOM pipe row not found (unusual) — store title-block values only
      rows = [{
        submissionId,
        itemCode:    "",
        description: "",
        pipeNsIn:    sched.pipeNsIn,
        curvLengthM: sched.curvLengthM || null,
        inchDia:     sched.inchDia     || null,
        inchMeter:   sched.inchMeter   || null,
        bomQtyM:     null,
      }];
    }

    await preCheckQ.insertPipeSchedule(rows);
  } catch (err) {
    // Pipe schedule is non-critical; log and continue
    console.error(`[PRECHECK] _pdfStorePipeSchedule failed: ${err.message}`);
  }
}

// ── Check B: Weld table (PDF fallback) ───────────────────────────────────────

async function _checkWeldTable(sub, drawingId, revNo, weldRecords) {
  const submissionId = sub.id;
  const cycleNo      = sub.cycle_no;

  // When no welds were extracted the parser could not find the table.
  // Flag all weld checks so the checker verifies manually.
  if (weldRecords.length === 0) {
    const noWeldsDetail = {
      weld_count: 0,
      note: "No weld records extracted from PDF — manual verification required",
    };
    for (const [code, name] of [
      ["WELD_CONTINUITY",    "Weld Numbers Sequential (No Gaps)"],
      ["WELD_NO_DUPLICATES", "No Duplicate Weld Numbers Across Sheets"],
      ["WELD_TYPES_PRESENT", "All Welds Have Type (FW/SW)"],
    ]) {
      await preCheckQ.upsertCheckResult(submissionId, code, name, "FLAG", noWeldsDetail);
    }
    await _checkCountDelta(submissionId, drawingId, revNo, cycleNo, 0);
    return;
  }

  await _checkContinuity(submissionId, weldRecords);
  await _checkNoDuplicates(submissionId, weldRecords);
  await _checkTypesPresent(submissionId, weldRecords);
  await _checkCountDelta(submissionId, drawingId, revNo, cycleNo, weldRecords.length);
}

// B1: Weld numbers should form a complete sequence 1 … N with no gaps
async function _checkContinuity(submissionId, weldRecords) {
  const uniqueNos = [...new Set(weldRecords.map(w => w.weldNo))].sort((a, b) => a - b);
  const maxNo     = uniqueNos[uniqueNos.length - 1] || 0;
  const expected  = Array.from({ length: maxNo }, (_, i) => i + 1);
  const gaps      = expected.filter(n => !uniqueNos.includes(n));

  const result = gaps.length === 0 ? "PASS" : "FAIL";
  const detail = { total_unique_welds: uniqueNos.length, max_weld_no: maxNo, gaps };

  await preCheckQ.upsertCheckResult(
    submissionId, "WELD_CONTINUITY", "Weld Numbers Sequential (No Gaps)", result, detail
  );
}

// B2: Same weld number should not appear on more than one sheet
async function _checkNoDuplicates(submissionId, weldRecords) {
  const byNo = {};
  for (const w of weldRecords) {
    if (!byNo[w.weldNo]) byNo[w.weldNo] = new Set();
    byNo[w.weldNo].add(w.sheetNo);
  }
  const duplicates = Object.entries(byNo)
    .filter(([, sheets]) => sheets.size > 1)
    .map(([no, sheets]) => ({
      weld_no:        parseInt(no, 10),
      found_on_sheets: [...sheets].sort((a, b) => a - b),
    }));

  const result = duplicates.length === 0 ? "PASS" : "FAIL";
  const detail = { duplicate_count: duplicates.length, duplicates };

  await preCheckQ.upsertCheckResult(
    submissionId, "WELD_NO_DUPLICATES", "No Duplicate Weld Numbers Across Sheets", result, detail
  );
}

// B3: Every weld record should have a type (FW or SW)
async function _checkTypesPresent(submissionId, weldRecords) {
  const missing = weldRecords.filter(w => !w.weldType).map(w => w.weldNo);

  const result = missing.length === 0 ? "PASS" : "FAIL";
  const detail = {
    total:        weldRecords.length,
    with_type:    weldRecords.length - missing.length,
    missing_type: [...new Set(missing)].sort((a, b) => a - b),
  };

  await preCheckQ.upsertCheckResult(
    submissionId, "WELD_TYPES_PRESENT", "All Welds Have Type (FW or SW)", result, detail
  );
}

// B4: Compare weld count to the immediately preceding cycle in the same revision
async function _checkCountDelta(submissionId, drawingId, revNo, cycleNo, currentCount) {
  const prev = await preCheckQ.getPreviousSubmission(drawingId, revNo, cycleNo);

  if (!prev) {
    const detail = {
      current_count: currentCount,
      previous_cycle: null,
      note: "First upload for this revision — no previous cycle to compare",
    };
    await preCheckQ.upsertCheckResult(
      submissionId, "WELD_COUNT_DELTA", "Weld Count vs Previous Cycle", "PASS", detail
    );
    return;
  }

  const prevCount = parseInt(prev.weld_count, 10) || 0;
  const diff      = currentCount - prevCount;
  const detail    = {
    current_count:    currentCount,
    previous_count:   prevCount,
    diff,
    previous_cycle:   `R${revNo}-${prev.cycle_no}`,
    previous_sub_id:  prev.id,
  };

  // Any change in weld count is a FLAG — checker should confirm it's intentional
  const result = diff === 0 ? "PASS" : "FLAG";

  await preCheckQ.upsertCheckResult(
    submissionId, "WELD_COUNT_DELTA", "Weld Count vs Previous Cycle", result, detail
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Write ERROR result for all checks (called when PDF cannot be parsed at all)
async function _writeAllError(submissionId, errorMsg) {
  const detail = { error: String(errorMsg).slice(0, 500) };
  const checks = [
    ["LINE_NO_MATCH",      "Line Number in PDF Matches System"],
    ["LINE_SPEC_MATCH",    "Pipe Size / Spec / Insulation vs Line List"],
    ["WELD_CONTINUITY",    "Weld Numbers Sequential (No Gaps)"],
    ["WELD_NO_DUPLICATES", "No Duplicate Weld Numbers Across Sheets"],
    ["WELD_TYPES_PRESENT", "All Welds Have Type (FW or SW)"],
    ["WELD_COUNT_DELTA",   "Weld Count vs Previous Cycle"],
  ];
  for (const [code, name] of checks) {
    await preCheckQ.upsertCheckResult(submissionId, code, name, "ERROR", detail).catch(() => {});
  }
}

// Normalize a pipe size string to float — handles "8\"", "1.5\"", "3/4\""
function _normLineSize(sizeStr) {
  const s = String(sizeStr || "").replace(/"/g, "").trim();
  if (s.includes("/")) {
    const [num, den] = s.split("/").map(Number);
    return den ? num / den : NaN;
  }
  return parseFloat(s);
}

module.exports = { triggerPreCheck };
