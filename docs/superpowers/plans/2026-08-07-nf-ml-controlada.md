# Plano de implementação: controle de NF Mercado Livre

**Design:** `docs/superpowers/specs/2026-08-07-nf-flex-automatica-design.md`

## 1. Persistência

- Criar migration com as colunas `nf_emissao_*`, constraints de valores, índice
  parcial da fila e chave de ativação desarmada em `app_config`.
- Atualizar os tipos locais do Supabase.

## 2. Política de classificação

- Extrair uma função pura que classifique o detalhe atual do Bling em
  `manual`, `automatic`, `existing`, `cancelled` ou `out_of_scope`.
- Manter `isPedidoFlex()` como única regra de identificação de Flex.
- Shopee nunca pode ser promovida para emissão automática nesta fase.

## 3. Ingestão

- Ao importar/reconciliar pedido ML sem NF, inicializar o estado apenas se ainda
  não houver decisão registrada.
- Permitir no webhook pedido sem NF somente quando `loja.id` confirmar a loja ML.
- Preservar pedidos, itens e quantidade bipada em entregas duplicadas.

## 4. Cliente fiscal Bling

- Implementar leitura defensiva do pedido, geração da NF e envio para SEFAZ.
- Sanitizar erros e classificá-los entre retry e bloqueio.
- Persistir `bling_nota_fiscal_id` antes da chamada de envio.

## 5. Worker controlador

- Implementar gate via `cron_state`, seleção rotativa e claim por linha.
- Encerrar sem efeitos enquanto `nf_emissao_ml_ativa` não for explicitamente
  habilitada.
- Revalidar classificação/cancelamento/NF existente antes da geração.
- Retomar envio de uma NF já criada sem executar `gerar-nfe` novamente.
- Registrar estado final e liberar lease em todos os caminhos.

## 6. Integração e verificação

- Registrar o cron no plugin Cloudflare.
- Exibir o estado do controlador na tela de Pedidos, incluindo bloqueio e retry.
- Executar `git diff --check` e `npm run build`.
- Revisar o diff para confirmar ausência de alterações no fluxo Shopee.
- Não aplicar migration, não fazer deploy e não desligar configuração do Bling
  sem nova confirmação explícita do Vinicius.
