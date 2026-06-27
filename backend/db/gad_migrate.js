require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function migrate() {
  const files = ["gad_schema.sql"];
  const client = await pool.connect();
  try {
    for (const file of files) {
      const filePath = path.join(__dirname, file);
      if (!fs.existsSync(filePath)) {
        console.log(`⏭  Skipping ${file} (not found)`);
        continue;
      }
      console.log(`Running ${file}...`);
      const sql = fs.readFileSync(filePath, "utf8");
      await client.query(sql);
      console.log(`✅ ${file} applied.`);
    }
    console.log("✅ GAD migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("❌ GAD migration failed:", err.message);
  process.exit(1);
});
