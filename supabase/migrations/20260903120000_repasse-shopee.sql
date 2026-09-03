-- Fase 2 do repasse: Shopee. A quebra de tarifas vai em JSONB porque ninguém
-- soma linha de quebra entre pedidos; os agregados continuam em colunas
-- próprias (é neles que um relatório mensal vai somar).
-- `order_ams_commission_fee` só aparece em 5 de 42 pedidos: colunas fixas por
-- tipo de taxa fariam cada taxa nova da Shopee virar migration.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS repasse_linhas            JSONB,
  ADD COLUMN IF NOT EXISTS repasse_liquido_informado NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS repasse_divergencia       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS shopee_order_status       TEXT;

COMMENT ON COLUMN public.pedidos.repasse_liquido_informado IS
  'Líquido informado pelo marketplace (escrow_amount na Shopee). NULL no ML, que não tem equivalente.';
COMMENT ON COLUMN public.pedidos.repasse_divergencia IS
  '(bruto - tarifa - envio) - liquido_informado. Diferente de zero indica linha de taxa não somada.';
COMMENT ON COLUMN public.pedidos.shopee_order_status IS
  'order_status da Shopee. COMPLETED é o ponto de congelamento do repasse (escrow liberado).';

-- Índice da rotação do cron da Shopee, espelhando idx_pedidos_repasse_pendente
-- da fase 1 mas escopado ao marketplace, para os dois crons não competirem
-- pelo mesmo plano de consulta.
CREATE INDEX IF NOT EXISTS idx_pedidos_repasse_shopee_pendente
  ON public.pedidos (repasse_checked_at NULLS FIRST)
  WHERE repasse_final = false AND marketplace = 'shopee';
