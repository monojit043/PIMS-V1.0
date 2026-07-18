require("dotenv").config();
const app = require("./app");
const os = require("os");
const { testConnection } = require("./db/pool");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

async function start() {
  try {
    const dbInfo = await testConnection();
    console.log(`✅ PostgreSQL connected — DB: ${dbInfo.db} | Time: ${dbInfo.time}`);
  } catch (err) {
    console.error("❌ PostgreSQL connection FAILED:", err.message);
    console.error("   Check .env — DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD");
    process.exit(1);
  }

  // Run all DDL before accepting connections to avoid deadlocks with incoming requests
  try {
    const { initLotTables } = require("./controllers/lotController");
    await initLotTables();
    console.log("✅ Lot tables ready");
  } catch (err) {
    console.error("⚠️  initLotTables error (non-fatal):", err.message);
  }

  // Start batch upload scheduler (reads BATCH_CRON_SCHEDULE from .env, defaults to 6 AM daily)
  require("./jobs/scheduler");

  app.listen(PORT, HOST, () => {
    console.log("🚀 PIMS Server started");
    console.log(`👉 Local:   http://localhost:${PORT}`);
    console.log(`👉 Network: http://${getLocalIP()}:${PORT}`);
  });
}

start();
