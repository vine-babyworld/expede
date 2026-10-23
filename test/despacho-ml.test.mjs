import assert from "node:assert/strict";
import test from "node:test";

import {
  categoriaDespacho,
  dataReferenciaDespacho,
  diaBrasilia,
  etiquetaMlAguardandoLiberacao,
} from "../src/lib/despacho-ml.ts";

const HOJE = "2026-10-26";

test("etiquetaMlAguardandoLiberacao só esconde o envio ML em buffering", () => {
  // Pedidos reais de 23/10/2026: "Para entregar na coleta do dia 26/27 de outubro"
  assert.equal(etiquetaMlAguardandoLiberacao({ ml_shipment_substatus: "buffered" }), true);
  assert.equal(etiquetaMlAguardandoLiberacao({ ml_shipment_substatus: "ready_to_print" }), false);
  assert.equal(etiquetaMlAguardandoLiberacao({ ml_shipment_substatus: null }), false);
  assert.equal(etiquetaMlAguardandoLiberacao({}), false);
});

test("diaBrasilia converte timestamp UTC para o dia em Brasília (UTC-3)", () => {
  assert.equal(diaBrasilia("2026-10-26T02:59:00.000Z"), "2026-10-25");
  assert.equal(diaBrasilia("2026-10-26T03:00:00.000Z"), "2026-10-26");
  assert.equal(diaBrasilia("2026-10-26 10:15:35.151+00"), "2026-10-26");
  assert.equal(diaBrasilia(null), null);
  assert.equal(diaBrasilia("lixo"), null);
});

test("data prevista 0000-00-00 do Bling não vira data de referência", () => {
  assert.equal(dataReferenciaDespacho({ raw_json: { dataPrevista: "0000-00-00" } }), null);
  assert.equal(categoriaDespacho({ raw_json: { dataPrevista: "0000-00-00" } }, HOJE), null);
});

test("sem liberação registrada, vale a data prevista do Bling", () => {
  assert.equal(categoriaDespacho({ raw_json: { dataPrevista: "2026-10-26" } }, HOJE), "hoje");
  assert.equal(categoriaDespacho({ raw_json: { dataPrevista: "2026-10-27" } }, HOJE), "proximos");
  assert.equal(categoriaDespacho({ raw_json: { dataPrevista: "2026-10-23" } }, HOJE), "atrasado");
  assert.equal(categoriaDespacho({ raw_json: null }, HOJE), null);
});

test("etiqueta liberada hoje conta como hoje, mesmo com prevista vazia ou antiga", () => {
  const liberadaHoje = "2026-10-26T03:10:00.000Z"; // 00:10 em Brasília
  assert.equal(
    categoriaDespacho({ raw_json: { dataPrevista: "0000-00-00" }, ml_etiqueta_liberada_em: liberadaHoje }, HOJE),
    "hoje",
  );
  assert.equal(
    categoriaDespacho({ raw_json: { dataPrevista: "2026-10-23" }, ml_etiqueta_liberada_em: liberadaHoje }, HOJE),
    "hoje",
  );
});

test("pedido liberado num dia e não impresso fica atrasado no dia seguinte", () => {
  assert.equal(
    categoriaDespacho(
      { raw_json: { dataPrevista: "0000-00-00" }, ml_etiqueta_liberada_em: "2026-10-25T03:10:00.000Z" },
      HOJE,
    ),
    "atrasado",
  );
});

test("prevista posterior à liberação continua mandando", () => {
  assert.equal(
    dataReferenciaDespacho({
      raw_json: { dataPrevista: "2026-10-28" },
      ml_etiqueta_liberada_em: "2026-10-26T03:10:00.000Z",
    }),
    "2026-10-28",
  );
});
