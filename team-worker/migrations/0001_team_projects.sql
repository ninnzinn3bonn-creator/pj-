PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  team_slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_slug TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_slug, github_user_id),
  FOREIGN KEY (team_slug) REFERENCES teams(team_slug) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS team_members_login
  ON team_members(team_slug, github_login COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS projects (
  team_slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK (json_valid(document)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  shared_at TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (team_slug, project_id),
  FOREIGN KEY (team_slug) REFERENCES teams(team_slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS projects_updated
  ON projects(team_slug, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_architectures (
  team_slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK (json_valid(document)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (team_slug, project_id),
  FOREIGN KEY (team_slug, project_id) REFERENCES projects(team_slug, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  progress_before INTEGER NOT NULL,
  progress_after INTEGER NOT NULL,
  status_before TEXT NOT NULL,
  status_after TEXT NOT NULL,
  FOREIGN KEY (team_slug, project_id) REFERENCES projects(team_slug, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_history_lookup
  ON project_history(team_slug, project_id, id DESC);
