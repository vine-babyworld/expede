-- Rastreamento da situação da NF no Bling (situação != "id existe" — Bling
-- cria o registro da NF mesmo quando ela nunca chega a ser autorizada pela
-- SEFAZ, ex: NCM faltante nos itens). Sem isso o EXPEDE não distinguia "NF
-- criada mas com erro" de "NF autorizada" — pedidos nessa situação eram
-- bipáveis e podiam ser marcados como impressos com DANFE inválida.
--
-- Códigos de situação (Bling API v3, GET /nfe/{id}):
-- 1 Pendente | 2 Cancelada | 3 Aguardando recibo | 4 Rejeitada | 5 Autorizada
-- 6 Emitida DANFE | 7 Registrada | 8 Aguardando protocolo | 9 Denegada
-- 10 Consulta situação | 11 Bloqueada
-- Autorizada para efeito de bipagem = 5 ou 6.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS nf_situacao SMALLINT,
  ADD COLUMN IF NOT EXISTS nf_situacao_motivo TEXT,
  ADD COLUMN IF NOT EXISTS nf_situacao_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pedidos_nf_situacao_checked_at
  ON public.pedidos (nf_situacao_checked_at ASC NULLS FIRST)
  WHERE printed_at IS NULL AND bling_nota_fiscal_id IS NOT NULL;
