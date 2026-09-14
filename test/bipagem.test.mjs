import assert from "node:assert/strict";
import test from "node:test";

import { normalizarGtin, validarBipagem } from "../src/lib/bipagem.ts";

// Helper: monta um item de pedido no formato que a tela de expedicao entrega.
function item(over = {}) {
  return {
    id: "item-1",
    sku: "SKU-1",
    ean: null,
    produto_gtin: null,
    descricao: "Produto teste",
    quantidade: 1,
    quantidade_bipada: 0,
    ...over,
  };
}

// ─── normalizarGtin ──────────────────────────────────────────────────────────

test("normalizarGtin canoniza para GTIN-14 preenchendo com zeros a esquerda", () => {
  // UPC-A (12) e EAN-13 do mesmo produto sao o mesmo GTIN
  assert.equal(normalizarGtin("012345678905"), normalizarGtin("0012345678905"));
  assert.equal(normalizarGtin("7909501059766"), "00007909501059766".slice(-14));
});

test("normalizarGtin remove espacos e hifens deixados pelo leitor", () => {
  assert.equal(normalizarGtin(" 7909501059766 "), normalizarGtin("7909-501-059766"));
});

test("normalizarGtin devolve null para codigo vazio ou so espacos", () => {
  assert.equal(normalizarGtin(""), null);
  assert.equal(normalizarGtin("   "), null);
  assert.equal(normalizarGtin(null), null);
});

test("normalizarGtin nao confunde codigos diferentes", () => {
  assert.notEqual(normalizarGtin("7909501059766"), normalizarGtin("7909501059767"));
  assert.notEqual(normalizarGtin("21673"), normalizarGtin("7909501059766"));
});

// ─── O bug relatado: item sem EAN cadastrado ────────────────────────────────

test("REGRESSAO: item sem EAN cadastrado NUNCA retorna sucesso", () => {
  const itens = [item({ ean: null, produto_gtin: null })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "qualquer-coisa-123" });

  assert.notEqual(r.status, "sucesso");
  assert.equal(r.status, "ean_nao_cadastrado");
  assert.match(r.mensagem, /N.O CADASTRADO/i);
});

test("REGRESSAO: item sem EAN bloqueia ate o codigo que 'parece' certo", () => {
  const itens = [item({ ean: null, produto_gtin: null, sku: "21673" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "21673" });

  assert.equal(r.status, "ean_nao_cadastrado");
});

test("ean string vazia conta como nao cadastrado", () => {
  const itens = [item({ ean: "", produto_gtin: "" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "7909501059766" });

  assert.equal(r.status, "ean_nao_cadastrado");
});

// ─── Validacao normal ────────────────────────────────────────────────────────

test("EAN bipado igual ao cadastrado retorna sucesso", () => {
  const itens = [item({ ean: "7909501059766" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "7909501059766" });

  assert.equal(r.status, "sucesso");
  assert.equal(r.item.id, "item-1");
});

test("EAN bipado diferente do cadastrado retorna divergencia, nao sucesso", () => {
  const itens = [item({ ean: "7909501059766" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "7909501059767" });

  assert.equal(r.status, "ean_divergente");
  assert.equal(r.esperado, "7909501059766");
});

test("caso real 03/09: bipar o SKU num item que tem EAN e recusado", () => {
  const itens = [item({ ean: "7909501059766", sku: "21673" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "21673" });

  assert.equal(r.status, "ean_divergente");
});

test("cai para produtos.gtin quando pedido_itens.ean esta vazio", () => {
  const itens = [item({ ean: null, produto_gtin: "7909501059766" })];

  assert.equal(
    validarBipagem({ itens, itemAtivoId: "item-1", codigo: "7909501059766" }).status,
    "sucesso",
  );
  assert.equal(
    validarBipagem({ itens, itemAtivoId: "item-1", codigo: "7909501059767" }).status,
    "ean_divergente",
  );
});

test("UPC-A de 12 digitos casa com o EAN-13 equivalente", () => {
  const itens = [item({ ean: "0012345678905" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "012345678905" });

  assert.equal(r.status, "sucesso");
});

// ─── Multi-item ──────────────────────────────────────────────────────────────

test("bipar o EAN de outro item pendente casa com aquele item", () => {
  const itens = [
    item({ id: "a", ean: "1111111111111" }),
    item({ id: "b", ean: "2222222222222" }),
  ];
  const r = validarBipagem({ itens, itemAtivoId: "a", codigo: "2222222222222" });

  assert.equal(r.status, "sucesso");
  assert.equal(r.item.id, "b");
});

test("codigo de item ja completo avisa que ja foi bipado, sem incrementar", () => {
  const itens = [
    item({ id: "a", ean: "1111111111111", quantidade: 1, quantidade_bipada: 1 }),
    item({ id: "b", ean: "2222222222222" }),
  ];
  const r = validarBipagem({ itens, itemAtivoId: "b", codigo: "1111111111111" });

  assert.equal(r.status, "ja_bipado");
});

test("pedido com todos os itens bipados nao aceita mais nada", () => {
  const itens = [item({ ean: "1111111111111", quantidade: 2, quantidade_bipada: 2 })];
  const r = validarBipagem({ itens, itemAtivoId: null, codigo: "1111111111111" });

  assert.equal(r.status, "pedido_completo");
});

test("codigo vazio nao dispara validacao", () => {
  const itens = [item({ ean: "1111111111111" })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "   " });

  assert.equal(r.status, "codigo_vazio");
});

test("item com quantidade 3 aceita o mesmo EAN ate completar", () => {
  const itens = [item({ ean: "1111111111111", quantidade: 3, quantidade_bipada: 2 })];
  const r = validarBipagem({ itens, itemAtivoId: "item-1", codigo: "1111111111111" });

  assert.equal(r.status, "sucesso");
});

// ─── Liberacao supervisionada ───────────────────────────────────────────────

test("podeLiberarSemEan so e verdadeiro quando o item realmente nao tem EAN", () => {
  const semEan = validarBipagem({
    itens: [item({ ean: null, produto_gtin: null })],
    itemAtivoId: "item-1",
    codigo: "123",
  });
  const comEan = validarBipagem({
    itens: [item({ ean: "7909501059766" })],
    itemAtivoId: "item-1",
    codigo: "123",
  });

  assert.equal(semEan.podeLiberarSemEan, true);
  assert.equal(comEan.podeLiberarSemEan ?? false, false);
});
