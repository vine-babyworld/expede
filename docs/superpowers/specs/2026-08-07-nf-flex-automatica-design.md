# Design: EXPEDE como controlador de emissão de NF do Mercado Livre

**Data:** 2026-08-07
**Status:** Aprovado para implementação
**Escopo:** Mercado Livre normal e Mercado Envios Flex. Shopee fica fora desta fase.

## Decisão de produto

O Bling continua recebendo o pedido de venda e reservando a mercadoria. A
emissão automática de NF-e no Bling só será desligada depois que este
controlador estiver publicado e validado.

O EXPEDE passa a aplicar a seguinte política:

- pedido Mercado Envios Flex sem NF: não gera nem envia NF; a emissão posterior
  fica sob decisão manual do Vinicius no Bling;
- pedido Mercado Livre não Flex sem NF: gera a NF a partir do pedido de venda e
  envia a NF para autorização na SEFAZ;
- pedido que já possui NF: nunca gera outra; apenas sincroniza e acompanha a NF
  existente;
- pedido Shopee: fluxo atual inalterado. Entrega Direta será tratada em uma fase
  futura, quando houver vendas reais para validar a identificação.

## Estado atual reaproveitado

- `reconciliarPedidos()` já consulta todos os pedidos da loja Mercado Livre,
  inclusive sem NF, e grava o detalhe bruto do pedido.
- `isPedidoFlex()` já identifica Flex pela classificação persistida ou pelo nome
  do serviço em `raw_json.transporte.volumes[0].servico`.
- `atualizarSituacoesExistentes()` já detecta uma NF criada manualmente no Bling.
- `cronNfStatus()` já acompanha a autorização de qualquer NF conhecida.
- A API oficial do Bling oferece
  `POST /pedidos/vendas/{idPedidoVenda}/gerar-nfe` e depois
  `POST /nfe/{idNotaFiscal}/enviar?enviarEmail=false`.

## Gap obrigatório antes de desligar o Bling

O webhook `POST /api/public/hooks/bling-pedidos` atualmente descarta qualquer
pedido sem NF. O reconciliador recupera esses pedidos depois, mas o controlador
não pode depender apenas desse fallback. O webhook deve aceitar pedido sem NF
somente quando o detalhe do Bling confirmar que ele pertence à loja Mercado
Livre conhecida. Sem identificação segura da loja, o comportamento é
conservador: não emitir.

## Máquina de estado

Novas colunas em `pedidos`:

| Coluna | Uso |
|---|---|
| `nf_emissao_modo` | `automatic` para ML normal; `manual` para ML Flex; `NULL` fora do escopo |
| `nf_emissao_status` | `pending`, `processing`, `created`, `sent`, `retry`, `blocked`, `manual` |
| `nf_emissao_attempts` | número de claims do controlador |
| `nf_emissao_last_attempt_at` | controle de retry e auditoria |
| `nf_emissao_locked_at` | lease para impedir dois workers no mesmo pedido |
| `nf_emissao_error` | código/mensagem sanitizada do último erro |

Regras de inicialização:

- ML Flex sem NF → `manual/manual`;
- ML normal sem NF → `automatic/pending`;
- pedidos com NF existente não entram na fila;
- Shopee não recebe esses campos nesta fase.

## Processamento idempotente

Um cron próprio seleciona poucos candidatos por execução. Antes de chamar o
Bling, faz um claim condicional por linha, alterando `pending|retry|created` para
`processing` somente se o lease estiver livre ou expirado. Se outro worker já
reivindicou a linha, a atualização não retorna registro e o candidato é pulado.

Depois do claim, o EXPEDE relê o pedido no Bling e aplica as cercas abaixo:

1. se o pedido foi cancelado, marca `blocked`;
2. se o detalhe atual indicar Flex, muda para `manual/manual` e não emite;
3. se já houver NF, persiste o ID e não gera outra;
4. se `bling_nota_fiscal_id` já estiver salvo em estado `created`, retoma apenas
   o envio;
5. somente então chama `gerar-nfe`, persiste imediatamente o ID retornado e
   chama `enviar`;
6. erro transitório (rede, 429 ou 5xx) vira `retry`; erro de validação 4xx vira
   `blocked` para correção humana, sem loop agressivo.

Essa persistência entre geração e envio é obrigatória: se o worker cair depois
de criar a NF, a próxima execução continua pelo ID salvo em vez de criar outra.

## Cadência e rate limit

- Cron a cada minuto, com gate durável em `cron_state`.
- Até dois pedidos por ciclo nesta primeira versão.
- Espera mínima entre chamadas ao Bling, respeitando o limite documentado de
  três requisições por segundo e deixando margem para os crons existentes.
- Retry transitório somente após cinco minutos.

## Chave de ativação

O controlador é publicado desarmado. A migration cria em `app_config` a chave
`nf_emissao_ml_ativa = false`, e o cron encerra sem processar candidatos enquanto
ela não estiver explicitamente em `true`. Isso evita uma corrida entre o EXPEDE
e a geração automática que ainda estará ativa no Bling durante o deploy.

## Implantação segura

1. revisar e aprovar código e migration;
2. aplicar migration;
3. publicar o EXPEDE com o controlador desarmado;
4. validar ingestão/classificação com pedidos reais sem comandar mudanças
   manuais no banco;
5. desligar no Bling a opção de gerar NF ao incluir pedido;
6. alterar `nf_emissao_ml_ativa` para `true`;
7. acompanhar os primeiros pedidos ML normal e Flex nos logs e no Bling.

Não existe cenário seguro em que a automação do Bling seja desligada antes dos
passos 1–3.
