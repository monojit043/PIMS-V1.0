-- ============================================================
-- PIMS PostgreSQL Schema
-- Replaces: login.json, drawings.json, stress.json
-- ============================================================

-- Users (from login.json → users[])
CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(20)  PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  password    VARCHAR(200) NOT NULL,
  is_hod      BOOLEAN      DEFAULT FALSE,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Projects (from login.json → projects[])
CREATE TABLE IF NOT EXISTS projects (
  id          VARCHAR(50)  PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  created_by  VARCHAR(20)  REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- SGLs assigned to a project (project.sgls array)
CREATE TABLE IF NOT EXISTS project_sgls (
  project_id  VARCHAR(50) REFERENCES projects(id) ON DELETE CASCADE,
  user_id     VARCHAR(20) REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

-- Units that belong to a project (project.units.units array)
CREATE TABLE IF NOT EXISTS project_units (
  id          SERIAL      PRIMARY KEY,
  project_id  VARCHAR(50) REFERENCES projects(id) ON DELETE CASCADE,
  unit_no     VARCHAR(50) NOT NULL,
  UNIQUE (project_id, unit_no)
);

-- Role assignments: user ↔ project ↔ unit ↔ role
-- (from user.projectAssignments[projectId].units[unitNo] = [roles])
CREATE TABLE IF NOT EXISTS user_role_assignments (
  id          SERIAL      PRIMARY KEY,
  user_id     VARCHAR(20) REFERENCES users(id)    ON DELETE CASCADE,
  project_id  VARCHAR(50) REFERENCES projects(id) ON DELETE CASCADE,
  unit_no     VARCHAR(50) NOT NULL,
  role        VARCHAR(50) NOT NULL,
  UNIQUE (user_id, project_id, unit_no, role)
);

-- Drawings (from drawings.json → drawings[])
CREATE TABLE IF NOT EXISTS drawings (
  id                  SERIAL        PRIMARY KEY,
  job_no              VARCHAR(50)   NOT NULL,
  unit_no             VARCHAR(50)   NOT NULL,
  zone                VARCHAR(20)   NOT NULL,
  line_no             VARCHAR(200)  NOT NULL,
  file_name           VARCHAR(500),
  file_path           VARCHAR(1000),
  stored_file         VARCHAR(500),
  uploaded_by         VARCHAR(20),
  uploaded_on         TIMESTAMPTZ   DEFAULT NOW(),
  rev_no              INTEGER       DEFAULT 0,
  status              VARCHAR(100)  DEFAULT 'Uploaded',
  upload_type         VARCHAR(50),
  stress_critical     CHAR(1)       DEFAULT 'N',
  notify_modeller     BOOLEAN       DEFAULT FALSE,
  notify_gl           BOOLEAN       DEFAULT FALSE,
  all_roles_claimed   BOOLEAN       DEFAULT FALSE,
  delegated_by_user   VARCHAR(20),
  delegated_by_role   VARCHAR(50),
  delegated_at        TIMESTAMPTZ,
  UNIQUE (job_no, unit_no, zone, line_no)
);

-- Drawing version history (drawing.history array of filenames)
CREATE TABLE IF NOT EXISTS drawing_history (
  id          SERIAL       PRIMARY KEY,
  drawing_id  INTEGER      REFERENCES drawings(id) ON DELETE CASCADE,
  file_name   VARCHAR(500) NOT NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Who has claimed a drawing for which roles (drawing.claimedBy object)
CREATE TABLE IF NOT EXISTS drawing_claims (
  id          SERIAL      PRIMARY KEY,
  drawing_id  INTEGER     REFERENCES drawings(id) ON DELETE CASCADE,
  user_id     VARCHAR(20) REFERENCES users(id),
  roles       TEXT[]      NOT NULL,
  claimed_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (drawing_id, user_id)
);

-- Workflow comments on drawings (drawing.comments array)
CREATE TABLE IF NOT EXISTS drawing_comments (
  id          SERIAL        PRIMARY KEY,
  drawing_id  INTEGER       REFERENCES drawings(id) ON DELETE CASCADE,
  user_id     VARCHAR(20),
  roles       TEXT[],
  type        VARCHAR(50),
  body        TEXT,
  file_name   VARCHAR(500),
  file_path   VARCHAR(1000),
  delegated_to TEXT[],
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

-- Comment/annotation PDF files attached to a drawing (drawing.commentFiles array)
CREATE TABLE IF NOT EXISTS drawing_comment_files (
  id          SERIAL        PRIMARY KEY,
  drawing_id  INTEGER       REFERENCES drawings(id) ON DELETE CASCADE,
  file_name   VARCHAR(500)  NOT NULL,
  file_path   VARCHAR(1000),
  roles       TEXT[],
  uploaded_by TEXT[],
  type        VARCHAR(50),
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

-- Stress-critical piping lines (from stress.json → stressLines[])
CREATE TABLE IF NOT EXISTS stress_lines (
  line_id       VARCHAR(200) PRIMARY KEY,
  stress_system VARCHAR(200),
  dept          VARCHAR(200),
  uploaded_on   TIMESTAMPTZ  DEFAULT NOW(),
  uploaded_by   VARCHAR(20),
  source_file   VARCHAR(500)
);

-- ---- Column additions (safe to re-run) ----
ALTER TABLE drawing_claims ADD COLUMN IF NOT EXISTS comment_type  VARCHAR(50);
ALTER TABLE drawing_claims ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;

-- ── Line List Normalizer ──────────────────────────────────────
-- One record per upload event (job + revision)
CREATE TABLE IF NOT EXISTS linelist_uploads (
  id           SERIAL        PRIMARY KEY,
  job_no       VARCHAR(50)   NOT NULL,
  source_files TEXT          DEFAULT '[]',
  rev_no       INTEGER       DEFAULT 0,
  uploaded_by  VARCHAR(20)   REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ   DEFAULT NOW(),
  row_count    INTEGER       DEFAULT 0,
  is_latest    BOOLEAN       DEFAULT TRUE
);

-- Individual normalized line rows
CREATE TABLE IF NOT EXISTS linelist_lines (
  id                       SERIAL       PRIMARY KEY,
  upload_id                INTEGER      REFERENCES linelist_uploads(id) ON DELETE CASCADE,
  pid_no                   VARCHAR(200) DEFAULT '',
  service                  VARCHAR(500) DEFAULT '',
  unit_no                  VARCHAR(50)  DEFAULT '',
  line_no                  VARCHAR(500) DEFAULT '',
  line_size                VARCHAR(100) DEFAULT '',
  line_size_unit           VARCHAR(50)  DEFAULT '',
  line_class               VARCHAR(200) DEFAULT '',
  line_from                VARCHAR(500) DEFAULT '',
  line_to                  VARCHAR(500) DEFAULT '',
  min_design_press         VARCHAR(100) DEFAULT '',
  min_design_press_unit    VARCHAR(100) DEFAULT '',
  min_design_temp          VARCHAR(100) DEFAULT '',
  min_design_temp_unit     VARCHAR(100) DEFAULT '',
  min_operating_press      VARCHAR(100) DEFAULT '',
  min_operating_press_unit VARCHAR(100) DEFAULT '',
  min_operating_temp       VARCHAR(100) DEFAULT '',
  min_operating_temp_unit  VARCHAR(100) DEFAULT '',
  operating_temp           VARCHAR(100) DEFAULT '',
  operating_temp_unit      VARCHAR(100) DEFAULT '',
  operating_press          VARCHAR(100) DEFAULT '',
  operating_press_unit     VARCHAR(100) DEFAULT '',
  design_temp              VARCHAR(100) DEFAULT '',
  design_temp_unit         VARCHAR(100) DEFAULT '',
  design_press             VARCHAR(100) DEFAULT '',
  design_press_unit        VARCHAR(100) DEFAULT '',
  insulation               VARCHAR(200) DEFAULT '',
  full_vaccum              VARCHAR(20)  DEFAULT '',
  fluid_state              VARCHAR(200) DEFAULT '',
  multi_phase              VARCHAR(200) DEFAULT '',
  insulation_thickness     VARCHAR(100) DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ll_uploads_job    ON linelist_uploads(job_no);
CREATE INDEX IF NOT EXISTS idx_ll_uploads_latest ON linelist_uploads(job_no, is_latest);
CREATE INDEX IF NOT EXISTS idx_ll_lines_upload   ON linelist_lines(upload_id);
CREATE INDEX IF NOT EXISTS idx_ll_lines_unit     ON linelist_lines(unit_no);
CREATE INDEX IF NOT EXISTS idx_ll_lines_line_no  ON linelist_lines(line_no);

-- ── S3D lock-feed export state ──────────────────────────────────
-- One row per line (job_no, unit_no, zone, line_no), upserted in place as the
-- line's state changes. Drives the daily Excel export to S3D's evening lock
-- batch. lock_status is internal ('WORKING' | 'PENDING_LOCK') and is only
-- translated to S3D's own vocabulary ('WORKING' | 'APPROVED') at export time,
-- so it never collides with drawings.status or with GL's own "approve" action
-- (GL approving a line to Final is a separate, unrelated concept).
CREATE TABLE IF NOT EXISTS s3d_export_log (
  id                         SERIAL        PRIMARY KEY,
  job_no                     VARCHAR(50)   NOT NULL,
  unit_no                    VARCHAR(50)   NOT NULL,
  zone                       VARCHAR(20)   NOT NULL,
  line_no                    VARCHAR(200)  NOT NULL,
  lock_status                VARCHAR(20)   NOT NULL DEFAULT 'WORKING',
  lot_no                     INTEGER,
  updated_at                 TIMESTAMPTZ   DEFAULT NOW(),
  last_exported_lock_status  VARCHAR(20),
  last_exported_lot_no       INTEGER,
  UNIQUE (job_no, unit_no, zone, line_no)
);

CREATE INDEX IF NOT EXISTS idx_s3d_export_log_pending
  ON s3d_export_log(job_no, unit_no)
  WHERE lock_status IS DISTINCT FROM last_exported_lock_status
     OR lot_no       IS DISTINCT FROM last_exported_lot_no;

-- ── Master Unit groupings ─────────────────────────────────────────────────
-- SGL defines which child units share a lot-number sequence under a master
-- unit. One row per child unit; each child can belong to at most one group.
-- Lots are stored with unit_no = master_unit so the sequence and folder key
-- are consistent across the whole group. Standalone units have no row here.
CREATE TABLE IF NOT EXISTS master_units (
  id           SERIAL       PRIMARY KEY,
  project_id   VARCHAR(50)  REFERENCES projects(id) ON DELETE CASCADE,
  master_unit  VARCHAR(50)  NOT NULL,
  child_unit   VARCHAR(50)  NOT NULL,
  created_by   VARCHAR(20),
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (project_id, child_unit)
);

CREATE INDEX IF NOT EXISTS idx_master_units_project  ON master_units(project_id);
CREATE INDEX IF NOT EXISTS idx_master_units_master   ON master_units(project_id, master_unit);

-- ---- Indexes for common lookups ----
CREATE INDEX IF NOT EXISTS idx_drawings_job_unit      ON drawings(job_no, unit_no);
CREATE INDEX IF NOT EXISTS idx_drawings_line_no       ON drawings(line_no);
CREATE INDEX IF NOT EXISTS idx_drawings_status        ON drawings(status);
CREATE INDEX IF NOT EXISTS idx_user_role_user         ON user_role_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_role_project      ON user_role_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_drawing_claims_drawing ON drawing_claims(drawing_id);
CREATE INDEX IF NOT EXISTS idx_drawing_comments_dwg   ON drawing_comments(drawing_id);
