# EXPEDE como produto gerenciado vendável — especificação de arquitetura

**Data:** 01/09/2026  
**Status:** desenho aprovado em conversa; aguardando revisão do arquivo pelo responsável do produto  
**Escopo:** produtização, piloto Bling, operação gerenciada, conectores, documentação e comercialização

## 1. Contexto

O EXPEDE nasceu da dificuldade prática de utilizar o processo de expedição do Bling no chão de operação. O Bling permanece como sistema de gestão e fonte oficial dos dados; o EXPEDE deve oferecer ao colaborador uma experiência especializada, simples e segura para consultar a fila, conferir produtos, validar condições mínimas, imprimir documentos e registrar a expedição.

O sistema atual já possui um MVP funcional com Bling, Mercado Livre, Shopee, bipagem, impressão, validações e histórico. Para receber credenciais e dados de clientes externos, precisa evoluir de aplicação interna para serviço gerenciado repetível, seguro, documentado, monitorado e comercialmente delimitado.

## 2. Proposta de valor

> O ERP administra a empresa. O EXPEDE conduz a operação de expedição.

O EXPEDE não será vendido com a alegação de que Bling ou Olist/Tiny não possuem expedição. Ambos possuem recursos nativos. O diferencial será reduzir a complexidade percebida pelo operador e reunir o fluxo operacional de Bling, Mercado Livre e Shopee numa central orientada à conferência.

Promessa de produto:

- uma central de trabalho para o operador;
- menos navegação entre ERP e marketplaces;
- conferência orientada por leitura de produtos;
- bloqueios compreensíveis em vez de falhas silenciosas;
- etiqueta e DANFE entregues no momento adequado;
- rastreabilidade por usuário;
- implantação, monitoramento, documentação e suporte gerenciados.

## 3. Objetivos

1. Tornar o EXPEDE implantável em clientes externos sem criar cópias do código por cliente.
2. Preservar a simplicidade da operação mesmo com múltiplas contas e marketplaces.
3. Impedir expedição duplicada, conferência incorreta e uso de dados incompletos.
4. Oferecer isolamento, segurança, backup, auditoria e suporte compatíveis com um serviço pago.
5. Homologar primeiro o conjunto Bling + Mercado Livre/Shopee.
6. Executar um piloto pago, colaborativo e mensurável.
7. Produzir manuais, guias técnicos, procedimentos e materiais comerciais versionados.

## 4. Fora do escopo inicial

- Emissão ou correção de documentos fiscais pelo EXPEDE.
- Desenvolvimento antecipado do conector Tiny/Olist.
- Devoluções e logística reversa.
- Múltiplos volumes.
- Aplicação operacional otimizada para celular.
- White-label.
- Cobrança automatizada.
- Infraestrutura SaaS multiempresa compartilhada.
- Customizações permanentes no código para um cliente específico.

## 5. Cliente ideal inicial

Vendedores que:

- utilizam Bling como ERP;
- vendem no Mercado Livre e/ou Shopee;
- possuem colaboradores dedicados à expedição;
- movimentam volume suficiente para sentir o custo da complexidade operacional;
- aceitam indicar um responsável interno para implantação, homologação e decisões;
- mantêm cadastros de produtos, pedidos e documentos fiscais sob sua responsabilidade.

Clientes Tiny/Olist não serão foco inicial. Um conector Tiny somente entra em execução depois de piloto pago e assinado que demonstre uma necessidade não atendida pelo ERP nativo.

## 6. Abordagem arquitetural escolhida

### 6.1 Decisão

Adotar produto gerenciado e padronizado, com:

- um único código-base;
- infraestrutura separada por cliente;
- comportamento definido por configuração;
- plataforma-base;
- conectores opcionais;
- publicação controlada das mesmas versões em todos os ambientes compatíveis.

### 6.2 Alternativas rejeitadas

**Código customizado por cliente:** reduz o esforço de uma venda pontual, mas cria versões incompatíveis, multiplica bugs e inviabiliza atualização consistente.

**SaaS multiempresa compartilhado agora:** pode trazer escala futura, mas exige reconstrução relevante de segurança e dados, além de contrariar a decisão comercial de ambiente separado nesta fase.

