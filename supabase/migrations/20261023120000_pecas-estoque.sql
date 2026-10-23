-- Estoque físico de peças automotivas (Rufato) guardadas no galpão — menu "Peças de Carro".
--
-- Cadastro 100% manual pelo colaborador. O sistema só AVISA quando um pedido
-- pendente vende um SKU que tem saldo aqui; não dá baixa sozinho (decisão do
-- Vinicius em 23/10/2026: a quantidade é ajustada à mão quando a peça sai).
--
-- Aplicar via MCP `apply_migration` (nunca `supabase db push` — ver CURRENT-STATE,
-- histórico de migrations dessincronizado).

CREATE TABLE IF NOT EXISTS public.pecas_estoque (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL CHECK (btrim(sku) <> ''),
  -- Chave de comparação com pedido_itens.sku: o SKU digitado à mão pode vir com
  -- espaço ou minúscula, o do Bling não. Comparar sempre por esta coluna.
  sku_normalizado text GENERATED ALWAYS AS (upper(btrim(sku))) STORED,
  nome            text NOT NULL CHECK (btrim(nome) <> ''),
  quantidade      integer NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  localizacao     text,
  created_by      uuid DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pecas_estoque_sku_unico UNIQUE (sku_normalizado)
);

CREATE TRIGGER set_pecas_estoque_updated_at
  BEFORE UPDATE ON public.pecas_estoque
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.pecas_estoque ENABLE ROW LEVEL SECURITY;

-- Qualquer usuário logado (operador ou admin) cadastra e ajusta — mesmo escopo
-- de leitura de pedidos/produtos (single-tenant até a Fase 5).
CREATE POLICY "PecasEstoque: select autenticado"
  ON public.pecas_estoque FOR SELECT TO authenticated USING (true);
CREATE POLICY "PecasEstoque: insert autenticado"
  ON public.pecas_estoque FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "PecasEstoque: update autenticado"
  ON public.pecas_estoque FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "PecasEstoque: delete autenticado"
  ON public.pecas_estoque FOR DELETE TO authenticated USING (true);

REVOKE ALL ON public.pecas_estoque FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pecas_estoque TO authenticated;
GRANT ALL ON public.pecas_estoque TO service_role;

-- Pedidos ainda a expedir que vendem um SKU com saldo no estoque de peças.
-- "A expedir" = mesmo filtro da tela de Expedição (fetchPedidos em
-- src/features/expedicao/ExpedicaoPage.tsx): não impresso, não cancelado (12),
-- não arquivado, ML ainda não despachado/entregue.
-- Alimenta o selo do menu lateral e a lista no topo da tela de peças.
CREATE OR REPLACE FUNCTION public.pedidos_com_peca_em_estoque()
RETURNS TABLE (
  pedido_id         uuid,
  numero            text,
  numero_loja       text,
  marketplace       text,
  data_pedido       timestamptz,
  sku               text,
  descricao         text,
  quantidade_pedido numeric,
  peca_id           uuid,
  peca_nome         text,
  peca_quantidade   integer,
  localizacao       text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT p.id, p.numero, p.numero_loja, p.marketplace, p.data_pedido,
         i.sku, i.descricao, i.quantidade,
         e.id, e.nome, e.quantidade, e.localizacao
  FROM public.pecas_estoque e
  JOIN public.pedido_itens i ON upper(btrim(i.sku)) = e.sku_normalizado
  JOIN public.pedidos p ON p.id = i.pedido_id
  WHERE e.quantidade > 0
    AND p.printed_at IS NULL
    AND p.situacao_id IS DISTINCT FROM 12
    AND p.arquivado = false
    AND (p.ml_shipment_status IS NULL OR p.ml_shipment_status NOT IN ('shipped', 'delivered'))
  ORDER BY p.data_pedido ASC NULLS LAST, p.numero;
$$;

REVOKE ALL ON FUNCTION public.pedidos_com_peca_em_estoque() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedidos_com_peca_em_estoque() TO authenticated, service_role;
