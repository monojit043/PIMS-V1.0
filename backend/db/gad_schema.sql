-- ============================================================
-- GAD (General Arrangement Drawing) Schema
-- Purpose : Standalone module for GAD document management.
--           Mirrors the ISO approval workflow but is completely
--           independent — no existing table is modified.
--
-- GAD Number Format:
--   B862-101-16-43-02203
--   └──┘ └─┘ └──┘ └───┘
--   job  unit type  serial (5 digits)
--                   └── first 3 digits = area (022 → area 22)
--
-- IMPORTANT: This file only ADDS new tables.
--            No existing table is modified.
--            Safe to run on top of schema.sql at any time.
--
-- Table overview:
--   gads                  → master record per GAD document
--   gad_history           → upload / revision history
--   gad_claims            → role-based claim tracking
--   gad_comments          → checker comments and hold notes
--   gad_comment_files     → annotated PDFs attached to comments
--   gad_pdf_submissions   → one row per upload cycle (Rx-y)
--   gad_pre_check_results → automated validation results per cycle
--   gad_lots              → lot records for GAD issuance
--   gad_lot_lines         → GAD documents inside a lot
-- ============================================================


-- ============================================================
-- TABLE 1: gads
--
-- Master record for each GAD document.
-- One row per unique GAD number.
-- Mirrors drawings table — same status flow, same role model.
-- ============================================================
CREATE TABLE IF NOT EXISTS gads (
  id                  SERIAL        PRIMARY KEY,

  -- ── Document identification ───────────────────────────────
  job_no              VARCHAR(50)   NOT NULL,
  unit_no             VARCHAR(50)   NOT NULL,

  -- Extracted from serial_no: parseInt(serial_no[0..2])
  -- e.g. serial "02203" → area_no "22"
  area_no             VARCHAR(10)   NOT NULL,

  -- The middle type-sequence segment, e.g. "16-43"
  gad_type_seq        VARCHAR(20),

  -- 5-digit serial, e.g. "02203"
  serial_no           VARCHAR(10)   NOT NULL,

  -- Full GAD number as uploaded, e.g. "B862-101-16-43-02203"
  -- Stored in full so display and search never need to reconstruct it.
  gad_no              VARCHAR(100)  NOT NULL,

  -- ── File storage ──────────────────────────────────────────
  file_name           VARCHAR(500),
  file_path           VARCHAR(1000),

  -- Final stored filename on disk:
  -- {gad_no}_R{rev_no}-{cycle_no}.pdf
  -- e.g. B862-101-16-43-02203_R0-1.pdf
  stored_file         VARCHAR(500),

  -- ── Revision tracking ─────────────────────────────────────
  -- Starts at 0 (R0). Increments when a Final GAD is reopened
  -- for a new revision cycle — same logic as drawings.rev_no.
  rev_no              INTEGER       NOT NULL DEFAULT 0,

  -- ── Workflow ──────────────────────────────────────────────
  -- Same status strings as drawings table:
  -- Uploaded → Under Review → Ready for GL → Ready for SGL → Final
  status              VARCHAR(100)  NOT NULL DEFAULT 'Uploaded',

  upload_type         VARCHAR(50),

  -- Whether stress checker is required for this GAD.
  -- Same flag as drawings.stress_critical.
  stress_critical     CHAR(1)       NOT NULL DEFAULT 'N',

  -- ── Notification flags ────────────────────────────────────
  -- Set TRUE by application to trigger SSE push to modeller or GL.
  -- Cleared after notification is delivered — same pattern as drawings.
  notify_modeller     BOOLEAN       NOT NULL DEFAULT FALSE,
  notify_gl           BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Set TRUE when all required role claims are in place.
  all_roles_claimed   BOOLEAN       NOT NULL DEFAULT FALSE,

  -- ── Delegation tracking ───────────────────────────────────
  delegated_by_user   VARCHAR(20)   REFERENCES users(id),
  delegated_by_role   VARCHAR(50),
  delegated_at        TIMESTAMPTZ,

  -- ── Audit ─────────────────────────────────────────────────
  uploaded_by         VARCHAR(20)   REFERENCES users(id),
  uploaded_on         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- A GAD number is unique within a job+unit+area combination.
  UNIQUE (job_no, unit_no, area_no, gad_no)
);


