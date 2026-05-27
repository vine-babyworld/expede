-- BLING CONNECTIONS
CREATE TABLE public.bling_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bling_account_id text,
  bling_account_name text,
  access_token bytea,
  refresh_token bytea,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  scope text,
  status text NOT NULL DEFAULT 'connected',
  last_refresh_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bling_connections_user ON public.bling_connections(user_id);
CREATE INDEX idx_bling_connections_status ON public.bling_connections(status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bling_connections TO authenticated;
GRANT ALL ON public.bling_connections TO service_role;

ALTER TABLE public.bling_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bling: select própria ou admin"
  ON public.bling_connections FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Bling: admin insere"
  ON public.bling_connections FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Bling: update própria ou admin"
  ON public.bling_connections FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (user_id = auth.uid() OR has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Bling: delete própria ou admin"
  ON public.bling_connections FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_bling_connections_updated_at
  BEFORE UPDATE ON public.bling_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- VIEW segura (sem tokens)
CREATE VIEW public.bling_connections_status
WITH (security_invoker = true) AS
SELECT
  id, user_id, bling_account_id, bling_account_name,
  access_expires_at, refresh_expires_at, scope, status,
  last_refresh_at, last_error, created_at, updated_at
FROM public.bling_connections;

GRANT SELECT ON public.bling_connections_status TO authenticated;
GRANT ALL ON public.bling_connections_status TO service_role;

-- OAUTH STATES
CREATE TABLE public.oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used boolean NOT NULL DEFAULT false
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.oauth_states TO authenticated;
GRANT ALL ON public.oauth_states TO service_role;

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "OAuth states: próprio user"
  ON public.oauth_states FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.cleanup_oauth_states()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.oauth_states WHERE created_at < now() - interval '10 minutes';
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_oauth_states() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_oauth_states() TO authenticated, service_role;