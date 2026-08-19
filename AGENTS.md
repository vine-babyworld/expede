# AGENTS.md — EXPEDE

Sistema de gestão de expedição (Baby World). Este arquivo é uma **ponte curta** para o Codex — a documentação real do projeto vive no Obsidian, fora deste repositório. Não duplique conteúdo aqui; edite lá. Equivalente ao `CLAUDE.md` deste mesmo repositório (Claude Code) — mesmo conteúdo, mesma fonte.

## DOCUMENTATION ROOT

```
C:\Users\Vinicius\Documents\Obsidian Vault\Vinicius Morandi Alexandre\Baby World\Babyworld-Dev\EXPEDE\
```

## Antes de qualquer trabalho estrutural nesta sessão, leia nesta ordem

1. `AGENT-CONTEXT/INDEX.md`
2. `AGENT-CONTEXT/CURRENT-STATE.md`
3. `AGENT-CONTEXT/SESSION-HANDOFF.md`
4. `AGENT-CONTEXT/DOCUMENTATION-RULES.md` — regras completas de leitura/escrita, arquivos sensíveis e protocolo de encerramento de sessão. Este arquivo não repete essas regras, só aponta pra elas.

## Segurança

Nunca ler nem escrever automaticamente: `02 - Credenciais.md`, `Conexão Supabase.md`, `Nota de Segurança.md`, `VERCEL.md`, `.env`, nem qualquer conteúdo com credencial/secret/token/senha/chave. Lista completa de padrões bloqueados em `DOCUMENTATION-RULES.md`.

## Ao encerrar uma sessão significativa

Atualizar `AGENT-CONTEXT/SESSION-HANDOFF.md` (obrigatório). Critério de "significativa" e demais arquivos a atualizar conforme o caso (`CURRENT-STATE.md`, `KNOWN-ISSUES.md`, `PENDING-DECISIONS.md`, `01 - Decisões de Arquitetura.md`, `05 - Erros e Soluções.md`) — ver `DOCUMENTATION-RULES.md`.

---

> Criado em 07/08/2026 como parte da adoção do protocolo `AGENT-CONTEXT`, junto com a correção do `CLAUDE.md` (que estava corrompido). Mesma fonte, mesmo protocolo — o objetivo é que trabalho iniciado no Claude Code possa ser continuado pelo Codex, e vice-versa, sem depender do histórico de conversa de nenhum dos dois.
