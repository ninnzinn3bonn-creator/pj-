CREATE TABLE IF NOT EXISTS connection_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_slug TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  last_used_at TEXT,
  UNIQUE(team_slug, email),
  FOREIGN KEY (team_slug) REFERENCES teams(team_slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS connection_tokens_member
  ON connection_tokens(team_slug, email);