## 7. Responsabilidades dos componentes

### 7.1 Bling

- fonte oficial de pedidos;
- fonte oficial de produtos, SKUs, EANs e kits;
- fonte oficial de notas fiscais e suas situações;
- método oficial de contingência operacional.

### 7.2 Mercado Livre e Shopee

- contas e lojas de marketplace;
- modalidade logística;
- etiqueta e rastreamento;
- situação de envio disponibilizada oficialmente;
- demais dados estritamente necessários ao fluxo homologado.

### 7.3 EXPEDE

- normalização dos dados recebidos;
- organização e consulta da fila operacional;
- aplicação de regras homologadas;
- reserva temporária de pedido por operador;
- conferência dos produtos;
- impressão e reimpressão;
- tratamento visível de pendências;
- reconciliação após contingência;
- auditoria da operação;
- monitoramento e suporte técnico.

### 7.4 Cliente

- dados e cadastros no ERP;
- regras fiscais e dispensas aplicáveis;
- prioridades e horários de despacho;
- permissões concedidas no Bling;
- resolução de questões fiscais e cancelamentos;
- indicação de responsável interno;
- aprovação de mudanças de processo.

O EXPEDE não controla horários de despacho. A empresa conhece seus cortes por marketplace e o operador decide a prioridade usando filtros e informações da fila.

## 8. Perfis e responsabilidades

### 8.1 Operador

- consulta todas as situações;
- filtra, pesquisa e escolhe qualquer pedido liberado;
- inicia e retoma conferências;
- realiza uma leitura por unidade;
- confirma visualmente produtos sem EAN;
- conclui e imprime;
- reimprime com motivo;
- consulta o Bling e resolve questões operacionais autorizadas pelo cliente;
- não ignora bloqueios nem altera configurações técnicas.

### 8.2 Administrador do cliente

- administra usuários e acessos;
- acompanha pendências, conexões e auditoria;
- autoriza integrações;
- resolve ou encaminha exceções operacionais e fiscais;
- aprova regras, mudanças e aceite do piloto;
- aciona o suporte EXPEDE.

### 8.3 Administrador EXPEDE

- usa conta nominal separada;
- configura ambiente e integrações;
- mantém, monitora, publica e documenta o serviço;
- executa suporte técnico;
- não toma decisões fiscais ou comerciais pelo cliente;
- tem todas as ações administrativas auditadas.

Não haverá perfil técnico de supervisor no piloto. A responsabilidade de supervisão será acumulada pelo administrador do cliente. Nenhuma conta será compartilhada.

## 9. Central de Expedição

As telas atuais “A Expedir” e “Expedição” serão conceitualmente reunidas numa Central de Expedição.

### 9.1 Consulta

O operador poderá:

- visualizar todas as situações;
- filtrar por marketplace, logística, situação e data;
- pesquisar por pedido Bling, pedido marketplace, cliente, SKU, EAN, NF ou rastreio;
- identificar bloqueios e seus motivos;
- escolher qualquer pedido liberado.

A ordenação padrão será do pedido mais antigo para o mais recente. O sistema não calcula nem exibe prioridade baseada em horário de corte.

### 9.2 Reserva de trabalho

Ao iniciar a conferência:

- o pedido fica reservado para o operador;
- outros operadores veem quem o está conferindo;
- o bloqueio é liberado ao concluir, cancelar ou ultrapassar tempo de inatividade;
- o progresso é preservado se a sessão for interrompida.

### 9.3 Validação anterior à conferência

Antes da bipagem, o EXPEDE verifica:

- situação do pedido;
- regra de NF do cliente, conta e modalidade;
- existência e estado dos documentos necessários;
- etiqueta, quando aplicável;
- cancelamentos e divergências conhecidas;
- completude dos dados essenciais.

Pedido de coleta exige NF válida por padrão. Flex e contas dispensadas seguem configuração homologada do cliente. A configuração deve representar uma decisão explícita do cliente, nunca uma inferência do EXPEDE.

### 9.4 Conferência

