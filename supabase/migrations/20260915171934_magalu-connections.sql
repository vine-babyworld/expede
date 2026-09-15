-- Conexão OAuth do Magalu (IDMagalu).
--
-- Aplicada em 15/09/2026 via MCP `apply_migration` (nunca `supabase db push`).
-- Este arquivo é o espelho no repositório do que já está no banco.
--
-- Duas diferenças deliberadas em relação a shopee_connections/ml_connections:
--
-- 1. Tokens em BYTEA cifrado (AES-256-GCM, src/lib/token-crypto.ts), como
--    bling_connections — e não em TEXT puro como os outros dois marketplaces.
-- 2. RLS restritiva: a tabela base não recebe GRANT nenhum para `authenticated`.
--    Só service_role escreve e lê. A UI usa a view magalu_connections_status,
--    que não expõe token. Nada de `USING (true)` como a Shopee.

CREATE TABLE IF NOT EXISTS public.magalu_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant do consentimento. Tem de ser o `organization` (Baby Magia LTDA,
  -- 94725b94-9532-4475-8c3a-299b0e685dde); com o `person` tudo autentica e a
  -- etiqueta estoura 403 depois. Nullable porque ainda não se sabe se a
  -- resposta de token traz esse id — a descoberta fica em token_meta.
  tenant_id             text,
  access_token          bytea NOT NULL,
  refresh_token         bytea NOT NULL,
  access_expires_at     timestamptz NOT NULL,
  -- Validade do token conforme o próprio IDMagalu (`expires_in`). Guardada
  -- porque a margem de renovação é calculada a partir dela: o client saiu do
  -- IDM CLI com 20s em vez dos 7200s da doc, e margem fixa faria toda chamada
  -- renovar — caminho direto para o 429 da Lição #41.
  access_ttl_seconds    integer,
  scope                 text,
  status                text NOT NULL DEFAULT 'connected',
  -- Qual Content-Type o /oauth/token aceitou de fato. A doc descreve JSON na
  -- troca do code e form-urlencoded no refresh; nunca foi testado.
  token_endpoint_format text,
  -- Resposta de token sem os segredos — é onde aparece qualquer campo de
  -- tenant/conta que a doc não descreve.
  token_meta            jsonb,
  last_refresh_at       timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_magalu_connections_updated_at
  BEFORE UPDATE ON public.magalu_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.magalu_connections ENABLE ROW LEVEL SECURITY;

-- Sem policy para `authenticated`: com RLS ligada e nenhuma policy aplicável,
-- todo acesso via chave anon/authenticated é negado. service_role ignora RLS.
REVOKE ALL ON public.magalu_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.magalu_connections TO service_role;

-- VIEW de status, sem token — é o que a tela de configurações pode ler.
CREATE OR REPLACE VIEW public.magalu_connections_status
WITH (security_invoker = true) AS
SELECT
  id, tenant_id, access_expires_at, access_ttl_seconds, scope, status,
  token_endpoint_format, last_refresh_at, last_error, created_at, updated_at
FROM public.magalu_connections;

-- A view é security_invoker, então continuaria barrada pela RLS da tabela base.
-- A policy abaixo libera SELECT só para admin, e só das colunas da view —
-- a tabela base segue sem GRANT para authenticated, então o token não sai.
CREATE POLICY "Magalu: select admin"
  ON public.magalu_connections FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

GRANT SELECT (id, tenant_id, access_expires_at, access_ttl_seconds, scope, status,
              token_endpoint_format, last_refresh_at, last_error, created_at, updated_at)
  ON public.magalu_connections TO authenticated;

GRANT SELECT ON public.magalu_connections_status TO authenticated;
GRANT ALL    ON public.magalu_connections_status TO service_role;
