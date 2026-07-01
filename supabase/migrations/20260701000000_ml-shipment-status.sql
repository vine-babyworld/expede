-- Adiciona colunas para rastreamento do status de envio no Mercado Livre.
-- Permite detectar quando o ML já indica despacho mas o Bling ainda não baixou situação.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS ml_shipment_status     TEXT,
  ADD COLUMN IF NOT EXISTS ml_shipment_substatus  TEXT,
  ADD COLUMN IF NOT EXISTS ml_status_checked_at   TIMESTAMPTZ,
  -- true quando ML indica despachado/entregue mas situacao_id Bling ainda não é 9 ou 15
  ADD COLUMN IF NOT EXISTS bling_divergente        BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pedidos_bling_divergente
  ON public.pedidos (bling_divergente)
  WHERE bling_divergente = true;

CREATE INDEX IF NOT EXISTS idx_pedidos_ml_status_checked_at
  ON public.pedidos (ml_status_checked_at DESC NULLS LAST);
