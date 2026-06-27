-- ============================================================
-- ISO Pre-Check Tables
-- Purpose : Automated PDF parsing and pre-check results
--           shown to checker when a task is opened.
--           Runs on every cycle (R0-1, R0-2, R1-1 etc.)
--
-- IMPORTANT: This file only ADDS new tables.
--            No existing table is modified.
--            Safe to run on top of schema.sql at any time.
--
-- IDF Integration Note:
--   All IDF-related columns are included now but nullable.
--   When IDF phase is implemented, populate those columns.
--   No schema change will be needed at that point.
--
-- Table overview:
--   iso_pdf_submissions   → one row per Rx-y cycle (each PDF upload)
--   iso_pre_check_results → one row per check per cycle
--   iso_weld_records      → one row per weld per cycle
-- ============================================================


-- ============================================================
-- TABLE 1: iso_pdf_submissions
--
-- One record for every PDF upload event.
-- R0-1 = rev_no 0, cycle_no 1
-- R0-2 = rev_no 0, cycle_no 2
-- R1-1 = rev_no 1, cycle_no 1  (cycle_no resets per revision)
--
-- Links to existing drawings(id) — no change to drawings table.
-- ============================================================
CREATE TABLE IF NOT EXISTS iso_pdf_submissions (
  id                    SERIAL        PRIMARY KEY,

  -- ── Link to existing workflow ──────────────────────────────
  -- References drawings.id (existing table, not modified)
  drawing_id            INTEGER       NOT NULL
                        REFERENCES drawings(id) ON DELETE CASCADE,

  -- Optional back-link to drawing_history when that record
  -- exists for the same upload event.
  -- SET NULL on delete so our record survives if history is pruned.
  drawing_history_id    INTEGER
                        REFERENCES drawing_history(id) ON DELETE SET NULL,

  -- ── Cycle identification ───────────────────────────────────
  -- Taken from drawings.rev_no at the moment of upload.
  -- Stored here so it never changes even if drawings.rev_no moves on.
  rev_no                INTEGER       NOT NULL,

  -- Counter within the same revision. Starts at 1, increments
  -- each upload for the same drawing + rev_no.
  -- Application computes: MAX(cycle_no)+1 for (drawing_id, rev_no)
  -- before inserting. Must be done inside a transaction.
  cycle_no              INTEGER       NOT NULL,

  -- ── PDF file details ──────────────────────────────────────
  pdf_file_name         VARCHAR(500),
  pdf_file_path         VARCHAR(1000),

  -- SHA-256 hash of the PDF bytes.
  -- Lets system detect if an identical PDF is re-uploaded
  -- without changes → can reuse existing parse results.
  pdf_hash              VARCHAR(64),

  -- ── Data extracted from PDF title block ───────────────────
  -- These are what the parser found IN the PDF.
  -- Used for Check A (line number match) and revision boundary check.
  extracted_line_no     VARCHAR(200),  -- line number from title block
  extracted_rev         VARCHAR(20),   -- revision shown in title block
  extracted_date        VARCHAR(50),   -- date shown in title block
  extracted_sheet_count INTEGER,       -- total number of sheets parsed

  -- Timestamp from PDF metadata (CreationDate field).
  -- Used for IDF matching when IDF phase is implemented.
  pdf_generated_at      TIMESTAMPTZ,

  -- ── Parse job status ──────────────────────────────────────
  -- PENDING  : queued, parser not started yet
  -- PARSING  : parser actively working
  -- DONE     : parsing completed successfully
  -- FAILED   : parsing failed, see parse_error
  parse_status          VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  parse_started_at      TIMESTAMPTZ,
  parse_completed_at    TIMESTAMPTZ,
  parse_error           TEXT,         -- populated only when FAILED

  -- ── IDF integration columns (future phase) ────────────────
  -- All nullable. Populated when IDF watcher is implemented.
  -- No schema change needed at that time.
  idf_file_name         VARCHAR(500),
  idf_file_path         VARCHAR(1000),

  -- Timestamp read from IDF field -609 (exact generation time).
  -- This is the primary key for IDF↔PDF matching.
  idf_generated_at      TIMESTAMPTZ,

  -- When the IDF physically arrived in the drop folder.
  idf_received_at       TIMESTAMPTZ,

  -- When the system confirmed this IDF matches this PDF.
  idf_matched_at        TIMESTAMPTZ,

  -- How the match was established:
  -- AUTO_WATCHER  : captured from drop folder at generation time
  -- TIMESTAMP     : matched by line_no + timestamp comparison
  -- MANUAL_UPLOAD : user manually paired them
  idf_match_method      VARCHAR(30),

  -- ── Active / superseded tracking ──────────────────────────
  -- Critical for handling the batch job behaviour:
  -- When a never-claimed drawing is batch-replaced, the batch
  -- keeps the SAME drawing.id and SAME stored filename but writes
  -- a NEW PDF on disk. The old submission's parse results become
  -- stale. When the pre-check trigger detects the new upload
  -- (via pdf_hash mismatch), it:
  --   1. Sets is_active=FALSE, superseded_at=NOW() on old row
  --   2. Sets superseded_by to the new submission's id
  --   3. Creates a new row (next cycle_no) for the new PDF
  -- This means pre-check history is preserved (not deleted)
  -- and the checker always sees only the active cycle's results.
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  superseded_at         TIMESTAMPTZ,
  superseded_by         INTEGER,
  -- FK to self added below as ALTER TABLE (avoids forward reference)

  -- ── Audit ─────────────────────────────────────────────────
  uploaded_by           VARCHAR(20)   REFERENCES users(id),
  uploaded_at           TIMESTAMPTZ   DEFAULT NOW(),

  -- Prevents duplicate active cycle records for same drawing + revision.
  -- Note: superseded rows (is_active=FALSE) for same (drawing_id, rev_no, cycle_no)
  -- are not possible because cycle_no always increments before insert.
  UNIQUE (drawing_id, rev_no, cycle_no)
);

