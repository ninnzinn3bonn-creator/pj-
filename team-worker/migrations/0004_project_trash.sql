ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_by TEXT;

CREATE INDEX IF NOT EXISTS projects_active_updated
  ON projects(team_slug, deleted_at, updated_at DESC);
