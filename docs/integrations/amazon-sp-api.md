# Amazon Selling Partner API (SP-API) — base de conhecimento (EXPEDE)

> Mantido por: subagente `amazon-sp-api-specialist` (`.claude/agents/amazon-sp-api-specialist.md`).
> Leia este arquivo por inteiro antes de pesquisar de novo — ele é a memória entre sessões.

## 1. Visão geral e URLs oficiais

- Última verificação: 2026-08-19 (pesquisa inicial de viabilidade)
- Hub principal: `https://developer-docs.amazon.com/sp-api/`
- Onboarding: `https://developer-docs.amazon.com/sp-api/docs/onboarding-overview`, `https://developer-docs.amazon.com/sp-api/docs/selling-partner-api-onboarding-overview`
- Shipping API v2 (recomendada pra integrações novas): `https://developer-docs-amazon-shipping.readme.io/apis/docs/shipping-api-v2-reference`
- Release notes (checar sempre, API muda com frequência): `https://developer-docs.amazon/sp-api/docs/sp-api-release-notes`

## 2. Autenticação

- LWA (Login with Amazon) OAuth — modelo mais simples do que era há alguns anos; boa parte dos endpoints não exige mais assinatura AWS SigV4 (a confirmar se algum endpoint específico usado pelo EXPEDE ainda exige, ex: notificações via SQS).

## 3. Modelo de fulfillment da Baby World — **não confirmado ainda**

Isso é a decisão mais importante antes de qualquer código: a Baby World vai operar na Amazon como **MFN (Merchant Fulfilled Network / envio próprio)**, usando **Amazon Buy Shipping**, ou via **FBA**? Cada opção muda completamente o escopo de API necessário:
- **MFN sem Buy Shipping** (mais comum no Brasil): só precisa da Orders API pra ler pedido e confirmar envio (`confirmShipment`) com o rastreio que o Bling/transportadora contratada já gerou. **Não precisa buscar etiqueta da Amazon** — mais parecido com um canal genérico do que com Shopee/ML.
- **MFN com Amazon Buy Shipping**: precisa também de Merchant Fulfillment API (legado) ou Shipping API v2 (recomendada) pra cotar/comprar a etiqueta através da Amazon.
- **FBA**: outro modelo inteiro (Fulfillment Inbound API), que — atenção — **não cobre criação de shipment pro marketplace Brasil** segundo a doc atual. Se a Baby World for pra esse modelo, é preciso reconfirmar isso primeiro, pois pode ser bloqueante.

## 4. Orders API

- Endpoints, paginação e campos exatos ainda não mapeados — a fazer quando o modelo de fulfillment acima for confirmado.

## 5. Shipping/Merchant Fulfillment API

- Só relevante se a Baby World usar Amazon Buy Shipping (ver seção 3). Se for MFN puro, pular esta API inteira.
- Merchant Fulfillment API é legado — Amazon recomenda Shipping API v2 pra integrações novas.

## 6. Restricted Data Token / aprovação de PII

- Acesso a dados pessoais do comprador (nome, endereço, telefone) via SP-API exige aprovação de **Restricted Data Token** — processo formal da Amazon, não é liberado por padrão.
- **Este é o maior item de lead time do projeto Amazon inteiro** — maior que qualquer trabalho de código. Recomendação: iniciar esse processo de aprovação assim que a decisão de integrar a Amazon for tomada, em paralelo a qualquer outra coisa, porque o prazo é medido em semanas.
- Documentos/requisitos exatos do processo ainda não mapeados — a fazer.

## 7. Particularidades e limitações confirmadas do marketplace Brasil

- **Fulfillment Inbound API não cobre criação de shipment pro Brasil** (funciona pra outros marketplaces Amazon, não BR).
- Existe uma **Delivery by Amazon API**, disponível especificamente pro marketplace Brasil (BR), mas em status "Restricted Availability" — não confirmado se é relevante pro caso de uso do EXPEDE (parece mais voltada a buscar informação de nota fiscal de envio do que a gerar etiqueta).
- SP-API historicamente trata o Brasil como "cidadão de segunda classe" em paridade de endpoints comparado a US — nunca assumir que um endpoint documentado genericamente cobre BR sem confirmar explicitamente.

## 8. Riscos técnicos conhecidos

- Bloqueio de IP de datacenter/Cloudflare Workers: não confirmado nem descartado. SP-API historicamente não exige IP fixo (diferente de Shopee), mas testar antes de prometer que funciona direto do Worker.
- Paridade Brasil incompleta em vários endpoints — validar caso a caso.
- Rate limiting/throttling da SP-API é conhecido por ser rígido (buckets por endpoint) — mapear limites reais quando a implementação começar.

## 9. Changelog observado

- 2026-08-19: primeira pesquisa de viabilidade, nenhuma implementação ainda. Nada a registrar como "mudança" — este é o baseline.

## 10. Checklist de implementação proposto (pendente de início)

- [ ] Confirmar com Vinicius/operação: modelo de fulfillment real da Baby World na Amazon (MFN puro, MFN+Buy Shipping, ou FBA)
- [ ] Iniciar processo de aprovação de Restricted Data Token o quanto antes (maior lead time do projeto)
- [ ] Registrar app no Developer Central, confirmar escopos necessários (Orders, e Shipping se aplicável)
- [ ] Mapear endpoints reais de pedidos e (se aplicável) etiqueta
- [ ] Testar chamada real do Cloudflare Worker → SP-API; confirmar se precisa de proxy como ML/Shopee
- [ ] Criar `src/lib/amazon.ts` — padrão mais próximo provavelmente é `src/lib/bling.functions.ts` (buscar/confirmar pedido) e não `src/lib/shopee.ts` (buscar etiqueta gerada pela plataforma), a menos que MFN+Buy Shipping seja confirmado
- [ ] Rota de debug não-destrutiva (`src/routes/api/debug/amazon-pedido-teste.ts`), mesmo padrão das outras integrações
