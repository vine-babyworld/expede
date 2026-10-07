import assert from "node:assert/strict";
import test from "node:test";

import { descreverErroEtiqueta } from "../src/lib/etiqueta-erros.ts";

test("descreverErroEtiqueta traduz os códigos conhecidos do Magalu", () => {
  assert.equal(
    descreverErroEtiqueta("magalu_etiqueta_ja_despachada"),
    "Magalu: a entrega já consta como despachada — a etiqueta não pode mais ser gerada pela API",
  );
  assert.equal(descreverErroEtiqueta("magalu_sem_entrega"), "Magalu: pedido sem entrega para gerar etiqueta");
  assert.equal(descreverErroEtiqueta("magalu_sem_numero_loja"), "Pedido sem número do Magalu");
});

test("descreverErroEtiqueta trata magalu_token_error pelo prefixo", () => {
  const esperado = "Magalu desconectado — reconecte em Configurações > Marketplaces";
  assert.equal(descreverErroEtiqueta("magalu_token_error"), esperado);
  assert.equal(descreverErroEtiqueta("magalu_token_error: refresh falhou (401)"), esperado);
});

test("descreverErroEtiqueta mostra o código nos demais erros do Magalu", () => {
  assert.equal(descreverErroEtiqueta("magalu_api_error:500"), "Magalu recusou a etiqueta (magalu_api_error:500)");
});

test("descreverErroEtiqueta devolve o código cru para qualquer outro erro", () => {
  assert.equal(descreverErroEtiqueta("bling_api_error:404"), "bling_api_error:404");
  assert.equal(descreverErroEtiqueta("no_etiqueta_data"), "no_etiqueta_data");
  assert.equal(descreverErroEtiqueta("  sem_fallback:shopee  "), "sem_fallback:shopee");
});

test("descreverErroEtiqueta não devolve texto vazio", () => {
  assert.equal(descreverErroEtiqueta(""), "Motivo não informado");
  assert.equal(descreverErroEtiqueta("   "), "Motivo não informado");
  assert.equal(descreverErroEtiqueta(undefined), "Motivo não informado");
});

test("descreverErroEtiqueta explica entrega congelada e cancelada no Magalu", () => {
  assert.match(descreverErroEtiqueta("magalu_entrega_congelada"), /congelada/);
  assert.match(descreverErroEtiqueta("magalu_entregas_canceladas"), /cancelada/);
});
