-- =====================================================
-- Fase 4: adiciona quantidade_bipada a pedido_itens
-- A tabela foi recriada na Fase 3.3 sem este campo.
-- =====================================================

ALTER TABLE public.pedido_itens
  ADD COLUMN quantidade_bipada NUMERIC(10,3) NOT NULL DEFAULT 0;

-- Limpeza de bipagens órfãs (pedido_itens foi DROP CASCADE'd na Fase 3.3)
DELETE FROM public.bipagens
  WHERE pedido_item_id NOT IN (SELECT id FROM public.pedido_itens);

-- Restaura FK bipagens → pedido_itens (foi dropada pelo CASCADE na Fase 3.3)
ALTER TABLE public.bipagens
  ADD CONSTRAINT fk_bipagens_pedido_item
  FOREIGN KEY (pedido_item_id) REFERENCES public.pedido_itens(id) ON DELETE CASCADE;
