import assert from "node:assert/strict";
import test from "node:test";

import { normalizarRepasseMl, montarCandidatosRepasse } from "../src/lib/repasse.ts";

test("normalizarRepasseMl reconcilia com o painel do ML", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 31.2, quantity: 1, sale_fee: 5.15 }],
    custo_envio: 6.95,
    shipment_status: "shipped",
  });

  assert.equal(r.marketplace, "mercado_livre");
  assert.equal(r.valor_bruto, 31.2);
  assert.equal(r.tarifa_venda, 5.15);
  assert.equal(r.custo_envio, 6.95);
  assert.equal(r.valor_liquido, 19.1);
  assert.equal(r.tarifa_percentual, 16.51);
  assert.equal(r.final, false);
});

test("normalizarRepasseMl soma itens do pack e conta o frete uma vez", () => {
  const r = normalizarRepasseMl({
    order_items: [
      { unit_price: 50, quantity: 1, sale_fee: 8 },
      { unit_price: 25, quantity: 2, sale_fee: 4 },
    ],
    custo_envio: 6.95,
    shipment_status: "delivered",
  });

  assert.equal(r.valor_bruto, 100);
  assert.equal(r.tarifa_venda, 16);
  assert.equal(r.custo_envio, 6.95);
  assert.equal(r.valor_liquido, 77.05);
  assert.equal(r.final, true);
});

test("normalizarRepasseMl devolve percentual nulo quando o bruto e zero", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 0, quantity: 1, sale_fee: 0 }],
    custo_envio: 0,
    shipment_status: null,
  });

  assert.equal(r.tarifa_percentual, null);
  assert.equal(r.valor_liquido, 0);
});

test("normalizarRepasseMl arredonda a 2 casas", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 10.005, quantity: 3, sale_fee: 1.666 }],
    custo_envio: 0.014,
    shipment_status: null,
  });

  assert.equal(r.valor_bruto, 30.02);
  assert.equal(r.tarifa_venda, 5);
  assert.equal(r.custo_envio, 0.01);
  assert.equal(r.valor_liquido, 25.01);
});

test("normalizarRepasseMl trata lista de itens vazia sem quebrar", () => {
  const r = normalizarRepasseMl({ order_items: [], custo_envio: 0, shipment_status: null });

  assert.equal(r.valor_bruto, 0);
  assert.equal(r.tarifa_venda, 0);
  assert.equal(r.tarifa_percentual, null);
  assert.equal(r.valor_liquido, 0);
});

test("montarCandidatosRepasse prioriza nunca verificados e respeita o orcamento", () => {
  const nunca = [{ id: "a" }, { id: "b" }];
  const retry = [{ id: "c" }, { id: "d" }, { id: "e" }];

  assert.deepEqual(montarCandidatosRepasse(nunca, retry, 4), [
    { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" },
  ]);
  assert.deepEqual(montarCandidatosRepasse(nunca, retry, 1), [{ id: "a" }]);
  assert.deepEqual(montarCandidatosRepasse([], retry, 2), [{ id: "c" }, { id: "d" }]);
  assert.deepEqual(montarCandidatosRepasse([], [], 4), []);
});
