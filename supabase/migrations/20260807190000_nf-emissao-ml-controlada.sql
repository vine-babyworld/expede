-- Controlador de emissão de NF para pedidos Mercado Livre.
-- O controlador nasce DESARMADO. Só habilitar nf_emissao_ml_ativa depois de
-- desligar a geração automática de NF no Bling.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS nf_emissao_modo TEXT,
  ADD COLUMN IF NOT EXISTS nf_emissao_status TEXT,
  ADD COLUMN IF NOT EXISTS nf_emissao_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nf_emissao_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nf_emissao_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nf_emissao_error TEXT;

ALTER TABLE public.pedidos
  DROP CONSTRAINT IF EXISTS pedidos_nf_emissao_modo_check,
  ADD CONSTRAINT pedidos_nf_emissao_modo_check
    CHECK (nf_emissao_modo IS NULL OR nf_emissao_modo IN ('automatic', 'manual')),
  DROP CONSTRAINT IF EXISTS pedidos_nf_emissao_status_check,
  ADD CONSTRAINT pedidos_nf_emissao_status_check
    CHECK (
      nf_emissao_status IS NULL OR nf_emissao_status IN (
        'pending', 'processing', 'created', 'sent', 'retry', 'blocked', 'manual'
      )
    );

CREATE INDEX IF NOT EXISTS idx_pedidos_nf_emissao_fila
  ON public.pedidos (nf_emissao_last_attempt_at ASC NULLS FIRST, data_pedido ASC)
  WHERE marketplace = 'mercadolivre'
    AND nf_emissao_modo = 'automatic'
    AND nf_emissao_status IN ('pending', 'processing', 'created', 'retry');

CREATE TABLE IF NOT EXISTS public.app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_config (key, value)
VALUES ('nf_emissao_ml_ativa', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN public.pedidos.nf_emissao_modo IS
  'Política do EXPEDE: automatic para ML normal, manual para ML Flex.';
COMMENT ON COLUMN public.pedidos.nf_emissao_status IS
  'Estado do controlador de emissão; distinto da situação fiscal retornada pelo Bling/SEFAZ.';
COMMENT ON TABLE public.app_config IS
  'Configuração operacional server-side. Sem policies: acesso somente por service role.';
