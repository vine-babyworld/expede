
-- 1. Enum de papéis
CREATE TYPE public.app_role AS ENUM ('admin', 'operador');

-- 2. Tabela profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. Tabela user_roles
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 4. has_role security definer
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 5. RLS profiles
CREATE POLICY "Usuários veem o próprio profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Admins veem todos profiles" ON public.profiles
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins inserem profiles" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins atualizam profiles" ON public.profiles
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Usuário atualiza próprio profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);

-- 6. RLS user_roles
CREATE POLICY "Usuários veem próprios papéis" ON public.user_roles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admins veem todos papéis" ON public.user_roles
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins gerenciam papéis" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 7. Trigger de criação de profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, nome, email, ativo)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nome', split_part(NEW.email, '@', 1)),
    NEW.email,
    true
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 8. Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 9. Bipagens: adicionar user_id
ALTER TABLE public.bipagens ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 10. Endurecer RLS das tabelas existentes (remover policies "allow all")
DROP POLICY IF EXISTS "allow all" ON public.bipagens;
DROP POLICY IF EXISTS "allow all" ON public.canais;
DROP POLICY IF EXISTS "allow all" ON public.empresas;
DROP POLICY IF EXISTS "allow all" ON public.pedido_itens;
DROP POLICY IF EXISTS "allow all" ON public.pedidos;
DROP POLICY IF EXISTS "allow all" ON public.produtos;

-- Revogar acesso anon nas tabelas operacionais
REVOKE ALL ON public.bipagens, public.canais, public.empresas, public.pedido_itens, public.pedidos, public.produtos FROM anon;

-- canais/empresas/produtos/pedidos/pedido_itens: leitura para autenticados, escrita para admin
CREATE POLICY "Autenticados leem canais" ON public.canais FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins gerenciam canais" ON public.canais FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Autenticados leem empresas" ON public.empresas FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins gerenciam empresas" ON public.empresas FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Autenticados leem produtos" ON public.produtos FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins gerenciam produtos" ON public.produtos FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Autenticados leem pedidos" ON public.pedidos FOR SELECT TO authenticated USING (true);
CREATE POLICY "Autenticados atualizam pedidos" ON public.pedidos FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Admins gerenciam pedidos" ON public.pedidos FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Autenticados leem pedido_itens" ON public.pedido_itens FOR SELECT TO authenticated USING (true);
CREATE POLICY "Autenticados atualizam pedido_itens" ON public.pedido_itens FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Admins gerenciam pedido_itens" ON public.pedido_itens FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- bipagens: autenticados inserem e leem; só admin apaga
CREATE POLICY "Autenticados leem bipagens" ON public.bipagens FOR SELECT TO authenticated USING (true);
CREATE POLICY "Autenticados inserem bipagens" ON public.bipagens
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins gerenciam bipagens" ON public.bipagens FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 11. Criar usuário admin inicial: vinicius@lojababyworld.com.br / Expede@2026
DO $$
DECLARE
  new_user_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'vinicius@lojababyworld.com.br') THEN
    new_user_id := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      new_user_id,
      'authenticated',
      'authenticated',
      'vinicius@lojababyworld.com.br',
      crypt('Expede@2026', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"nome":"Vinicius"}'::jsonb,
      now(), now(), '', '', '', ''
    );
    INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    VALUES (
      gen_random_uuid(), new_user_id,
      format('{"sub":"%s","email":"%s"}', new_user_id, 'vinicius@lojababyworld.com.br')::jsonb,
      'email', new_user_id::text, now(), now(), now()
    );
    INSERT INTO public.user_roles (user_id, role) VALUES (new_user_id, 'admin');
  END IF;
END $$;
