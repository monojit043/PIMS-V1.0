require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

const DATA_DIR = path.join(__dirname, "..", "data");

function readJson(file, fallback) {
  try {
    const txt = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- 1. Users ----
    const { users, projects } = readJson("login.json", { users: [], projects: [] });
    console.log(`Seeding ${users.length} users...`);
    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, name, password, is_hod)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name=$2, password=$3, is_hod=$4`,
        [u.id, u.name, u.password, Array.isArray(u.roles) && u.roles.includes("hod")]
      );
    }

    // ---- 2. Projects ----
    console.log(`Seeding ${projects.length} projects...`);
    for (const p of projects) {
      await client.query(
        `INSERT INTO projects (id, name, created_by, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name=$2`,
        [p.id, p.name, p.createdBy || null, p.createdDate ? new Date(p.createdDate) : new Date()]
      );

      // SGLs
      if (Array.isArray(p.sgls)) {
        for (const sglId of p.sgls) {
          await client.query(
            `INSERT INTO project_sgls (project_id, user_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [p.id, sglId]
          );
        }
      }

      // Units
      const units = p.units?.units || [];
      for (const unitNo of units) {
        await client.query(
          `INSERT INTO project_units (project_id, unit_no) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [p.id, unitNo]
        );
      }
    }

    // ---- 3. User role assignments ----
    console.log("Seeding user role assignments...");
    for (const u of users) {
      if (!u.projectAssignments) continue;
      for (const [projectId, pa] of Object.entries(u.projectAssignments)) {
        const unitMap = pa.units || {};
        for (const [unitNo, roles] of Object.entries(unitMap)) {
          for (const role of roles) {
            await client.query(
              `INSERT INTO user_role_assignments (user_id, project_id, unit_no, role)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [u.id, projectId, unitNo, role]
            );
          }
        }
      }
    }

    // ---- 4. Drawings ----
    const { drawings } = readJson("drawings.json", { drawings: [] });
    console.log(`Seeding ${drawings.length} drawings...`);
    for (const d of drawings) {
      const res = await client.query(
        `INSERT INTO drawings
           (job_no, unit_no, zone, line_no, file_name, file_path, stored_file,
            uploaded_by, uploaded_on, rev_no, status, upload_type, stress_critical,
            notify_modeller, notify_gl, all_roles_claimed,
            delegated_by_user, delegated_by_role, delegated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (job_no, unit_no, zone, line_no) DO UPDATE
           SET file_name=$5, file_path=$6, status=$11
         RETURNING id`,
        [
          d.jobNo, d.unitNo, d.zone, d.lineNo,
          d.fileName || null, d.filePath || null, d.storedFile || null,
          d.uploadedBy || null,
          d.uploadedOn ? new Date(d.uploadedOn) : new Date(),
          d.revNo || 0,
          d.status || "Uploaded",
          d.uploadType || null,
          d.stressCritical || "N",
          d.notifyModeller || false,
          d.notifyGL || false,
          d.allRolesClaimed || false,
          d.delegatedBy?.userId || null,
          d.delegatedBy?.role || null,
          d.delegatedBy?.timestamp ? new Date(d.delegatedBy.timestamp) : null,
        ]
      );
      const drawingId = res.rows[0].id;

      // History
      for (const fileName of (d.history || [])) {
        await client.query(
          `INSERT INTO drawing_history (drawing_id, file_name) VALUES ($1, $2)`,
          [drawingId, fileName]
        );
      }

      // Claims
      if (d.claimedBy && typeof d.claimedBy === "object") {
        for (const [userId, claimData] of Object.entries(d.claimedBy)) {
          const roles = claimData?.roles || [];
          if (roles.length) {
            await client.query(
              `INSERT INTO drawing_claims (drawing_id, user_id, roles)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [drawingId, userId, roles]
            );
          }
        }
      }

      // Comments
      for (const c of (d.comments || [])) {
        const roles = Array.isArray(c.roles) ? c.roles : c.role ? [c.role] : [];
        await client.query(
          `INSERT INTO drawing_comments (drawing_id, user_id, roles, type, body, file_name, file_path, delegated_to, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            drawingId,
            c.userId || c.uploadedBy || null,
            roles,
            c.type || null,
            c.text || null,
            c.fileName || null,
            c.filePath || null,
            c.delegatedTo || null,
            c.uploadedOn ? new Date(c.uploadedOn) : new Date(),
          ]
        );
      }

      // Comment files
      for (const cf of (d.commentFiles || [])) {
        const uploadedBy = Array.isArray(cf.uploadedBy) ? cf.uploadedBy : cf.uploadedBy ? [cf.uploadedBy] : [];
        await client.query(
          `INSERT INTO drawing_comment_files (drawing_id, file_name, file_path, roles, uploaded_by, type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [drawingId, cf.fileName, cf.filePath || null, cf.roles || null, uploadedBy, cf.type || null]
        );
      }
    }

    // ---- 5. Stress lines ----
    const { stressLines } = readJson("stress.json", { stressLines: [] });
    console.log(`Seeding ${stressLines.length} stress lines...`);
    for (const s of stressLines) {
      await client.query(
        `INSERT INTO stress_lines (line_id, stress_system, dept, uploaded_on, uploaded_by, source_file)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (line_id) DO NOTHING`,
        [
          s.line_id, s.stress_system || null, s.dept || null,
          s.uploadedOn ? new Date(s.uploadedOn) : new Date(),
          s.uploadedBy || null, s.sourceFile || null,
        ]
      );
    }

    await client.query("COMMIT");
    console.log("✅ Seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
});