- uma leitura por unidade;
- bloqueio de quantidade excedente;
- alerta sonoro e visual para EAN divergente;
- kits tratados exatamente como fornecidos pelo Bling;
- retomada do progresso interrompido;
- conclusão somente após todas as unidades exigidas.

Quando não houver EAN, o operador usará uma ação explícita de confirmação visual pelo nome do produto. A confirmação será registrada como exceção, sem simular uma leitura válida e sem aceitar um código arbitrário.

### 9.5 Conclusão e impressão

Depois da conferência completa:

- o EXPEDE registra a conclusão;
- envia etiqueta e DANFE aplicáveis para impressão;
- grava usuário, horário, itens, resultado e documentos;
- executa apenas atualizações externas necessárias e suportadas;
- remove o pedido da fila de disponíveis.

### 9.6 Reimpressão

O operador poderá reimprimir mediante confirmação e indicação do motivo. A reimpressão:

- não repete a expedição;
- não altera o status do pedido;
- registra usuário, horário, motivo, documento e quantidade acumulada;
- permanece consultável pelo administrador.

### 9.7 Pendências

Toda pendência apresentada ao usuário deve informar:

- o que impediu a ação;
- pedido ou NF envolvidos;
- responsável recomendado;
- ação possível no Bling;
- forma de atualizar o EXPEDE depois da correção.

Quando tecnicamente estável, o sistema poderá oferecer link direto ao registro do Bling. Questões fiscais e cancelamentos serão encaminhados ao responsável do cliente.

## 10. Contingência e reconciliação

O Bling será a contingência oficial quando o EXPEDE estiver indisponível.

Procedimento esperado:

1. registrar início da contingência;
2. processar pedidos diretamente no Bling conforme procedimento do cliente;
3. registrar o fim da contingência;
4. atualizar e reconciliar o EXPEDE;
5. retirar da fila pedidos já processados;
6. sinalizar divergências;
7. bloquear nova expedição ou impressão automática duplicada.

## 11. Arquitetura dos conectores

### 11.1 Tipos

**Conector ERP:** pedidos, itens, quantidades, produtos, SKU, EAN, kits, notas fiscais e situações.

**Conector marketplace/logística:** conta, loja, modalidade, etiqueta, rastreio e situação de envio.

Cada fornecedor converte seus dados para um modelo interno comum. A Central de Expedição não dependerá do formato específico de uma API.

### 11.2 Múltiplas contas

Um ambiente poderá possuir várias lojas do Mercado Livre e Shopee e, quando necessário, mais de uma conexão ERP. Cada pedido manterá vínculo explícito com:

- cliente;
- conector;
- conexão;
- conta ou loja de origem.

Nenhum serviço poderá selecionar simplesmente a primeira conexão ativa.

### 11.3 Sincronização

Combinar:

- webhooks oficiais autenticados;
- atualização periódica incremental;
- atualização manual pelo administrador;
- reconciliação completa programada;
- exibição do horário da última sincronização.

Processamentos serão idempotentes. O mesmo evento não poderá duplicar pedido, impressão, bipagem ou alteração externa.

### 11.4 Escrita mínima

O EXPEDE consulta e valida por padrão. Só modifica Bling ou marketplace quando a operação for necessária, suportada oficialmente e estiver documentada no fluxo homologado. Toda alteração externa será auditada. Falha de escrita nunca será apresentada como sucesso.

### 11.5 Falhas e credenciais

- tentativas automáticas com atraso progressivo;
- fila técnica para falhas persistentes;
- nenhuma liberação com dados incompletos;
- mensagem operacional sem detalhes sensíveis;
- aviso ao administrador e suporte quando houver impacto;
- autorização feita pelo administrador do cliente;
- armazenamento de tokens somente no ambiente do cliente;
- tokens ausentes de telas, URLs, diagnósticos e logs;
- monitoramento de expiração e reautorização;
- webhook autenticado e associado inequivocamente à conexão correta.

## 12. Isolamento e infraestrutura gerenciada

Cada cliente terá:

- aplicação EXPEDE própria;
- projeto e banco Supabase próprios;
- domínio ou subdomínio;
- usuários e políticas de acesso;
- credenciais e segredos próprios;
- backups, monitoramento e auditoria próprios.

