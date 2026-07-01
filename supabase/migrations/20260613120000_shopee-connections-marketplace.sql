CREATE TABLE IF NOT EXISTS public.shopee_connections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                   BIGINT UNIQUE NOT NULL,
  shop_name                 TEXT,
  partner_id                BIGINT NOT NULL,
  access_token              TEXT,
  refresh_token             TEXT,
  access_token_expires_at   TIMESTAMPTZ,
  refresh_token_expires_at  TIMESTAMPTZ,
  is_sandbox                BOOLEAN DEFAULT true,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.shopee_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow all"
  ON public.shopee_connections FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT ON public.shopee_connections TO authenticated;
GRANT ALL    ON public.shopee_connections TO service_role;

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS marketplace TEXT DEFAULT 'mercadolivre',
  ADD COLUMN IF NOT EXISTS marketplace_order_id TEXT;
