ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS situacao_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_pedidos_situacao_checked_at
  ON pedidos (situacao_checked_at)
  WHERE situacao_id <> 12;
