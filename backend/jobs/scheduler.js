"use strict";
const cron       = require("node-cron");
const { runBatch } = require("./batchUpload");

const schedule = process.env.BATCH_CRON_SCHEDULE || "*/10 * * * *"; // default: every 10 min

if (!cron.validate(schedule)) {
  console.error(`[SCHEDULER] Invalid cron expression: "${schedule}". Batch scheduler NOT started.`);
} else {
  cron.schedule(schedule, async () => {
    console.log(`[SCHEDULER] Triggering batch upload — schedule: ${schedule}`);
    try {
      await runBatch("scheduler");
    } catch (err) {
      console.error("[SCHEDULER] Batch run failed:", err.message);
    }
  });
  console.log(`[SCHEDULER] Batch upload scheduled — ${schedule}`);
}
