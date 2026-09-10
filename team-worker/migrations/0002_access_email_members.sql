CREATE TABLE IF NOT EXISTS access_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_slug TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_slug, email),
  FOREIGN KEY (team_slug) REFERENCES teams(team_slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_access_members_team_active
  ON access_members(team_slug, active, email);
