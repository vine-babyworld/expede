
-- 1. Adicionar empresa_id em profiles para scoping multi-tenant
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS empresa_id uuid
  DEFAULT '11111111-1111-1111-1111-111111111111'::uuid;

UPDATE public.profiles SET empresa_id = '11111111-1111-1111-1111-111111111111'::uuid WHERE empresa_id IS NULL;

-- 2. Atualizar trigger handle_new_user para incluir empresa_id default
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, nome, email, ativo, empresa_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nome', split_part(NEW.email, '@', 1)),
    NEW.email,
    true,
    '11111111-1111-1111-1111-111111111111'::uuid
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- 3. Função helper para obter empresa_id do usuário corrente
CREATE OR REPLACE FUNCTION public.current_empresa_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT empresa_id FROM public.profiles WHERE id = auth.uid()
$$;

-- 4. EMPRESAS — apenas SELECT da própria empresa; admin gerencia
DROP POLICY IF EXISTS "Autenticados leem empresas" ON public.empresas;
DROP POLICY IF EXISTS "Admins gerenciam empresas" ON public.empresas;
CREATE POLICY "Empresas: select própria empresa"
  ON public.empresas FOR SELECT TO authenticated
  USING (id = public.current_empresa_id() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Empresas: admin insere"
  ON public.empresas FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Empresas: admin atualiza"
  ON public.empresas FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Empresas: admin deleta"
  ON public.empresas FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 5. CANAIS — todos autenticados leem; só admin escreve
DROP POLICY IF EXISTS "Autenticados leem canais" ON public.canais;
DROP POLICY IF EXISTS "Admins gerenciam canais" ON public.canais;
CREATE POLICY "Canais: select autenticados"
  ON public.canais FOR SELECT TO authenticated USING (true);
CREATE POLICY "Canais: admin insere"
  ON public.canais FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Canais: admin atualiza"
  ON public.canais FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Canais: admin deleta"
  ON public.canais FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 6. PRODUTOS — leitura escopada por empresa; escrita apenas admin da mesma empresa
DROP POLICY IF EXISTS "Autenticados leem produtos" ON public.produtos;
DROP POLICY IF EXISTS "Admins gerenciam produtos" ON public.produtos;
CREATE POLICY "Produtos: select da empresa"
  ON public.produtos FOR SELECT TO authenticated
  USING (empresa_id = public.current_empresa_id() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Produtos: admin insere"
  ON public.produtos FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') AND empresa_id = public.current_empresa_id());
CREATE POLICY "Produtos: admin atualiza"
  ON public.produtos FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') AND empresa_id = public.current_empresa_id())
  WITH CHECK (public.has_role(auth.uid(), 'admin') AND empresa_id = public.current_empresa_id());
CREATE POLICY "Produtos: admin deleta"
  ON public.produtos FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') AND empresa_id = public.current_empresa_id());

-- 7. PEDIDOS — escopados por empresa; delete apenas admin
DROP POLICY IF EXISTS "Autenticados leem pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Autenticados atualizam pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Admins gerenciam pedidos" ON public.pedidos;
CREATE POLICY "Pedidos: select da empresa"
  ON public.pedidos FOR SELECT TO authenticated
  USING (empresa_id = public.current_empresa_id() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Pedidos: insert da empresa"
  ON public.pedidos FOR INSERT TO authenticated
  WITH CHECK (empresa_id = public.current_empresa_id() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Pedidos: update da empresa"
  ON public.pedidos FOR UPDATE TO authenticated
  USING (empresa_id = public.current_empresa_id() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (empresa_id = public.current_empresa_id() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Pedidos: admin deleta"
  ON public.pedidos FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 8. PEDIDO_ITENS — escopados via join em pedidos
DROP POLICY IF EXISTS "Autenticados leem pedido_itens" ON public.pedido_itens;
DROP POLICY IF EXISTS "Autenticados atualizam pedido_itens" ON public.pedido_itens;
DROP POLICY IF EXISTS "Admins gerenciam pedido_itens" ON public.pedido_itens;
CREATE POLICY "PedidoItens: select da empresa"
  ON public.pedido_itens FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.pedidos p WHERE p.id = pedido_itens.pedido_id AND p.empresa_id = public.current_empresa_id())
  );
CREATE POLICY "PedidoItens: insert da empresa"
  ON public.pedido_itens FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.pedidos p WHERE p.id = pedido_itens.pedido_id AND p.empresa_id = public.current_empresa_id())
  );
CREATE POLICY "PedidoItens: update da empresa"
  ON public.pedido_itens FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.pedidos p WHERE p.id = pedido_itens.pedido_id AND p.empresa_id = public.current_empresa_id())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.pedidos p WHERE p.id = pedido_itens.pedido_id AND p.empresa_id = public.current_empresa_id())
  );
CREATE POLICY "PedidoItens: admin deleta"
  ON public.pedido_itens FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 9. BIPAGENS — audit log imutável: SELECT por empresa, INSERT pelo próprio user_id, sem UPDATE/DELETE
DROP POLICY IF EXISTS "Autenticados leem bipagens" ON public.bipagens;
DROP POLICY IF EXISTS "Autenticados inserem bipagens" ON public.bipagens;
DROP POLICY IF EXISTS "Admins gerenciam bipagens" ON public.bipagens;
CREATE POLICY "Bipagens: select da empresa"
  ON public.bipagens FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.pedido_itens pi
      JOIN public.pedidos p ON p.id = pi.pedido_id
      WHERE pi.id = bipagens.pedido_item_id AND p.empresa_id = public.current_empresa_id()
    )
  );
CREATE POLICY "Bipagens: insert próprio user_id"
  ON public.bipagens FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.pedido_itens pi
      JOIN public.pedidos p ON p.id = pi.pedido_id
      WHERE pi.id = bipagens.pedido_item_id AND p.empresa_id = public.current_empresa_id()
    )
  );
-- Sem policy de UPDATE nem DELETE: audit log imutável (nem admin altera)

-- 10. SECURITY DEFINER functions — revogar execução de papéis públicos
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

REVOKE EXECUTE ON FUNCTION public.current_empresa_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_empresa_id() TO authenticated, service_role;
