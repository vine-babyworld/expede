# Magalu Marketplace API — base de conhecimento (EXPEDE)

> Mantido por: subagente `magalu-specialist` (`.claude/agents/magalu-specialist.md`).
> Leia este arquivo por inteiro antes de pesquisar de novo — ele é a memória entre sessões.

## 1. Visão geral e URLs oficiais

- Última verificação: 2026-08-19 (pesquisa inicial de viabilidade)
- **Dois portais de documentação encontrados, relação entre eles não totalmente clara ainda**:
  - `https://acelera.magalu.com/` — foco explícito em marketplace: catálogo, pedidos, etiquetas (Magalu Entregas). Provavelmente o canônico pra este caso de uso.
  - `https://developers.magalu.com/` ("Magalu Devs") — parece cobrir um escopo mais amplo do grupo (inclusive Magalu Cloud), com um guia de OAuth2/IDMagalu que se sobrepõe ao que o Acelera também documenta.
  - **A confirmar na próxima pesquisa**: qual dos dois é a fonte de verdade atual pra pedidos+etiqueta de marketplace, e se algum deles está sendo descontinuado em favor do outro.

## 2. Autenticação

- OAuth2, fluxo **Authorization Code**, gerenciado pelo **IDMagalu** (serviço central de identidade do grupo Magalu).
- Após registro do app: recebe `client_id` e `client_secret`, usados pra trocar o `code` de autorização por token.
- Detalhe de expiração/refresh de token ainda não mapeado.

## 3. API de pedidos

- Módulo de integração de pedidos existe: retorna dados do produto vendido, dados do cliente, valores da venda.
- Endpoints exatos, paginação e formato ainda não mapeados — a fazer quando a implementação começar.

## 4. API de etiquetas (Magalu Entregas)

- **Confirmado**: módulo permite leitura/identificação de pedidos do Magalu Entregas + emissão de etiqueta em **PDF e ZPL**.
- ZPL é o mesmo formato que o EXPEDE já processa (`src/lib/zpl-to-pdf.ts`, `src/lib/danfe-render.ts`) — maior candidato a reaproveitamento de código entre as três plataformas novas.
- Fluxo exato de "buscar etiqueta pronta" vs. "solicitar geração" ainda não mapeado (padrão check-then-create como o Shopee, ou diferente?) — não assumir, confirmar na doc/testes reais.

## 5. Homologação/aprovação

- Processo: cadastro em parceiro no Acelera Magalu → registro do app → homologação **módulo a módulo** → abertura de ticket no portal de suporte solicitando liberação pra produção.
- Isso é trabalho administrativo (do Vinicius, não do agente), mas condiciona quando o ambiente de produção fica disponível — sinalizar sempre como dependência externa no planejamento.

## 6. Particularidades do Brasil

- API é nacional (Magalu é empresa brasileira) — não se espera o mesmo tipo de "paridade incompleta" que Amazon/TikTok têm pro Brasil. A confirmar se há restrição por categoria de produto.

## 7. Riscos técnicos conhecidos

- **Bloqueio de IP de datacenter/Cloudflare Workers não confirmado nem descartado.** ML e Shopee, os dois canais já em produção, precisaram de proxy (Edge Function e gateway de IP fixo respectivamente). Não assumir que o Magalu será diferente só porque a doc não menciona — testar cedo.
- Relação entre os dois portais de doc (Acelera vs. Magalu Devs) pode gerar confusão sobre qual é a versão vigente da API — checar changelog de ambos antes de codar contra um deles.

## 8. Changelog observado

- 2026-08-19: primeira pesquisa de viabilidade, nenhuma implementação ainda. Nada a registrar como "mudança" — este é o baseline.

## 9. Checklist de implementação proposto (pendente de início)

- [ ] Confirmar qual portal (Acelera Magalu vs. Magalu Devs) é a fonte de verdade atual pra marketplace/pedidos/etiquetas
- [ ] Cadastro de parceiro + registro de app no Acelera Magalu
- [ ] Mapear endpoints reais de pedidos e etiqueta (Magalu Entregas), confirmar paginação e campos
- [ ] Confirmar fluxo de etiqueta: buscar-se-existe-senão-criar (padrão Shopee) ou diferente
- [ ] Testar chamada real do Cloudflare Worker → API Magalu; se bloqueado, replicar padrão de proxy
- [ ] Criar `src/lib/magalu.ts` seguindo o padrão de `src/lib/shopee.ts`, reaproveitando `zpl-to-pdf.ts` pra renderização de etiqueta
- [ ] Rota de debug não-destrutiva (`src/routes/api/debug/magalu-etiqueta-teste.ts`), mesmo padrão das outras integrações
- [ ] Iniciar homologação módulo a módulo cedo — é dependência externa de prazo incerto
