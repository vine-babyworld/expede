-- Corrige race condition: bling-pedidos.ts (webhook) e pedidos.functions.ts (reconciliação)
-- usavam delete+insert não-atômico pra sincronizar pedido_itens. Entregas duplicadas do
-- webhook do Bling para o mesmo pedido (comum: "situação alterada" + "NF emitida" próximos)
-- podiam fazer o DELETE de uma chamada apagar o item que a outra acabara de inserir, sem
-- reinserção (falha silenciosa — só logada no console). Achado real em produção: pedidos
-- #8349, #8430, #8441 com item presente no raw_json do Bling mas 0 linhas em pedido_itens.
--
-- Chave (pedido_id, sku) — não (pedido_id, bling_item_id) — porque itens de kit explodidos
-- em componentes individuais compartilham o bling_item_id do item-pai do kit; sku é o que já
-- era usado no código pra distinguir componentes. Confirmado sem duplicatas existentes antes
-- de aplicar.
alter table public.pedido_itens
  add constraint pedido_itens_pedido_sku_key unique (pedido_id, sku);
