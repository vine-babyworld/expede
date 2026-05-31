# EXPEDE — Rotas de API públicas

## POST /api/public/hooks/bling-pedidos

Webhook de atualização de pedidos de venda do Bling.

### Configuração no painel Bling

1. Acesse **Bling → Configurações → Webhooks**
2. Clique em **Novo webhook**
3. Preencha:
   - **URL:** `https://expede.lovable.app/api/public/hooks/bling-pedidos`
   - **Evento:** Atualização de Pedidos de Vendas
   - **Método:** POST
4. Salve e ative

### Payload recebido (enviado pelo Bling)

```json
{ "data": { "id": 123456789 } }
```

O ID é o `bling_pedido_id`. O endpoint faz `GET /Api/v3/pedidos/vendas/{id}` para buscar o pedido completo.

### Filtros aplicados

| Condição | Ação |
|----------|------|
| Pedido sem `notaFiscal.id` | Ignorado — retorna `{ "skipped": "no_invoice" }` |
| Qualquer item com `deposito.descricao ≠ "Geral"` | Ignorado — retorna `{ "skipped": "wrong_warehouse" }` |
| Pedido com `situacao.valor = 12` (cancelado) já gravado | Atualiza `situacao_valor` mas mantém o registro |
| Pedido duplicado (mesmo `bling_connection_id + bling_pedido_id`) | UPSERT — atualiza sem criar duplicata |

### Resposta de sucesso

```json
{ "ok": true, "pedido_id": "<uuid>", "items_count": 3 }
```

### Teste manual via curl

```bash
# Simula payload do Bling com pedido ID 123456789
curl -X POST https://expede.lovable.app/api/public/hooks/bling-pedidos \
  -H "Content-Type: application/json" \
  -d '{"data": {"id": 123456789}}'
```

Para testar localmente (se o servidor estiver rodando em localhost:3000):

```bash
curl -X POST http://localhost:3000/api/public/hooks/bling-pedidos \
  -H "Content-Type: application/json" \
  -d '{"data": {"id": 123456789}}'
```

**Casos de teste esperados:**

```bash
# Pedido sem NF → deve retornar skipped: no_invoice
# Pedido com item fora do depósito → deve retornar skipped: wrong_warehouse
# Pedido válido → deve retornar ok: true
# Mesmo pedido duas vezes → segundo retorno ok: true, sem duplicata no banco
```

### Observações

- Sem autenticação — o Bling não suporta envio de token de webhook nesta versão
- Processamento síncrono: o endpoint responde após processar (não usa `waitUntil`)
- Erros de API/banco retornam HTTP 200 intencionalmente para não forçar reentrega enquanto em fase de testes
  (`TODO`: retornar 500 em produção estável)
