-- Repasse do marketplace: valores que o Bling não fornece (campo `taxas` chega
-- zerado em 100% dos pedidos) e que vêm da API do Mercado Livre.
-- Colunas separadas em vez de JSONB porque o objetivo declarado inclui somar
-- esses valores por período depois.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS repasse_valor_bruto       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_tarifa_venda      NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_tarifa_percentual NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS repasse_custo_envio       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_valor_liquido     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_checked_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repasse_final             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS repasse_error             TEXT;

-- Índice da rotação do cron: só pedidos ainda não congelados entram na fila, e
-- a ordenação é por quem está há mais tempo sem checagem (nulos primeiro).
CREATE INDEX IF NOT EXISTS idx_pedidos_repasse_pendente
  ON public.pedidos (repasse_checked_at NULLS FIRST)
  WHERE repasse_final = false;
