"use strict";
const router = require("express").Router();
const { requireLogin, requireCheckerRole } = require("../middleware/auth");
const { pool } = require("../db/pool");
const preCheckQ = require("../db/queries/isoPreCheckQueries");

// GET /api/iso-prechecks?jobNo=&unitNo=&lineNo=&revNo=
router.get("/iso-prechecks", requireLogin, async (req, res) => {
  try {
    const { jobNo, unitNo, lineNo, revNo } = req.query;
    if (!jobNo || !lineNo) {
      return res.json({ ok: false, error: "jobNo and lineNo required" });
    }

    // Resolve drawing record — unit_no makes the lookup precise
    const dwQuery = unitNo
      ? await pool.query(
          `SELECT id, rev_no FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 LIMIT 1`,
          [jobNo, unitNo, lineNo]
        )
      : await pool.query(
          `SELECT id, rev_no FROM drawings WHERE job_no=$1 AND line_no=$2 LIMIT 1`,
          [jobNo, lineNo]
        );

    if (!dwQuery.rows.length) {
      return res.json({ ok: true, submission: null, checks: [], weld_count: 0 });
    }

    const drawingId = dwQuery.rows[0].id;
    // revNo from the frontend arrives as "R0", "R1" etc. — strip the leading R before parsing
    let resolvedRevNo;
    if (revNo != null && revNo !== "") {
      const n = parseInt(String(revNo).replace(/^[Rr]/, ""), 10);
      resolvedRevNo = isNaN(n) ? (dwQuery.rows[0].rev_no || 0) : n;
    } else {
      resolvedRevNo = dwQuery.rows[0].rev_no || 0;
    }

    // Get the active (latest) submission for this drawing + revision
    const sub = await preCheckQ.getActiveSubmission(drawingId, resolvedRevNo);
    if (!sub) {
      return res.json({ ok: true, submission: null, checks: [], weld_count: 0 });
    }

    // Get check results
    const { rows: checks } = await pool.query(
      `SELECT check_code, check_name, result, detail,
              checker_actioned, checker_action, actioned_at, created_at
       FROM iso_pre_check_results
       WHERE submission_id = $1
       ORDER BY created_at`,
      [sub.id]
    );

    // Weld count
    const { rows: wcRows } = await pool.query(
      `SELECT COUNT(*)::int AS weld_count FROM iso_weld_records WHERE submission_id = $1`,
      [sub.id]
    );

    res.json({
      ok: true,
      submission: {
        id:                   sub.id,
        rev_no:               sub.rev_no,
        cycle_no:             sub.cycle_no,
        parse_status:         sub.parse_status,
        uploaded_at:          sub.uploaded_at,
        pdf_file_name:        sub.pdf_file_name,
        extracted_line_no:    sub.extracted_line_no,
        extracted_sheet_count: sub.extracted_sheet_count,
        parse_error:          sub.parse_error,
      },
      checks,
      weld_count: wcRows[0]?.weld_count || 0,
    });
  } catch (err) {
    console.error("[ISO-PRECHECK API]", err.message);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// GET /api/iso-prechecks/bom-items?submissionId=&filter=non_reportable|issues
const BOM_ITEM_FILTERS = ["non_reportable", "issues"];
router.get("/iso-prechecks/bom-items", requireLogin, async (req, res) => {
  try {
    const submissionId = parseInt(req.query.submissionId, 10);
    if (!submissionId) {
      return res.json({ ok: false, error: "submissionId required" });
    }
    const filter = BOM_ITEM_FILTERS.includes(req.query.filter) ? req.query.filter : null;
    const items = await preCheckQ.getBomItems(submissionId, filter);
    res.json({ ok: true, items });
  } catch (err) {
    console.error("[ISO-PRECHECK API] bom-items:", err.message);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// GET /api/iso-prechecks/special-items?jobNo=&unitNo=&lineNo=
// Checker-added special items for a line (drawing-scoped, not tied to a
// specific pre-check submission/cycle). "IPMCS" items are a future second
// source (separate DB, not yet built) — not included in this response.
router.get("/iso-prechecks/special-items", requireLogin, async (req, res) => {
  try {
    const { jobNo, unitNo, lineNo } = req.query;
    if (!jobNo || !lineNo) {
      return res.json({ ok: false, error: "jobNo and lineNo required" });
    }
    const drawingId = await preCheckQ.findDrawingId(jobNo, unitNo, lineNo);
    if (!drawingId) {
      return res.json({ ok: true, items: [] });
    }
    const items = await preCheckQ.getSpecialItems(drawingId);
    res.json({ ok: true, items });
  } catch (err) {
    console.error("[ISO-PRECHECK API] special-items GET:", err.message);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// POST /api/iso-prechecks/special-items — checker-only
// Body: { jobNo, unitNo, lineNo, tag, description, category, qty }
router.post("/iso-prechecks/special-items", requireCheckerRole, async (req, res) => {
  try {
    const { jobNo, unitNo, lineNo, tag, description, category, qty } = req.body;
    if (!jobNo || !lineNo) {
      return res.status(400).json({ ok: false, error: "jobNo and lineNo required" });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ ok: false, error: "description required" });
    }
    const drawingId = await preCheckQ.findDrawingId(jobNo, unitNo, lineNo);
    if (!drawingId) {
      return res.status(404).json({ ok: false, error: "Line not found" });
    }
    const qtyNum = qty != null && qty !== "" ? Number(qty) : null;
    if (qtyNum != null && isNaN(qtyNum)) {
      return res.status(400).json({ ok: false, error: "qty must be a number" });
    }
    const item = await preCheckQ.addSpecialItem({
      drawingId,
      tag: tag ? String(tag).trim() : null,
      description: String(description).trim(),
      category: category ? String(category).trim() : null,
      qty: qtyNum,
      addedBy: req.session.user.id,
    });
    res.json({ ok: true, item });
  } catch (err) {
    console.error("[ISO-PRECHECK API] special-items POST:", err.message);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
