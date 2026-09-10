ALTER TABLE teams ADD COLUMN owner_email TEXT;
ALTER TABLE teams ADD COLUMN updated_at TEXT;

UPDATE teams
SET owner_email = 'ninnzinn.3bonn@gmail.com', updated_at = created_at
WHERE team_slug = 'my-team' AND owner_email IS NULL;

CREATE INDEX IF NOT EXISTS idx_access_members_email_active
  ON access_members(email, active, team_slug);
