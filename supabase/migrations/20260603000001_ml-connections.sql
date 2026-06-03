CREATE TABLE IF NOT EXISTS ml_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ml_user_id BIGINT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE ml_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read ml_connections"
  ON ml_connections FOR SELECT TO authenticated USING (true);

GRANT SELECT ON ml_connections TO authenticated;
GRANT ALL ON ml_connections TO service_role;