Mesmo em banco separado, todo registro operacional terá vínculo explícito com cliente e conexão de origem. Políticas de acesso aplicarão privilégio mínimo e impedirão consultas globais indevidas.

### 12.1 Domínio

O padrão será `cliente.expede.com.br`, administrado pelo EXPEDE. Se o cliente desejar usar domínio próprio, poderá criar apontamento DNS para o ambiente gerenciado.

### 12.2 Publicação

1. desenvolvimento e testes internos;
2. registro da mudança;
3. backup antes de mudança relevante;
4. homologação;
5. validação técnica;
6. comunicação de impacto;
7. publicação controlada;
8. monitoramento posterior;
9. reversão quando necessária.

Mudanças em regras operacionais, permissões, integrações ou efeitos fiscais exigem aprovação escrita do responsável do cliente. Manutenções técnicas sem impacto funcional ficam cobertas pela autorização contratual. Correções emergenciais para preservar segurança ou disponibilidade podem ser aplicadas com comunicação e registro posterior.

## 13. Impressão

- aplicação web em Windows;
- Chrome e Edge atualizados;
- QZ Tray instalado por estação;
- impressora disponível no sistema operacional;
- impressora térmica recomendada;
- configuração por estação;
- lista de modelos homologados.

O EXPEDE buscará compatibilidade ampla com impressoras expostas por Windows/QZ Tray, mas só garantirá suporte aos modelos homologados. Outros equipamentos terão suporte de melhor esforço. A quantidade de estações não será usada para cobrança, mas será levantada no onboarding para dimensionar configuração, treinamento e suporte.

## 14. Segurança, privacidade e retenção

- contas individuais;
- nenhuma senha compartilhada;
- suporte EXPEDE com identidade nominal e auditada;
- MFA obrigatório para administradores da equipe EXPEDE;
- MFA disponível ao cliente conforme sua política;
- segredos fora do código, telas e logs;
- privilégio mínimo;
- revogação imediata de usuário desligado;
- cliente como controlador e EXPEDE como operador de dados, formalizado contratualmente;
- responsável formal do cliente para incidentes;
- acesso administrativo integralmente auditado.

Retenção padrão:

- registros operacionais e auditoria por 12 meses;
- exportação antes do vencimento;
- retenção adicional contratável;
- exclusão conforme política comunicada quando não houver extensão;
- no encerramento: exportação, revogação das integrações, bloqueio dos acessos e exclusão segura no prazo contratual.

## 15. Backup e recuperação

Meta inicial, sujeita à validação técnica antes de virar compromisso contratual:

- backup diário;
- perda máxima de até 24 horas em desastre completo;
- recuperação no mesmo dia útil;
- teste periódico de restauração;
- registro dos resultados;
- uso do Bling como contingência durante a recuperação.

## 16. Implantação e piloto

### 16.1 Pré-requisitos

- responsável interno com poder de decisão;
- Bling ativo e organizado;
- marketplaces contratados;
- usuários do piloto;
- computadores, leitores e impressoras;
- produtos, SKUs e EANs revisados;
- regras de NF e exceções documentadas;
- permissões para autorizar integrações.

### 16.2 Etapas

1. diagnóstico da operação atual;
2. medição da linha de base;
3. assinatura do piloto e escopo;
4. criação do ambiente;
5. cadastro dos administradores;
6. autorização das integrações;
7. importação e validação inicial;
8. configuração das regras;
9. configuração e teste das impressoras;
10. homologação com pedidos controlados;
11. treinamento;
12. operação paralela por uma ou duas semanas;
13. piloto de 30 dias de operação real;
14. relatório e aceite conjunto.

### 16.3 Indicadores

- tempo médio por pedido;
- volume médio, pico diário e pico por hora;
- erros de conferência;
- tentativas de quantidade excedente;
- reimpressões e motivos;
- falhas de integração;
- uso de contingência;
- tempo de treinamento;
- satisfação dos operadores;
- disponibilidade do serviço.

A linha de base será medida no início. As metas definitivas serão acordadas após a primeira semana de dados reais.

### 16.4 Aceite

