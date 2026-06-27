-- Add fixed multi-repository automation targets and grouped run tracking.

CREATE TABLE IF NOT EXISTS automation_targets (
  automation_id TEXT    NOT NULL,
  repo_owner    TEXT    NOT NULL,
  repo_name     TEXT    NOT NULL,
  repo_id       INTEGER,
  base_branch   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, repo_owner, repo_name),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

INSERT OR IGNORE INTO automation_targets (
  automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at
)
SELECT
  id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at
FROM automations
WHERE deleted_at IS NULL
  AND COALESCE(target_mode, 'fixed_single_repo') = 'fixed_single_repo'
  AND repo_owner IS NOT NULL
  AND repo_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_targets_repo
  ON automation_targets (repo_owner, repo_name);

CREATE TABLE IF NOT EXISTS automation_run_groups (
  id                 TEXT    PRIMARY KEY,
  automation_id      TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'starting',
  skip_reason        TEXT,
  failure_reason     TEXT,
  scheduled_at       INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  failure_counted_at INTEGER,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE INDEX IF NOT EXISTS idx_run_groups_automation_created
  ON automation_run_groups (automation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_groups_active_lookup
  ON automation_run_groups (automation_id, created_at DESC)
  WHERE status IN ('starting', 'running')
     OR (status = 'partial_failed' AND completed_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_groups_idempotency
  ON automation_run_groups (automation_id, scheduled_at);

ALTER TABLE automation_runs ADD COLUMN group_id TEXT;
ALTER TABLE automation_runs ADD COLUMN target_repo_owner TEXT;
ALTER TABLE automation_runs ADD COLUMN target_repo_name TEXT;
ALTER TABLE automation_runs ADD COLUMN target_repo_id INTEGER;
ALTER TABLE automation_runs ADD COLUMN target_base_branch TEXT;

DROP INDEX IF EXISTS idx_runs_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
  ON automation_runs (automation_id, scheduled_at)
  WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_runs_group
  ON automation_runs (group_id, created_at DESC)
  WHERE group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_group_target
  ON automation_runs (group_id, target_repo_owner, target_repo_name)
  WHERE group_id IS NOT NULL
    AND target_repo_owner IS NOT NULL
    AND target_repo_name IS NOT NULL;
