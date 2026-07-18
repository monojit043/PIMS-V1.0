const { pool } = require("../db/pool");

// GET /api/master-units?project=X
async function getMasterUnits(req, res) {
  const { project } = req.query;
  if (!project) return res.status(400).json({ ok: false, error: "project required" });
  try {
    const { rows } = await pool.query(
      `SELECT id, master_unit, child_unit, created_by, created_at
       FROM master_units WHERE project_id=$1 ORDER BY master_unit, child_unit`,
      [project]
    );
    res.json({ ok: true, mappings: rows });
  } catch (err) {
    console.error("getMasterUnits error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// POST /api/master-units
// Body: { projectId, masterUnit, childUnit }
async function setMasterUnit(req, res) {
  const { projectId, masterUnit, childUnit } = req.body;
  const userId = req.session.user.id;
  if (!projectId || !masterUnit || !childUnit)
    return res.status(400).json({ ok: false, error: "projectId, masterUnit, childUnit required" });
  if (masterUnit === childUnit)
    return res.status(400).json({ ok: false, error: "Master unit cannot be the same as child unit" });

  try {
    // A master unit must not itself be a child unit of another group in this project
    const { rows: masterIsChild } = await pool.query(
      `SELECT 1 FROM master_units WHERE project_id=$1 AND child_unit=$2 LIMIT 1`,
      [projectId, masterUnit]
    );
    if (masterIsChild.length > 0)
      return res.status(409).json({ ok: false, error: `Unit ${masterUnit} is already a child unit in another group. Cannot use as master.` });

    await pool.query(
      `INSERT INTO master_units (project_id, master_unit, child_unit, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, child_unit) DO UPDATE SET master_unit=$2, created_by=$4, created_at=NOW()`,
      [projectId, masterUnit, childUnit, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("setMasterUnit error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// DELETE /api/master-units
// Body: { projectId, childUnit }
async function deleteMasterUnit(req, res) {
  const { projectId, childUnit } = req.body;
  if (!projectId || !childUnit)
    return res.status(400).json({ ok: false, error: "projectId and childUnit required" });
  try {
    await pool.query(
      `DELETE FROM master_units WHERE project_id=$1 AND child_unit=$2`,
      [projectId, childUnit]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("deleteMasterUnit error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// GET /api/master-units/resolve?project=X&unit=Y
// Returns the effective master unit and all sibling child units for a given unit.
// If the unit has no master unit entry it is treated as standalone (its own master).
async function resolveMasterUnit(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit) return res.status(400).json({ ok: false, error: "project and unit required" });
  try {
    // Is this unit a child of a master group?
    const { rows: muRows } = await pool.query(
      `SELECT master_unit FROM master_units WHERE project_id=$1 AND child_unit=$2 LIMIT 1`,
      [project, unit]
    );
    if (muRows.length > 0) {
      const masterUnit = muRows[0].master_unit;
      const { rows: siblings } = await pool.query(
        `SELECT child_unit FROM master_units WHERE project_id=$1 AND master_unit=$2 ORDER BY child_unit`,
        [project, masterUnit]
      );
      return res.json({ ok: true, masterUnit, childUnits: siblings.map(r => r.child_unit), isGrouped: true });
    }
    // Is this unit itself a master unit (has children)?
    const { rows: childRows } = await pool.query(
      `SELECT child_unit FROM master_units WHERE project_id=$1 AND master_unit=$2 ORDER BY child_unit`,
      [project, unit]
    );
    if (childRows.length > 0) {
      return res.json({ ok: true, masterUnit: unit, childUnits: childRows.map(r => r.child_unit), isGrouped: true });
    }
    // Standalone
    res.json({ ok: true, masterUnit: unit, childUnits: [unit], isGrouped: false });
  } catch (err) {
    console.error("resolveMasterUnit error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

module.exports = { getMasterUnits, setMasterUnit, deleteMasterUnit, resolveMasterUnit };