-- Self-referencing FK: superseded_by points to the newer submission
-- that replaced this one. Added as ALTER to avoid forward reference issue.
ALTER TABLE iso_pdf_submissions
  ADD CONSTRAINT fk_iso_subs_superseded_by
  FOREIGN KEY (superseded_by)
  REFERENCES iso_pdf_submissions(id)
  ON DELETE SET NULL;


-- ============================================================
-- TABLE 2: iso_pre_check_results
--
-- One row per check per submission.
-- Multiple checks run per cycle:
--
--   Check A  (PDF phase):
--     LINE_NO_MATCH       line number in PDF matches system record
--     REVISION_IN_PDF     PDF revision matches system revision
--                         (only triggered at revision boundary R0→R1)
--
--   Check B  (PDF phase):
--     WELD_CONTINUITY     weld numbers sequential, no gaps
--     WELD_NO_DUPLICATES  same weld number not on two sheets
--     WELD_TYPES_PRESENT  every weld has FW or SW assigned
--     WELD_COUNT_DELTA    count vs immediate previous cycle
--
--   Check C  (next phase, not yet implemented):
--     MATERIAL_VS_SPEC    each BOM item matches pipe class spec
--
--   IDF checks (future phase, not yet implemented):
--     FLOW_DIRECTION      flow arrow present on ISO
--     HIGH_POINT_VENT     vent exists at every high point
--     LOW_POINT_DRAIN     drain exists at every low point
--     COORD_CONTINUATION  coordinates match connecting ISOs
-- ============================================================
CREATE TABLE IF NOT EXISTS iso_pre_check_results (
  id                    SERIAL        PRIMARY KEY,

  -- Link to the cycle this check belongs to
  submission_id         INTEGER       NOT NULL
                        REFERENCES iso_pdf_submissions(id) ON DELETE CASCADE,

  -- ── Check identification ───────────────────────────────────
  -- Short code used in application logic.
  -- Kept as VARCHAR (not enum) so new check types can be added
  -- without a schema migration.
  check_code            VARCHAR(50)   NOT NULL,
  check_name            VARCHAR(200)  NOT NULL,

  -- ── Result ────────────────────────────────────────────────
  -- PASS  : check passed, no action needed from checker
  -- FAIL  : definitive failure (e.g. line number mismatch)
  -- FLAG  : needs checker attention but not a hard failure
  --         (e.g. weld count changed within same revision)
  -- ERROR : system could not perform the check
  --         (e.g. could not extract text from PDF)
  result                VARCHAR(20)   NOT NULL,

  -- Flexible JSON blob for check-specific details.
  -- LINE_NO_MATCH example:
  --   { "extracted": "6\"-P-111-...", "system": "6\"-P-111-...", "match": true }
  -- WELD_COUNT_DELTA example:
  --   { "prev_cycle": "R0-1", "prev_count": 81, "curr_count": 79,
  --     "diff": -2, "revision_boundary": false }
  detail                JSONB,

  -- ── Source and confidence ──────────────────────────────────
  -- PDF_PARSED : result came from PDF text extraction
  -- IDF_PARSED : result came from IDF parsing (future)
  -- MANUAL     : checker entered manually
  source                VARCHAR(20)   NOT NULL DEFAULT 'PDF_PARSED',

  -- HIGH   : IDF-sourced (exact, structured data)
  -- MEDIUM : PDF-sourced (text layer, CAD-generated PDF)
  -- LOW    : PDF-sourced (scanned or poor quality)
  confidence            VARCHAR(10)   NOT NULL DEFAULT 'MEDIUM',

  -- ── IDF upgrade fields (future phase) ─────────────────────
  -- When IDF is implemented, re-run same checks from IDF data.
  -- Store IDF result alongside PDF result for comparison.
  -- These columns stay NULL until IDF phase.
  idf_verified_at       TIMESTAMPTZ,
  idf_result            VARCHAR(20),
  idf_detail            JSONB,

  -- ── Checker action ────────────────────────────────────────
  -- Whether checker has actioned this check result.
  -- PASS results are auto-set to TRUE by application at creation.
  -- Non-PASS results remain FALSE until checker acts.
  checker_actioned      BOOLEAN       NOT NULL DEFAULT FALSE,

  -- What action the checker took:
  -- AUTO_ACKNOWLEDGED   : system auto-set for PASS results
  -- ACKNOWLEDGED        : checker manually acknowledged PASS
  -- CONFIRMED_INTENTIONAL : checker confirmed FLAG was expected
  -- OVERRIDE            : checker overrode a FAIL (comment required)
  -- REJECTED            : checker rejected PDF (triggers re-upload)
  -- RAISE_QUERY         : checker raised query to designer
  checker_action        VARCHAR(30),
  checker_comment       TEXT,         -- required for OVERRIDE and RAISE_QUERY
  actioned_by           VARCHAR(20)   REFERENCES users(id),
  actioned_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ   DEFAULT NOW(),

  -- Only one result per check type per cycle
  UNIQUE (submission_id, check_code)
);


