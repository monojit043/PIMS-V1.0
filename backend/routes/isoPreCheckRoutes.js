"use strict";
const router = require("express").Router();
const { requireLogin } = require("../middleware/auth");
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

module.exports = router;
