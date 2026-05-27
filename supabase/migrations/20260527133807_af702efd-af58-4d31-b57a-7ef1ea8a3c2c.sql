ALTER TABLE public.sync_jobs ADD COLUMN IF NOT EXISTS fase text NOT NULL DEFAULT 'listagem';
ALTER TABLE public.sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_fase_check;
ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_fase_check CHECK (fase IN ('listagem', 'detalhes'));
CREATE INDEX IF NOT EXISTS idx_sync_jobs_fase_status ON public.sync_jobs(fase, status);

ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS detail_synced_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_produtos_detail_sync ON public.produtos(bling_connection_id, detail_synced_at NULLS FIRST);