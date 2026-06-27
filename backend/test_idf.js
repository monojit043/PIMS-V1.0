require("dotenv").config();
const { Pool } = require("pg");
const { findIdfForLine } = require("./services/isoIdfFetcher");

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function run() {
  // 1. Check if drawing exists
  const { rows } = await pool.query(
    "SELECT id, job_no, line_no, unit_no, zone FROM drawings WHERE line_no = $1 LIMIT 1",
    ["AI-111-92215-C"]
  );

  if (rows.length === 0) {
    console.log("[TEST] Drawing AI-111-92215-C NOT found in DB — upload it first via the UI.");
    await pool.end();
    return;
  }

  const drawing = rows[0];
  console.log("[TEST] Drawing found:", drawing);

  // 2. Simulate what isoPreCheckService will do — fetch the IDF
  const idfResult = findIdfForLine(drawing.line_no, drawing.job_no, null);
  console.log("[TEST] IDF fetch result:", JSON.stringify(idfResult, null, 2));

  await pool.end();
}

run().catch(e => { console.error(e.message); pool.end(); });
