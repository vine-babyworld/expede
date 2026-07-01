-- Adiciona suporte a arquivamento de pedidos órfãos (ex: entregues pelo ML sem bipagem no EXPEDE)
-- Pedidos arquivados saem das filas de expedição, cron-ml-status e contadores do dashboard,
-- mas são preservados para histórico e rastreabilidade fiscal.

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS arquivado BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arquivado_motivo TEXT,
  ADD COLUMN IF NOT EXISTS arquivado_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS pedidos_arquivado_idx ON pedidos (arquivado) WHERE arquivado = false;
