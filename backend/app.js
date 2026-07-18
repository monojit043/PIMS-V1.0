require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const { pool } = require("./db/pool");
const PgSessionStore = require("./db/pgSessionStore");

const noCache = require("./middleware/noCache");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const projectRoutes = require("./routes/projectRoutes");
const drawingRoutes = require("./routes/drawingRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const stressRoutes = require("./routes/stressRoutes");
const reportRoutes = require("./routes/reportRoutes");
const lotRoutes          = require("./routes/lotRoutes");
const dashboardRoutes    = require("./routes/dashboardRoutes");
const linelistNormRoutes = require("./routes/linelistNormRoutes");
const batchRoutes        = require("./routes/batchRoutes");
const inchRoutes         = require("./routes/inchRoutes");
const lmsRoutes          = require("./routes/lmsRoutes");
const stressIndexRoutes  = require("./routes/stressIndexRoutes");
const isoPreCheckRoutes  = require("./routes/isoPreCheckRoutes");
const gadRoutes          = require("./routes/gadRoutes");
const masterUnitRoutes   = require("./routes/masterUnitRoutes");

const app = express();

// ---------- BASIC MIDDLEWARE ----------
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---------- SESSION ----------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "pims-secret",
    resave: false,
    saveUninitialized: false,
    store: new PgSessionStore(pool),
    cookie: { maxAge: 8 * 60 * 60 * 1000 },
  })
);

// ---------- NO-CACHE FOR API ----------
app.use("/api", noCache);

// ---------- STATIC FILES ----------
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

// ---------- API ROUTES ----------
app.use("/api", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api", drawingRoutes);
app.use("/api", notificationRoutes);
app.use("/api", stressRoutes);
app.use("/api", reportRoutes);
app.use("/api", lotRoutes);
app.use("/api", dashboardRoutes);
app.use("/api", linelistNormRoutes);
app.use("/api", batchRoutes);
app.use("/api", inchRoutes);
app.use("/api", lmsRoutes);
app.use("/api", stressIndexRoutes);
app.use("/api", isoPreCheckRoutes);
app.use("/api", gadRoutes);
app.use("/api", masterUnitRoutes);

// ---------- HEALTH CHECK ----------
app.get("/api/health", (req, res) => res.json({ status: "OK", db: "PostgreSQL" }));

// ---------- ROOT ----------
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---------- GLOBAL ERROR HANDLER ----------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ ok: false, error: err.message || "Internal server error" });
});

module.exports = app;