-- ============================================================
-- TABLE 3: iso_weld_records
--
-- One row per weld number found in the PDF weld table.
-- Used by Check B sub-checks (continuity, duplicates, types).
-- Also used for delta comparison between cycles.
--
-- IDF phase will populate the coordinate columns,
-- enabling spatial checks (weld at correct location, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS iso_weld_records (
  id                    SERIAL        PRIMARY KEY,

  -- Link to the cycle this weld record belongs to
  submission_id         INTEGER       NOT NULL
                        REFERENCES iso_pdf_submissions(id) ON DELETE CASCADE,

  -- ── Weld data from PDF ────────────────────────────────────
  weld_no               INTEGER       NOT NULL,

  -- FW = field weld, SW = socket weld.
  -- NULL means the type column was blank in the PDF weld table
  -- (triggers WELD_TYPES_PRESENT check to flag).
  weld_type             VARCHAR(10),

  -- Which sheet of the ISO this weld was found on.
  -- Helps locate the weld when checker investigates a flag.
  sheet_no              INTEGER,

  -- PDF_PARSED at creation. IDF_PARSED when IDF phase updates it.
  source                VARCHAR(20)   NOT NULL DEFAULT 'PDF_PARSED',

  -- ── IDF fields (future phase — all NULL until then) ───────
  -- 3D coordinates from IDF component record.
  -- Units match whatever the IDF uses (typically mm × 100).
  idf_coordinate_e      BIGINT,
  idf_coordinate_n      BIGINT,
  idf_coordinate_el     BIGINT,

  -- For junction welds that connect two ISOs,
  -- the line number of the connecting ISO.
  idf_connected_line    VARCHAR(200),

  -- Weld description from IDF -182 field
  -- e.g. "Shop weld", "Field weld"
  idf_weld_description  TEXT,

  -- Fabricator from IDF -183 field
  -- e.g. "By Pipe Fabricator"
  idf_fabricator        VARCHAR(200),

  -- When IDF data was added to this row
  idf_added_at          TIMESTAMPTZ,

  created_at            TIMESTAMPTZ   DEFAULT NOW(),

  -- One row per weld per cycle.
  -- Same weld_no can exist across different submissions (cycles).
  -- Duplicates within the same cycle are caught by Check B2,
  -- not prevented here, so the parser can record them for reporting.
  -- Note: if a weld appears on two sheets in the same PDF,
  -- the parser inserts both rows (violating this constraint)
  -- and the duplicate is what triggers CHECK B WELD_NO_DUPLICATES.
  -- Therefore this constraint is intentionally on (submission_id, weld_no, sheet_no).
  UNIQUE (submission_id, weld_no, sheet_no)
);


-- ============================================================
-- INDEXES
-- ============================================================

-- iso_pdf_submissions
-- Most common query: find all cycles for a drawing
CREATE INDEX IF NOT EXISTS idx_iso_subs_drawing
  ON iso_pdf_submissions(drawing_id);

-- Find specific cycle for a drawing
CREATE INDEX IF NOT EXISTS idx_iso_subs_rev_cycle
  ON iso_pdf_submissions(drawing_id, rev_no, cycle_no);

-- Background job picks up PENDING submissions to parse
CREATE INDEX IF NOT EXISTS idx_iso_subs_parse_status
  ON iso_pdf_submissions(parse_status);

-- Detect duplicate PDF uploads (same hash = same file)
CREATE INDEX IF NOT EXISTS idx_iso_subs_pdf_hash
  ON iso_pdf_submissions(pdf_hash);

-- IDF watcher matches incoming IDF by generated timestamp + drawing
CREATE INDEX IF NOT EXISTS idx_iso_subs_idf_generated
  ON iso_pdf_submissions(idf_generated_at);

-- Active submissions only — most queries filter is_active=TRUE
CREATE INDEX IF NOT EXISTS idx_iso_subs_active
  ON iso_pdf_submissions(drawing_id, is_active);


-- iso_pre_check_results
-- Load all checks for a submission (main use case)
CREATE INDEX IF NOT EXISTS idx_iso_checks_submission
  ON iso_pre_check_results(submission_id);

-- Check if all non-PASS results have been actioned
-- (used to decide if manual checklist should be unlocked)
CREATE INDEX IF NOT EXISTS idx_iso_checks_actioned
  ON iso_pre_check_results(submission_id, checker_actioned);

-- Filter by result type for reporting
CREATE INDEX IF NOT EXISTS idx_iso_checks_result
  ON iso_pre_check_results(result);


-- iso_weld_records
-- Load all welds for a submission
CREATE INDEX IF NOT EXISTS idx_iso_welds_submission
  ON iso_weld_records(submission_id);

-- Count and sequence checks within a submission
CREATE INDEX IF NOT EXISTS idx_iso_welds_submission_weldno
  ON iso_weld_records(submission_id, weld_no);


-- ============================================================
-- TABLE 4: iso_bom_items
--
-- One row per BOM entry parsed from the IDF file's -20/-21 block.
-- Populated by Check 3 (BOM_DATA_COMPLETE) in isoPreCheckService.js.
-- Routing references ("Design Pipe Assembly") are stored but flagged
-- is_routing_ref=TRUE so procurement comparison skips them.
-- Future use: join on item_code against procurement table to detect
-- material mismatches between ISO and what was actually procured.
-- ============================================================
CREATE TABLE IF NOT EXISTS iso_bom_items (
  id              SERIAL        PRIMARY KEY,
  submission_id   INTEGER       NOT NULL
                  REFERENCES iso_pdf_submissions(id) ON DELETE CASCADE,

  -- Material tag from IDF -20 field (blank when modeller forgot to assign)
  item_code       TEXT          NOT NULL DEFAULT '',

  -- Description from IDF -21 field (blank when blank in S3D model)
  description     TEXT          NOT NULL DEFAULT '',

  -- Derived flags — set at insert time, never updated
  has_tag         BOOLEAN       NOT NULL DEFAULT FALSE,
  has_description BOOLEAN       NOT NULL DEFAULT FALSE,

  -- TRUE when description starts with "Design Pipe" — these are pipe routing
  -- annotations, not physical procurement items
  is_routing_ref  BOOLEAN       NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Load all BOM items for a submission (main use case)
CREATE INDEX IF NOT EXISTS idx_iso_bom_submission
  ON iso_bom_items(submission_id);

-- Procurement comparison: look up by material tag
CREATE INDEX IF NOT EXISTS idx_iso_bom_item_code
  ON iso_bom_items(item_code)
  WHERE item_code != '';


-- ============================================================
-- TABLE 5: iso_pipe_schedule
--
-- Pipe quantity takeoff per submission, populated from IDF data.
-- One row per pipe material (BOM item whose description contains
-- "PIPE") per upload cycle.
--
-- For single-spec lines this is always one row.
-- For reducer lines (multiple pipe sizes on one ISO) there will be
-- multiple rows — one per BOM pipe material.  curv_length_m holds
-- the TOTAL measured line length for all rows because ISOGEN does
-- not write per-segment quantities to the IDF; the split must be
-- done manually if needed.
--
-- inch_meter = pipe_ns_in × curv_length_m  (stored, not computed)
-- Used for isometric takeoff reports, progress billing, and
-- future material-vs-procurement reconciliation.
-- ============================================================
CREATE TABLE IF NOT EXISTS iso_pipe_schedule (
  id              SERIAL        PRIMARY KEY,
  submission_id   INTEGER       NOT NULL
                  REFERENCES iso_pdf_submissions(id) ON DELETE CASCADE,

  -- Pipe material tag from the PDF BOM ITEM CODE column
  -- e.g. PI21977Z00619ZZZZ
  item_code       TEXT          NOT NULL DEFAULT '',

  -- Full description from PDF BOM COMPONENT DESCRIPTION column (multi-line merged)
  -- e.g. "PIPE, B-36.10, ASTM A 106 GR.B, PE, SEAMLESS, 1.0 INCH, XS"
  description     TEXT          NOT NULL DEFAULT '',

  -- PIPE NS (IN) from PDF title block — nominal bore in inches
  -- Same value printed on every sheet; taken from the first sheet
  pipe_ns_in      NUMERIC(6,3),

  -- SUM of CURVILINEAR LENGTH (M) across all sheets
  -- ISOGEN prints the centre-line pipe length for each sheet; total = sum
  curv_length_m   NUMERIC(10,3),

  -- SUM of INCH DIA across all sheets
  -- ISOGEN prints: nominal_size_in × weld_count for each sheet
  inch_dia        NUMERIC(10,4),

  -- SUM of INCH MTR across all sheets
  -- ISOGEN prints: nominal_size_in × pipe_length_m for each sheet
  inch_meter      NUMERIC(12,4),

  -- SUM of pipe QTY (M) from the BOM table across all sheets
  -- The BOM on each sheet lists e.g. "29.5 M"; summing gives total pipe metres
  bom_qty_m       NUMERIC(10,3),

  -- Data source (always 'PDF' for current implementation)
  source          VARCHAR(10)   NOT NULL DEFAULT 'PDF',

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Primary access: all pipe rows for a submission
CREATE INDEX IF NOT EXISTS idx_iso_pipe_schedule_submission
  ON iso_pipe_schedule(submission_id);

-- Rollup by item code across submissions (for procurement totals)
CREATE INDEX IF NOT EXISTS idx_iso_pipe_schedule_item_code
  ON iso_pipe_schedule(item_code)
  WHERE item_code != '';
