-- =====================================================
-- Fase 3.3: Recria pedidos e pedido_itens com schema Bling
-- O schema original (fase 1) usava empresa_id e não tem dados.
-- DROP CASCADE seguro — confirmado COUNT=0 antes desta migration.
-- =====================================================

DROP TABLE IF EXISTS public.pedido_itens CASCADE;
DROP TABLE IF EXISTS public.pedidos CASCADE;

-- =====================================================
-- Tabela pedidos
-- =====================================================
CREATE TABLE public.pedidos (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  bling_connection_id      UUID         NOT NULL REFERENCES public.bling_connections(id) ON DELETE CASCADE,
  bling_pedido_id          BIGINT       NOT NULL,
  numero                   TEXT         NOT NULL,
  numero_loja              TEXT,                         -- campo numeroLoja do Bling (id no marketplace)
  situacao_id              INT,                          -- id da situação no Bling
  situacao_valor           INT,                          -- valor numérico: 9=Atendido, 12=Cancelado, etc.
  data_pedido              TIMESTAMPTZ,
  total                    NUMERIC(12,2),
  -- cliente: guarda o objeto `contato` da Bling API v3.
  -- Termo de domínio (cliente) difere do nome no payload da API (contato).
  cliente                  JSONB,
  bling_nota_fiscal_id     BIGINT,
  bling_nota_fiscal_numero TEXT,
  raw_json                 JSONB        NOT NULL,        -- payload completo do GET — audit trail
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_pedidos_connection_bling UNIQUE (bling_connection_id, bling_pedido_id)
);

CREATE INDEX idx_pedidos_bling_id       ON public.pedidos(bling_pedido_id);
CREATE INDEX idx_pedidos_situacao_valor ON public.pedidos(situacao_valor);
CREATE INDEX idx_pedidos_connection     ON public.pedidos(bling_connection_id);
CREATE INDEX idx_pedidos_data_pedido    ON public.pedidos(data_pedido DESC NULLS LAST);

GRANT SELECT ON public.pedidos TO authenticated;
GRANT ALL    ON public.pedidos TO service_role;

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;

-- SELECT: todos os autenticados leem.
-- TODO: escopo por empresa quando houver multi-tenant real — a conexão Bling pertence
-- ao admin, mas operadores precisam ver pedidos para bipar/expedir. Deixar USING (true)
-- até o modelo de permissão de operadores estar definido.
CREATE POLICY "Pedidos: select autenticado"
  ON public.pedidos FOR SELECT TO authenticated USING (true);

-- INSERT / UPDATE / DELETE: apenas service_role (webhook usa service key; UI não escreve).

CREATE TRIGGER trg_pedidos_updated_at
  BEFORE UPDATE ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================
-- Tabela pedido_itens
-- =====================================================
CREATE TABLE public.pedido_itens (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id          UUID          NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id         UUID          REFERENCES public.produtos(id) ON DELETE SET NULL,  -- match opcional por SKU/EAN
  bling_item_id      BIGINT,
  sku                TEXT,
  ean                TEXT,
  descricao          TEXT          NOT NULL,  -- denormalizado: sobrevive ao delete do produto
  quantidade         NUMERIC(10,3) NOT NULL,
  valor_unitario     NUMERIC(12,2),
  deposito_id        BIGINT,
  deposito_descricao TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_pedido_itens_pedido_id ON public.pedido_itens(pedido_id);
CREATE INDEX idx_pedido_itens_ean       ON public.pedido_itens(ean) WHERE ean IS NOT NULL;

GRANT SELECT ON public.pedido_itens TO authenticated;
GRANT ALL    ON public.pedido_itens TO service_role;

ALTER TABLE public.pedido_itens ENABLE ROW LEVEL SECURITY;

-- SELECT: todos os autenticados (mesmo TODO de scoping que pedidos).
CREATE POLICY "PedidoItens: select autenticado"
  ON public.pedido_itens FOR SELECT TO authenticated USING (true);

-- INSERT / UPDATE / DELETE: apenas service_role.