-- ============================================================
-- TABLE 2: gad_history
--
-- Tracks every stored filename across all upload cycles.
-- One row per PDF upload event.
-- Mirrors drawing_history.
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_history (
  id          SERIAL        PRIMARY KEY,
  gad_id      INTEGER       NOT NULL REFERENCES gads(id) ON DELETE CASCADE,
  file_name   VARCHAR(500)  NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- ============================================================
-- TABLE 3: gad_claims
--
-- Tracks which user has claimed a GAD for which roles.
-- One row per user per GAD (roles stored as an array).
-- Mirrors drawing_claims (including the two ALTER-added columns).
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_claims (
  id           SERIAL        PRIMARY KEY,
  gad_id       INTEGER       NOT NULL REFERENCES gads(id) ON DELETE CASCADE,
  user_id      VARCHAR(20)   NOT NULL REFERENCES users(id),
  roles        TEXT[]        NOT NULL,

  -- What kind of comment action was last recorded for this claim.
  -- e.g. 'hold', 'clear', 'comment' — same semantics as drawing_claims.
  comment_type VARCHAR(50),

  claimed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  UNIQUE (gad_id, user_id)
);


-- ============================================================
-- TABLE 4: gad_comments
--
-- Checker comments and hold/clear notes on a GAD.
-- One row per comment event.
-- Mirrors drawing_comments.
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_comments (
  id           SERIAL        PRIMARY KEY,
  gad_id       INTEGER       NOT NULL REFERENCES gads(id) ON DELETE CASCADE,
  user_id      VARCHAR(20)   REFERENCES users(id),
  roles        TEXT[],

  -- e.g. 'hold', 'clear', 'gl_hold', 'gl_clear', 'sgl_hold', 'sgl_clear'
  type         VARCHAR(50),

  body         TEXT,
  file_name    VARCHAR(500),
  file_path    VARCHAR(1000),

  -- Roles this comment was delegated to for action.
  delegated_to TEXT[],

  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- ============================================================
-- TABLE 5: gad_comment_files
--
-- Annotated PDF files attached to a GAD comment event.
-- One row per annotation file.
-- Mirrors drawing_comment_files.
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_comment_files (
  id           SERIAL        PRIMARY KEY,
  gad_id       INTEGER       NOT NULL REFERENCES gads(id) ON DELETE CASCADE,
  file_name    VARCHAR(500)  NOT NULL,
  file_path    VARCHAR(1000),
  roles        TEXT[],
  uploaded_by  TEXT[],

  -- e.g. 'annotation', 'markup'
  type         VARCHAR(50),

  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- ============================================================
-- TABLE 6: gad_pdf_submissions
--
-- One record per PDF upload cycle for a GAD.
-- R0-1 = rev_no 0, cycle_no 1 (first upload of revision 0)
-- R0-2 = rev_no 0, cycle_no 2 (re-uploaded same revision)
-- R1-1 = rev_no 1, cycle_no 1 (new revision, cycle resets)
--
-- Mirrors iso_pdf_submissions — same active/superseded logic,
-- same parse status lifecycle, same hash-based duplicate detection.
-- IDF columns are omitted (GAD does not have an IDF equivalent).
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_pdf_submissions (
  id                    SERIAL        PRIMARY KEY,

  -- ── Link to master GAD record ─────────────────────────────
  gad_id                INTEGER       NOT NULL
                        REFERENCES gads(id) ON DELETE CASCADE,

  -- Back-link to gad_history row for this upload event.
  -- SET NULL on delete so this record survives if history is pruned.
  gad_history_id        INTEGER
                        REFERENCES gad_history(id) ON DELETE SET NULL,

  -- ── Cycle identification ───────────────────────────────────
  -- Snapshot of gads.rev_no at upload time — never changes.
  rev_no                INTEGER       NOT NULL,

  -- Counter within the same revision. Starts at 1, increments
  -- for each upload of the same gad_id + rev_no.
  -- Application computes MAX(cycle_no)+1 inside a transaction.
  cycle_no              INTEGER       NOT NULL,

  -- ── PDF file details ──────────────────────────────────────
  pdf_file_name         VARCHAR(500),
  pdf_file_path         VARCHAR(1000),

  -- SHA-256 hash of the PDF bytes.
  -- Detects identical re-uploads so pre-checks can be reused.
  pdf_hash              VARCHAR(64),

  -- ── Data extracted from PDF title block ───────────────────
  extracted_gad_no      VARCHAR(100),  -- GAD number read from title block
  extracted_rev         VARCHAR(20),   -- revision shown in title block
  extracted_date        VARCHAR(50),   -- date shown in title block
  extracted_sheet_count INTEGER,       -- number of sheets found in the PDF

  -- ── Parse job status ──────────────────────────────────────
  -- PENDING  : queued, parser not started
  -- PARSING  : parser actively working
  -- DONE     : parsing completed successfully
  -- FAILED   : parsing failed, see parse_error
  parse_status          VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  parse_started_at      TIMESTAMPTZ,
  parse_completed_at    TIMESTAMPTZ,
  parse_error           TEXT,

  -- ── Active / superseded tracking ──────────────────────────
  -- When the same GAD is re-uploaded before review starts,
  -- the old submission is marked inactive and a new cycle created.
  -- Mirrors exact behaviour of iso_pdf_submissions.is_active.
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  superseded_at         TIMESTAMPTZ,
  superseded_by         INTEGER,
  -- FK to self added below as ALTER TABLE (avoids forward reference)

  -- ── Audit ─────────────────────────────────────────────────
  uploaded_by           VARCHAR(20)   REFERENCES users(id),
  uploaded_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (gad_id, rev_no, cycle_no)
);

-- Self-referencing FK: superseded_by → newer submission that replaced this one.
ALTER TABLE gad_pdf_submissions
  ADD CONSTRAINT fk_gad_subs_superseded_by
  FOREIGN KEY (superseded_by)
  REFERENCES gad_pdf_submissions(id)
  ON DELETE SET NULL;


-- ============================================================
-- TABLE 7: gad_pre_check_results
--
-- One row per check per submission cycle.
-- GAD-specific checks (no weld logic — GADs carry no weld tables):
--
--   Check A:
--     GAD_NO_MATCH        GAD number in PDF title block matches system record
--     REVISION_IN_PDF     PDF revision matches system revision
--                         (triggered at revision boundary R0→R1 only)
--
--   Check B:
--     SHEET_COMPLETENESS  All sheets present (sheet 1 of N … N of N found)
--     SCALE_PRESENT       At least one sheet carries a scale notation
--     REV_CLOUD_PRESENT   Revision clouds present when rev_no > 0
--
-- Mirrors iso_pre_check_results — same result values, same checker
-- action vocabulary, same confidence model.
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_pre_check_results (
  id                    SERIAL        PRIMARY KEY,

  -- Link to the cycle this check belongs to
  submission_id         INTEGER       NOT NULL
                        REFERENCES gad_pdf_submissions(id) ON DELETE CASCADE,

  -- ── Check identification ───────────────────────────────────
  check_code            VARCHAR(50)   NOT NULL,
  check_name            VARCHAR(200)  NOT NULL,

  -- ── Result ────────────────────────────────────────────────
  -- PASS  : check passed, no action needed
  -- FAIL  : definitive failure
  -- FLAG  : needs checker attention, not a hard failure
  -- ERROR : system could not perform the check
  result                VARCHAR(20)   NOT NULL,

  -- Flexible JSON blob for check-specific details.
  -- GAD_NO_MATCH example:
  --   { "extracted": "B862-101-16-43-02203", "system": "B862-101-16-43-02203", "match": true }
  -- SHEET_COMPLETENESS example:
  --   { "expected": 4, "found": [1,2,4], "missing": [3] }
  detail                JSONB,

  -- PDF_PARSED : result came from PDF text extraction
  -- MANUAL     : checker entered manually
  source                VARCHAR(20)   NOT NULL DEFAULT 'PDF_PARSED',

  -- HIGH / MEDIUM / LOW — same confidence model as ISO checks
  confidence            VARCHAR(10)   NOT NULL DEFAULT 'MEDIUM',

  -- ── Checker action ────────────────────────────────────────
  -- FALSE for all non-PASS results until checker acts.
  -- PASS results are auto-set TRUE at creation.
  checker_actioned      BOOLEAN       NOT NULL DEFAULT FALSE,

  -- AUTO_ACKNOWLEDGED / ACKNOWLEDGED / CONFIRMED_INTENTIONAL /
  -- OVERRIDE / REJECTED / RAISE_QUERY
  -- Same action vocabulary as ISO pre-checks.
  checker_action        VARCHAR(30),
  checker_comment       TEXT,
  actioned_by           VARCHAR(20)   REFERENCES users(id),
  actioned_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- One result per check type per cycle
  UNIQUE (submission_id, check_code)
);


-- ============================================================
-- TABLE 8: gad_lots
--
-- Lot records for GAD issuance.
-- Completely independent of the ISO lots table.
-- Mirrors lots table structure.
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_lots (
  id          SERIAL       PRIMARY KEY,
  lot_number  INTEGER      NOT NULL,
  job_no      VARCHAR(50)  NOT NULL,
  unit_no     VARCHAR(50)  NOT NULL,
  created_by  VARCHAR(50)  NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  issued_at   TIMESTAMPTZ  DEFAULT NULL
);


-- ============================================================
-- TABLE 9: gad_lot_lines
--
-- Which GAD documents belong to a lot.
-- Mirrors lot_lines — references gads(id), not drawings(id).
-- ============================================================
CREATE TABLE IF NOT EXISTS gad_lot_lines (
  lot_id      INTEGER NOT NULL REFERENCES gad_lots(id) ON DELETE CASCADE,
  gad_id      INTEGER NOT NULL REFERENCES gads(id),
  file_path   TEXT    DEFAULT NULL,
  PRIMARY KEY (lot_id, gad_id)
);


-- ============================================================
-- INDEXES
-- ============================================================

-- gads
CREATE INDEX IF NOT EXISTS idx_gads_job_unit        ON gads(job_no, unit_no);
CREATE INDEX IF NOT EXISTS idx_gads_job_unit_area   ON gads(job_no, unit_no, area_no);
CREATE INDEX IF NOT EXISTS idx_gads_gad_no          ON gads(gad_no);
CREATE INDEX IF NOT EXISTS idx_gads_status          ON gads(status);

-- gad_history
CREATE INDEX IF NOT EXISTS idx_gad_history_gad      ON gad_history(gad_id);

-- gad_claims
CREATE INDEX IF NOT EXISTS idx_gad_claims_gad       ON gad_claims(gad_id);

-- gad_comments
CREATE INDEX IF NOT EXISTS idx_gad_comments_gad     ON gad_comments(gad_id);

-- gad_comment_files
CREATE INDEX IF NOT EXISTS idx_gad_comment_files    ON gad_comment_files(gad_id);

-- gad_pdf_submissions
CREATE INDEX IF NOT EXISTS idx_gad_subs_gad         ON gad_pdf_submissions(gad_id);
CREATE INDEX IF NOT EXISTS idx_gad_subs_rev_cycle   ON gad_pdf_submissions(gad_id, rev_no, cycle_no);
CREATE INDEX IF NOT EXISTS idx_gad_subs_parse       ON gad_pdf_submissions(parse_status);
CREATE INDEX IF NOT EXISTS idx_gad_subs_hash        ON gad_pdf_submissions(pdf_hash);
CREATE INDEX IF NOT EXISTS idx_gad_subs_active      ON gad_pdf_submissions(gad_id, is_active);

-- gad_pre_check_results
CREATE INDEX IF NOT EXISTS idx_gad_checks_sub       ON gad_pre_check_results(submission_id);
CREATE INDEX IF NOT EXISTS idx_gad_checks_actioned  ON gad_pre_check_results(submission_id, checker_actioned);
CREATE INDEX IF NOT EXISTS idx_gad_checks_result    ON gad_pre_check_results(result);

-- gad_lots
CREATE INDEX IF NOT EXISTS idx_gad_lots_job_unit    ON gad_lots(job_no, unit_no);

-- gad_lot_lines
CREATE INDEX IF NOT EXISTS idx_gad_lot_lines_lot    ON gad_lot_lines(lot_id);
CREATE INDEX IF NOT EXISTS idx_gad_lot_lines_gad    ON gad_lot_lines(gad_id);
