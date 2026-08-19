# TikTok Shop Open API — base de conhecimento (EXPEDE)

> Mantido por: subagente `tiktok-shop-specialist` (`.claude/agents/tiktok-shop-specialist.md`).
> Leia este arquivo por inteiro antes de pesquisar de novo — ele é a memória entre sessões.

## 1. Visão geral e URLs oficiais

- Última verificação: 2026-08-19 (pesquisa inicial de viabilidade, pré-conta criada)
- Hub de docs: `https://partner.tiktokshop.com/docv2/page/tts-developer-guide`
- Central do Vendedor Brasil: `https://seller-br.tiktok.com/university`
- Ainda não criamos conta de desenvolvedor/loja no Partner Center — Vinicius vai criar a conta TikTok primeiro, antes das outras duas plataformas.

## 2. Autenticação

- Não confirmado em detalhe ainda. Sabido: API exige **assinatura própria por request** (não é só OAuth2 puro) — mesma classe de mecanismo que o Shopee usa, que já causou o incidente "Wrong sign" (Lição #21/#27 do EXPEDE, ver `expede_shopee_token_refresh_bug` na memória do Vinicius). Tratar como ponto de atenção nº1 assim que a conta for criada: validar o algoritmo de assinatura contra um teste unitário com credenciais fictícias, do jeito que foi feito pro Shopee, ANTES de tentar autorizar em produção.

## 3. Order API

- Existe, cobre: listar pedidos por status (não pago, aguardando envio, enviado, entregue, cancelado), detalhe do pedido (cliente, itens, endereço, pagamento), atualização de status.
- Endpoints exatos ainda não mapeados — a fazer quando a implementação começar.

## 4. Logistics API

- Existe: criação de pacotes, geração de etiqueta, push de código de rastreio/transportadora, split shipment, pacote combinado, status de entrega.
- Dois modelos de fulfillment no Brasil:
  - **Envio pelo TikTok** (padrão): vendedor usa a transportadora (LSP) designada pela TikTok Shop na Central do Vendedor (J&T Express, Correios, iMile, Total Express, Jadlog citados pelo mercado). Etiqueta gerada pela plataforma, vendedor despacha (drop-off ou pick-up). **Este é o modelo equivalente ao padrão Shopee/ML** (etiqueta pronta pra buscar via API).
  - **Envio pelo Vendedor** (self-fulfillment): vendedor escolhe o próprio LSP, sem etiqueta gerada pela TikTok.
- Qual modelo a Baby World vai usar ainda não foi decidido/confirmado — isso determina se a Logistics API de etiqueta é sequer necessária.
- Documentação de Logistics API encontrada é majoritariamente voltada a mercados maduros (US/SEA) — **paridade com Brasil não confirmada**. Confirmar isso é prioridade assim que houver acesso ao Partner Center com loja BR.

## 5. Homologação/aprovação

Não detalhado ainda — a mapear quando a conta for criada.

## 6. Particularidades do Brasil confirmadas

- TikTok Shop lançou oficialmente no Brasil em **8 de maio de 2025**.
- Cresceu de US$ 1M/mês em GMV no primeiro mês pra US$ 46M/mês em menos de um ano.
- TikTok criou transportadora própria — **TikTok Logistics Brazil**, registrada com capital de R$ 111 milhões, sede em SP, formalizada em **julho de 2025**. Ou seja, a operação logística própria da TikTok no Brasil tem poucos meses de existência — esperar instabilidade/mudança de comportamento maior que em mercados maduros.

## 7. Riscos técnicos conhecidos

- **Assinatura de request própria** — maior risco único, já mordeu o EXPEDE uma vez no Shopee (custou 2 sessões de debugging, Lições #21 e #27-28). Testar isoladamente antes de integrar de ponta a ponta.
- **Possível bloqueio de IP de datacenter/Cloudflare Workers** — não confirmado nem descartado ainda. ML e Shopee, os dois canais já em produção no EXPEDE, precisaram de proxy (Edge Function pro ML, gateway de IP fixo pro Shopee). Assumir que pode acontecer de novo até provar o contrário.
- **Paridade de API Brasil vs. US/SEA não confirmada** — doc pública não deixa claro se toda a Logistics API documentada funciona igual pra loja BR.
- **Operação logística própria da TikTok é recente** (meses) — maior chance de mudança de comportamento/endpoint sem aviso claro comparado a APIs mais maduras.

## 8. Changelog observado

- 2026-08-19: primeira pesquisa de viabilidade, nenhuma implementação ainda. Nada a registrar como "mudança" — este é o baseline.

## 9. Checklist de implementação proposto (pendente de início)

- [ ] Criar app no Partner Center, confirmar quais escopos existem pra Order API e Logistics API
- [ ] Validar algoritmo de assinatura com teste unitário isolado (credenciais fictícias) ANTES de tentar auth real — lição direta do Shopee
- [ ] Confirmar modelo de fulfillment real da Baby World no TikTok (Envio pelo TikTok vs. Envio pelo Vendedor)
- [ ] Confirmar se a Logistics API de etiqueta cobre loja BR de fato (não só doc genérica)
- [ ] Testar chamada real do Cloudflare Worker → API TikTok; se bloqueado, replicar padrão de proxy (Edge Function ou gateway dedicado)
- [ ] Criar `src/lib/tiktok.ts` seguindo o padrão de `src/lib/shopee.ts` (tabela de conexão OAuth, refresh de token, fetch com wrapper de proxy se necessário)
- [ ] Rota de debug não-destrutiva (`src/routes/api/debug/tiktok-etiqueta-teste.ts`), mesmo padrão das outras integrações
