"use strict";
const router  = require("express").Router();
const fs      = require("fs");
const path    = require("path");
const { requireAnyRole } = require("../middleware/auth");

const requireBatchAccess = requireAnyRole(
  'Modeller', 'Process Checker', 'Material Checker', 'Stress Checker', 'GL', 'SGL'
);

const BATCH_LOGS_DIR = path.join(__dirname, "..", "batch_logs");

const _batchEnv  = process.env.BATCH_INPUT_DIR;
const BATCH_INPUT = (_batchEnv && path.isAbsolute(_batchEnv))
  ? _batchEnv
  : path.join(__dirname, "..", _batchEnv || "batch_input");

// GET /api/admin/batch-logs — list job nos that have log subdirectories
router.get("/admin/batch-logs", requireBatchAccess, (req, res) => {
  try {
    if (!fs.existsSync(BATCH_LOGS_DIR)) return res.json({ ok: true, jobs: [] });
    const jobs = fs.readdirSync(BATCH_LOGS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
    res.json({ ok: true, jobs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/batch-logs/:jobNo — list log files for a job (last 15 days), newest first
router.get("/admin/batch-logs/:jobNo", requireBatchAccess, (req, res) => {
  try {
    const jobDir = path.resolve(BATCH_LOGS_DIR, req.params.jobNo);
    if (!jobDir.startsWith(BATCH_LOGS_DIR + path.sep)) {
      return res.status(400).json({ ok: false, error: "Invalid job no" });
    }
    if (!fs.existsSync(jobDir)) return res.json({ ok: true, logs: [] });

    const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(jobDir)
      .filter(f => f.endsWith(".json"))
      .filter(f => {
        try { return fs.statSync(path.join(jobDir, f)).mtimeMs >= cutoff; }
        catch { return false; }
      })
      .sort()
      .reverse();

    const logs = files.map(f => {
      try {
        const raw  = fs.readFileSync(path.join(jobDir, f), "utf8");
        const data = JSON.parse(raw);
        return { file: f, startedAt: data.startedAt, summary: data.summary };
      } catch {
        return { file: f, error: "Could not parse log" };
      }
    });

    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/batch-logs/:jobNo/:logfile — full detail of one run
router.get("/admin/batch-logs/:jobNo/:logfile", requireBatchAccess, (req, res) => {
  const jobDir  = path.resolve(BATCH_LOGS_DIR, req.params.jobNo);
  const logPath = path.resolve(jobDir, req.params.logfile);
  if (!jobDir.startsWith(BATCH_LOGS_DIR + path.sep) || !logPath.startsWith(jobDir + path.sep)) {
    return res.status(400).json({ ok: false, error: "Invalid path" });
  }
  if (!fs.existsSync(logPath)) return res.status(404).json({ ok: false, error: "Log not found" });
  try {
    const data = JSON.parse(fs.readFileSync(logPath, "utf8"));
    res.json({ ok: true, log: data });
  } catch {
    res.status(500).json({ ok: false, error: "Could not read log" });
  }
});

// GET /api/admin/batch-status — pending files in batch_input (read-only)
router.get("/admin/batch-status", requireBatchAccess, (req, res) => {
  try {
    if (!fs.existsSync(BATCH_INPUT)) return res.json({ ok: true, pending: [] });

    const pending = [];
    const jobFolders = fs.readdirSync(BATCH_INPUT)
      .filter(function (name) {
        if (name.startsWith("_")) return false;
        try { return fs.statSync(path.join(BATCH_INPUT, name)).isDirectory(); }
        catch { return false; }
      })
      .map(function (name) { return { name }; });

    for (const entry of jobFolders) {
      const jobDir = path.join(BATCH_INPUT, entry.name);
      const files  = fs.readdirSync(jobDir).filter(f => /\.pdf$/i.test(f));
      if (files.length) pending.push({ jobNo: entry.name, files, count: files.length });
    }

    res.json({ ok: true, pending, total: pending.reduce((s, j) => s + j.count, 0) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
