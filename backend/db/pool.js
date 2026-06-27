require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "pims_db",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("❌ Unexpected DB pool error:", err.message);
});

async function testConnection() {
  const client = await pool.connect();
  const result = await client.query("SELECT NOW() AS time, current_database() AS db");
  client.release();
  return result.rows[0];
}

module.exports = { pool, testConnection };