- fluxo homologado operando com pedidos reais;
- conectores contratados funcionando nos cenários acordados;
- operadores capazes de trabalhar após treinamento;
- mensagens e bloqueios compreensíveis;
- impressão e reimpressão auditadas;
- nenhum defeito crítico aberto;
- relatório aprovado pelo responsável do cliente e pelo responsável EXPEDE.

## 17. Modelo comercial e suporte

### 17.1 Piloto

- taxa de implantação;
- mensalidade reduzida durante o período colaborativo;
- correções e ajustes do escopo homologado incluídos;
- módulos e ampliações orçados separadamente.

### 17.2 Pós-piloto

- implantação para novos clientes;
- mensalidade da plataforma-base;
- valor adicional por conector;
- serviços e módulos fora do padrão cobrados separadamente.

### 17.3 Suporte

- horário comercial;
- canal oficial escrito e rastreável;
- WhatsApp apenas como alerta inicial;
- incidente crítico com resposta inicial em até uma hora comercial;
- demais solicitações até o próximo dia útil;
- manutenções programadas fora do horário principal;
- monitoramento técnico direcionado à equipe EXPEDE;
- comunicação ao cliente quando houver impacto.

Incidentes críticos:

- indisponibilidade geral;
- impossibilidade de expedir;
- risco de duplicidade;
- documento incorreto;
- exposição ou perda de dados.

## 18. Arquitetura documental

### 18.1 Fontes

- Obsidian para conhecimento interno, operação e decisões;
- repositório para arquitetura técnica, contratos dos conectores, APIs, migrações e notas de versão;
- PDF e Word para entregáveis;
- PowerPoint para apresentação comercial e resultados do piloto;
- imagens somente de ambiente de demonstração ou com dados anonimizados.

### 18.2 Entregáveis

- visão e posicionamento;
- “Por que utilizar o EXPEDE?”;
- perfil de cliente ideal;
- apresentação comercial;
- proposta e termo do piloto;
- manual do operador;
- guia rápido de uma página;
- manual do administrador;
- catálogo completo de telas;
- checklist de implantação e homologação;
- guias operacionais e técnicos dos conectores;
- matriz de responsabilidades e permissões;
- catálogo de erros e ações;
- procedimento de contingência e incidentes;
- políticas de backup, retenção e acesso;
- SLA e canais de suporte;
- processo de mudança;
- notas de versão;
- relatório do piloto.

### 18.3 Modelo de documentação de tela

Cada tela conterá objetivo, público, pré-requisitos, acesso, captura numerada, campos, filtros, botões, indicadores, fluxo principal, alternativas, erros, regras, bloqueios, origem dos dados, resultado esperado, links relacionados e versão documentada.

Inventário inicial:

- login;
- dashboard;
- Central de Expedição;
- conferência/bipagem;
- pendências;
- histórico e reimpressão;
- pedidos;
- produtos;
- usuários;
- Bling;
- Mercado Livre;
- Shopee;
- notas fiscais;
- impressoras.

### 18.4 Modelo de documentação de conector

Finalidade, pré-requisitos, permissões, OAuth, contas, dados consultados, dados modificados, mapeamento interno, webhooks, sincronização, renovação, limites, retentativas, idempotência, erros de usuário, monitoramento, revogação, homologação e compatibilidade por versão.

Todo documento indicará versão do EXPEDE, data, responsável, público e estado. Uma mudança de tela ou processo não poderá ser considerada pronta sem atualização documental correspondente.

## 19. Estratégia de testes

Antes do piloto:

- testes unitários de elegibilidade, NF, quantidades e kits;
- testes dos adaptadores Bling, Mercado Livre e Shopee;
- testes de webhooks e idempotência;
- testes de múltiplas contas;
- testes de permissões;
- testes de concorrência entre operadores;
- testes de interrupção e retomada;
- testes de impressão e reimpressão;
- testes de reconciliação;
- testes de falha e renovação de credenciais;
- testes ponta a ponta;
- validação com impressoras reais;
- teste de backup e restauração;
- verificação de segurança.

## 20. Lacunas para comercialização

### 20.1 P0 — bloqueiam cliente externo

