CREATE TABLE IF NOT EXISTS team_viewer_tokens (
  team_slug TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  rotated_at TEXT,
  rotated_by TEXT,
  last_used_at TEXT,
  FOREIGN KEY (team_slug) REFERENCES teams(team_slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS team_viewer_tokens_hash
  ON team_viewer_tokens(token_hash);
