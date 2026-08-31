-- Torna a emissão de NF dos pedidos ML Flex configurável pela UI.
-- Nasce DESLIGADA: até aqui o Flex era emissão manual do operador no Bling, e
-- ligar por acidente produziria documento fiscal irreversível.

INSERT INTO public.app_config (key, value)
VALUES ('nf_emissao_flex_ativa', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.app_config IS
  'Configuração operacional server-side. Sem policies: acesso somente por service role. Chaves: nf_emissao_ml_ativa (kill switch do controlador), nf_emissao_flex_ativa (emitir NF também para ML Flex).';
