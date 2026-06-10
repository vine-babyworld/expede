ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_printed_at ON public.pedidos (printed_at DESC NULLS LAST);