
-- Empresas
CREATE TABLE public.empresas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  cnpj text,
  bling_token text,
  ativa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Canais
CREATE TABLE public.canais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  slug text NOT NULL UNIQUE,
  cor text,
  icone text
);

-- Produtos
CREATE TABLE public.produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  sku text NOT NULL,
  ean_principal text,
  eans_alternativos text[] NOT NULL DEFAULT array[]::text[],
  nome text NOT NULL,
  foto_url text,
  localizacao text,
  bling_product_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id, sku)
);

-- Pedidos
CREATE TABLE public.pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  numero_pedido text NOT NULL,
  canal_id uuid REFERENCES public.canais(id),
  nome_cliente text,
  cidade_cliente text,
  estado_cliente text,
  metodo_envio text,
  bloco_separacao text,
  data_pedido timestamptz,
  data_max_postagem timestamptz,
  status text NOT NULL DEFAULT 'pendente',
  anotacoes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Itens
CREATE TABLE public.pedido_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id uuid REFERENCES public.produtos(id),
  quantidade integer NOT NULL DEFAULT 1,
  quantidade_bipada integer NOT NULL DEFAULT 0,
  valor_unitario numeric(10,2)
);

-- Bipagens
CREATE TABLE public.bipagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_item_id uuid REFERENCES public.pedido_itens(id) ON DELETE CASCADE,
  codigo_bipado text NOT NULL,
  resultado text NOT NULL,
  usuario text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- GRANTS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.empresas TO anon, authenticated;
GRANT ALL ON public.empresas TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canais TO anon, authenticated;
GRANT ALL ON public.canais TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.produtos TO anon, authenticated;
GRANT ALL ON public.produtos TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pedidos TO anon, authenticated;
GRANT ALL ON public.pedidos TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pedido_itens TO anon, authenticated;
GRANT ALL ON public.pedido_itens TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bipagens TO anon, authenticated;
GRANT ALL ON public.bipagens TO service_role;

-- RLS
ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bipagens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow all" ON public.empresas FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON public.canais FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON public.produtos FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON public.pedidos FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON public.pedido_itens FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON public.bipagens FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
