-- Habilitar extensão para busca full-text trgm
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================
-- Recriar tabela `produtos` (schema antigo será descartado)
-- =====================================================
-- ATENÇÃO: a tabela antiga não tem dados de produção; será substituída.
-- pedido_itens.produto_id permanece UUID sem FK explícita.
DROP TABLE IF EXISTS public.produtos CASCADE;

CREATE TABLE public.produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bling_connection_id UUID NOT NULL REFERENCES public.bling_connections(id) ON DELETE CASCADE,
  bling_product_id BIGINT NOT NULL,
  bling_parent_id BIGINT,
  sku TEXT NOT NULL,
  gtin TEXT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'simples' CHECK (tipo IN ('simples','pai','filho')),
  bipavel BOOLEAN NOT NULL DEFAULT true,
  ativo BOOLEAN NOT NULL DEFAULT true,
  peso_bruto NUMERIC,
  peso_liquido NUMERIC,
  altura NUMERIC,
  largura NUMERIC,
  profundidade NUMERIC,
  estoque INTEGER,
  imagem_url TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bling_connection_id, bling_product_id)
);

CREATE INDEX idx_produtos_gtin ON public.produtos(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_produtos_sku ON public.produtos(bling_connection_id, sku);
CREATE INDEX idx_produtos_nome_trgm ON public.produtos USING gin (nome gin_trgm_ops);
CREATE INDEX idx_produtos_parent ON public.produtos(bling_parent_id) WHERE bling_parent_id IS NOT NULL;
CREATE INDEX idx_produtos_connection ON public.produtos(bling_connection_id);
CREATE INDEX idx_produtos_ativo ON public.produtos(ativo);
CREATE INDEX idx_produtos_tipo ON public.produtos(tipo);

GRANT SELECT ON public.produtos TO authenticated;
GRANT ALL ON public.produtos TO service_role;

ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Produtos: select autenticado"
  ON public.produtos FOR SELECT TO authenticated USING (true);

-- writes só via service_role (sem policy)

CREATE TRIGGER trg_produtos_updated_at
  BEFORE UPDATE ON public.produtos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================
-- Tabela `sync_jobs`
-- =====================================================
CREATE TABLE public.sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bling_connection_id UUID NOT NULL REFERENCES public.bling_connections(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL DEFAULT 'produtos' CHECK (tipo IN ('produtos')),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','rodando','pausado','concluido','erro')),
  pagina_atual INTEGER NOT NULL DEFAULT 0,
  total_paginas INTEGER,
  total_processados INTEGER NOT NULL DEFAULT 0,
  total_erros INTEGER NOT NULL DEFAULT 0,
  erros JSONB NOT NULL DEFAULT '[]'::jsonb,
  iniciado_por UUID REFERENCES public.profiles(id),
  iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_execucao_em TIMESTAMPTZ,
  finalizado_em TIMESTAMPTZ,
  proxima_execucao_em TIMESTAMPTZ
);

CREATE INDEX idx_sync_jobs_status ON public.sync_jobs(status, proxima_execucao_em)
  WHERE status IN ('pendente','pausado');
CREATE INDEX idx_sync_jobs_connection ON public.sync_jobs(bling_connection_id, iniciado_em DESC);

GRANT SELECT ON public.sync_jobs TO authenticated;
GRANT ALL ON public.sync_jobs TO service_role;

ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SyncJobs: select autenticado"
  ON public.sync_jobs FOR SELECT TO authenticated USING (true);