- políticas de dados excessivamente abertas;
- seleção global ou da primeira conexão ativa;
- webhooks sem autenticação e resolução segura;
- diagnóstico com risco de exposição de dados sensíveis;
- administração de usuários sem isolamento completo;
- aceite arbitrário para produto sem EAN;
- reserva concorrente incompleta;
- reconciliação insuficiente após contingência;
- ausência de suíte automatizada suficiente;
- publicação manual e pouco reproduzível;
- backup externo/restauração não comprovados;
- erros de tipagem e dívidas críticas conhecidas.

### 20.2 P1 — necessários ao produto vendável

- Central de Expedição unificada;
- filtros, busca e última sincronização;
- mensagens e pendências compreensíveis;
- vínculo entre pedido, conta e loja;
- monitoramento de credenciais e falhas;
- auditoria completa;
- motivos de reimpressão;
- administrador do cliente;
- configuração por ambiente;
- domínio e identidade;
- homologação de impressoras;
- monitoramento e alertas;
- MFA administrativo;
- documentação e ambiente de demonstração;
- processos de versão, mudança e suporte.

### 20.3 P2 — evolução

- Tiny;
- múltiplos volumes;
- devoluções;
- celular;
- white-label;
- cobrança automatizada;
- SaaS compartilhado;
- novos conectores;
- indicadores avançados.

## 21. Roadmap

### Fase 0 — consolidar a base

Confirmar repositório, branch e produção oficiais; inventariar telas; interromper alterações paralelas sem rastreabilidade; criar baseline técnico e funcional.

### Fase 1 — segurança e confiabilidade

Corrigir isolamento, credenciais, webhooks e conexões; implementar testes fundamentais; tornar build e publicação reproduzíveis; validar backup e restauração.

### Fase 2 — experiência vendável

Consolidar a Central de Expedição; implementar reserva, reconciliação e confirmação sem EAN; completar auditoria, filtros, mensagens e estados; homologar impressão.

### Fase 3 — documentação e serviço

Produzir manuais, guias, onboarding, suporte, incidentes, mudanças, apresentação, proposta, termo do piloto e ambiente de demonstração.

### Fase 4 — homologação interna

Executar cenários, treinar pessoa que não desenvolveu o sistema, corrigir falhas e aprovar checklist de prontidão.

### Fase 5 — piloto Bling

Implantar ambiente, operar em paralelo por uma ou duas semanas, executar 30 dias reais, medir indicadores e corrigir apenas o escopo homologado.

### Fase 6 — aceite e comercialização

Apresentar relatório, obter aceite, converter para mensalidade, solicitar autorização para caso de sucesso e abrir novas implantações pelo processo validado.

## 22. Critério de prontidão comercial

O EXPEDE estará apto ao primeiro cliente externo quando:

1. todos os P0 estiverem encerrados e verificados;
2. os P1 exigidos pelo piloto estiverem homologados;
3. build, testes, segurança, backup e restauração tiverem evidência;
4. ambiente separado puder ser provisionado de forma repetível;
5. manual do operador, manual do administrador, contingência e suporte estiverem publicados;
6. integrações do piloto tiverem roteiro de autorização e revogação;
7. termos de piloto, responsabilidades e aceite estiverem definidos;
8. uma homologação interna completa tiver sido aprovada.

## 23. Decisões consolidadas

- serviço gerenciado com infraestrutura separada;
- um código-base, sem forks de cliente;
- plataforma-base e conectores opcionais;
- Bling prioritário;
- Mercado Livre e Shopee homologados primeiro;
- Tiny somente com piloto pago;
- operador e administrador como perfis técnicos iniciais;
- administrador do cliente e suporte EXPEDE com contas próprias;
- cliente decide prioridade e horários;
- pedidos mais antigos aparecem primeiro;
- operador consulta todas as situações;
- reimpressão permitida e auditada;
- Bling como fonte oficial e contingência;
- retenção incluída por 12 meses;
- piloto pago, paralelo por uma ou duas semanas e operação real por 30 dias;
- horário comercial e resposta crítica inicial em até uma hora comercial;
- documentação versionada e obrigatória por mudança.

