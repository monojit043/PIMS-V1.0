"use strict";
const fs   = require("fs");
const path = require("path");

const IDF_FOLDER = process.env.IDF_FOLDER || "D:\\PIMS_SQL\\IDF";

// Matches the ISO 8601 datetime embedded in the -609 field blob
// e.g. "...ISO8601 Small) : 2026-06-13 16:55:21"
const RE_GENERATED_AT = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

/**
 * Find and validate the IDF file for a given line number.
 *
 * Folder layout:  IDF_FOLDER/{jobNo}/{stylePrefix}-{lineNo}.IDF
 * Example:        D:\PIMS_SQL\IDF\B378\ISOMAR23-AI-111-92215-C.IDF
 *
 * Three-layer matching:
 *   Layer 1 – filename: find *-{lineNo}.IDF (case-insensitive) in IDF_FOLDER/{jobNo}
 *   Layer 2 – content:  read -6 field, must equal lineNo
 *   Layer 3 – freshness: IDF file mtime must be >= oldestAcceptableMs
 *
 * @param {string} lineNo             System line number, e.g. "AI-111-92215-C"
 * @param {string} jobNo              Project ID used as subfolder, e.g. "B378"
 * @param {number|null} oldestAcceptableMs  Epoch ms; IDF older than this is stale.
 *                                    Pass null on first upload (no freshness check).
 *
 * @returns {{ found: true,  filePath: string, idfLineNo: string,
 *                           generatedAt: Date|null, mtime: Date }
 *          |{ found: false, reason: string }}
 */
function findIdfForLine(lineNo, jobNo, oldestAcceptableMs = null) {
  const folder = path.join(IDF_FOLDER, jobNo);

  // ── Layer 1: filename match ───────────────────────────────────────────────
  let entries;
  try {
    entries = fs.readdirSync(folder);
  } catch (e) {
    return { found: false, reason: `IDF folder not accessible (${folder}): ${e.message}` };
  }

  // Primary pattern: anything ending with  -{lineNo}.IDF
  // Handles any S3D style prefix (ISOMAR23-, project-specific, etc.)
  const upperLine = lineNo.toUpperCase();
  const suffix    = `-${upperLine}.IDF`;

  let candidates = entries.filter(f => f.toUpperCase().endsWith(suffix));

  // Fallback: exact match with no prefix (e.g. AI-111-92215-C.IDF)
  if (candidates.length === 0) {
    const exact = entries.find(f => f.toUpperCase() === `${upperLine}.IDF`);
    if (exact) candidates = [exact];
  }

  if (candidates.length === 0) {
    return { found: false, reason: `No IDF file found for line ${lineNo} in ${folder}` };
  }

  // If somehow multiple files match, pick the one with the newest mtime
  const ranked = candidates
    .map(f => {
      try {
        return { f, mtimeMs: fs.statSync(path.join(folder, f)).mtimeMs };
      } catch (_) {
        return { f, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const { f: fileName, mtimeMs } = ranked[0];
  const filePath = path.join(folder, fileName);

  // ── Layer 3: freshness check (cheap — uses the stat already done above) ──
  if (oldestAcceptableMs !== null && mtimeMs < oldestAcceptableMs) {
    return {
      found: false,
      reason:
        `IDF file "${fileName}" is stale — ` +
        `last modified ${new Date(mtimeMs).toISOString()}, ` +
        `need newer than ${new Date(oldestAcceptableMs).toISOString()}`,
    };
  }

  // ── Layer 2: content verification ────────────────────────────────────────
  let attrs;
  try {
    attrs = _readIdfAttributes(filePath);
  } catch (e) {
    return { found: false, reason: `Could not read IDF content: ${e.message}` };
  }

  const idfLineNo = attrs["-6"] || null;

  if (idfLineNo && idfLineNo.toUpperCase() !== upperLine) {
    return {
      found: false,
      reason:
        `IDF content mismatch — filename implies ${lineNo} ` +
        `but internal -6 field says "${idfLineNo}"`,
    };
  }

  // Parse generation timestamp from -609 blob (informational; stored as metadata)
  const blob609     = attrs["-609"] || "";
  const dtMatch     = RE_GENERATED_AT.exec(blob609);
  const generatedAt = dtMatch ? new Date(dtMatch[1]) : null;

  return {
    found: true,
    filePath,
    idfLineNo: idfLineNo || lineNo,
    generatedAt,
    mtime: new Date(mtimeMs),
  };
}

// ── Internal: parse all negative-coded attribute fields into a flat map ───────
//
// Format:
//   -6 AI-111-92215-       ← field key + first 12-char chunk
//   -1 C                   ← continuation line (key -1 always means "append")
//
// Returns { "-6": "AI-111-92215-C", "-640": "2\"-AI-111-92215-A3K-NI-C", ... }
// When the same key appears multiple times (e.g. -180 per weld), the last value wins —
// that is fine because we only use header-section fields (-6, -609, -640) here.
//
function _readIdfAttributes(filePath) {
  const text       = fs.readFileSync(filePath, "utf8");
  const lines      = text.split(/\r?\n/);
  const attrs      = {};
  let   currentKey = null;

  for (const raw of lines) {
    const m = raw.match(/^\s*(-\d+) (.*)/);
    if (!m) {
      currentKey = null;
      continue;
    }

    const key     = m[1];
    const segment = m[2].trim();

    if (key === "-1") {
      if (currentKey !== null) attrs[currentKey] += segment;
    } else {
      currentKey    = key;
      attrs[key]    = segment;
    }
  }

  return attrs;
}

module.exports = { findIdfForLine };
