-- Momento em que o EXPEDE viu o Mercado Livre liberar a etiqueta de um envio que
-- estava em buffering (substatus "buffered" — "Para entregar na coleta do dia X").
--
-- Gravado pelo cronMLStatus na transição buffered → outro substatus. A Expedição
-- usa o dia (Brasília) desta coluna como data de referência do despacho, para o
-- pedido não aparecer como "Atrasado" no dia em que a etiqueta acabou de sair —
-- o Bling manda dataPrevista "0000-00-00" para boa parte desses pedidos.
--
-- Coluna aditiva e nula: o código antigo não a lê. Aplicar via MCP
-- `apply_migration` (nunca `supabase db push` — ver CURRENT-STATE).

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS ml_etiqueta_liberada_em timestamptz;
