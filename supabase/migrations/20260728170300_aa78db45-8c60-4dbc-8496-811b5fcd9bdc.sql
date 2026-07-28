ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS etiqueta_tipo TEXT DEFAULT 'zpl',
  ADD COLUMN IF NOT EXISTS ml_shipment_status TEXT,
  ADD COLUMN IF NOT EXISTS ml_shipment_substatus TEXT,
  ADD COLUMN IF NOT EXISTS ml_status_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bling_divergente BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arquivado BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arquivado_motivo TEXT,
  ADD COLUMN IF NOT EXISTS arquivado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nf_situacao SMALLINT,
  ADD COLUMN IF NOT EXISTS nf_situacao_motivo TEXT,
  ADD COLUMN IF NOT EXISTS nf_situacao_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS situacao_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pedidos_bling_divergente ON public.pedidos (bling_divergente) WHERE bling_divergente = true;
CREATE INDEX IF NOT EXISTS idx_pedidos_ml_status_checked_at ON public.pedidos (ml_status_checked_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS pedidos_arquivado_idx ON public.pedidos (arquivado) WHERE arquivado = false;
CREATE INDEX IF NOT EXISTS idx_pedidos_nf_situacao_checked_at ON public.pedidos (nf_situacao_checked_at ASC NULLS FIRST) WHERE printed_at IS NULL AND bling_nota_fiscal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_situacao_checked_at ON public.pedidos (situacao_checked_at) WHERE situacao_id <> 12;

CREATE TABLE IF NOT EXISTS public.produtos_sync_runs (
  id uuid primary key default gen_random_uuid(),
  bling_connection_id uuid references public.bling_connections(id),
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  total_recebidos integer not null default 0,
  total_upserted integer not null default 0,
  total_erros integer not null default 0,
  origem text not null default 'pc-local',
  detalhes jsonb
);

GRANT SELECT ON public.produtos_sync_runs TO authenticated;
GRANT ALL ON public.produtos_sync_runs TO service_role;
ALTER TABLE public.produtos_sync_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'produtos_sync_runs'
      AND policyname = 'SyncRuns: select autenticado'
  ) THEN
    CREATE POLICY "SyncRuns: select autenticado" ON public.produtos_sync_runs
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;