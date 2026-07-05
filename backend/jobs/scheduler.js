"use strict";
const cron       = require("node-cron");
const { runBatch } = require("./batchUpload");
const { runExport } = require("./s3dExport");

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

// Daily, ahead of S3D's own 20:00 scheduler — gives S3D's evening lock batch
// a finished file to read before it runs.
const s3dSchedule = process.env.S3D_EXPORT_CRON_SCHEDULE || "30 19 * * *"; // default: 19:30 daily

if (!cron.validate(s3dSchedule)) {
  console.error(`[SCHEDULER] Invalid cron expression: "${s3dSchedule}". S3D export scheduler NOT started.`);
} else {
  cron.schedule(s3dSchedule, async () => {
    console.log(`[SCHEDULER] Triggering S3D lock feed export — schedule: ${s3dSchedule}`);
    try {
      await runExport("scheduler");
    } catch (err) {
      console.error("[SCHEDULER] S3D export run failed:", err.message);
    }
  });
  console.log(`[SCHEDULER] S3D lock feed export scheduled — ${s3dSchedule}`);
}
