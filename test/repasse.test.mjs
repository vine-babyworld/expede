import assert from "node:assert/strict";
import test from "node:test";

import { normalizarRepasseMl, normalizarRepasseShopee, montarCandidatosRepasse } from "../src/lib/repasse.ts";

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

test("normalizarRepasseMl devolve uma linha unica e sem liquido informado", () => {
  const r = normalizarRepasseMl({
    order_items: [{ unit_price: 31.2, quantity: 1, sale_fee: 5.15 }],
    custo_envio: 6.95,
    shipment_status: "shipped",
  });

  assert.deepEqual(r.linhas, [{ chave: "sale_fee", rotulo: "Tarifa de venda", valor: 5.15 }]);
  assert.equal(r.liquido_informado, null);
  assert.equal(r.envio_coberto_pelo_marketplace, false);
  assert.equal(r.divergencia, null);
  assert.equal(r.valor_liquido, 19.1);
});

// Pedido 9080 / 260831SN9WNUGC - caso comum: frete coberto, sem comissao AMS.
test("normalizarRepasseShopee reconcilia o pedido 9080", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 393,
      commission_fee: 46.92,
      service_fee: 33.82,
      ads_escrow_top_up_fee_or_technical_support_fee: 7.82,
      voucher_from_seller: 1.97,
      shipping_seller_protection_fee_amount: 0.49,
      actual_shipping_fee: 112.59,
      buyer_paid_shipping_fee: 72.59,
      shopee_shipping_rebate: 40,
      escrow_amount: 301.98,
      escrow_amount_after_adjustment: 301.98,
      total_adjustment_amount: 0,
    },
    order_status: "SHIPPED",
  });

  assert.equal(r.marketplace, "shopee");
  assert.equal(r.valor_bruto, 393);
  assert.equal(r.tarifa_venda, 91.02);
  assert.equal(r.tarifa_percentual, 23.16);
  assert.equal(r.custo_envio, 0);
  assert.equal(r.valor_liquido, 301.98);
  assert.equal(r.liquido_informado, 301.98);
  assert.equal(r.divergencia, 0);
  assert.equal(r.envio_coberto_pelo_marketplace, true);
  assert.equal(r.final, false);
  assert.equal(r.linhas.length, 5);
});

// Pedido 8912 / 260818MK0GET5H - um dos 5 (de 42) com order_ams_commission_fee.
// Foi este campo que produziu divergencia na primeira medicao; sem ele a conta
// erra por R$ 10,08.
test("normalizarRepasseShopee soma order_ams_commission_fee (pedido 8912)", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 214,
      commission_fee: 25.44,
      service_fee: 31.65,
      ads_escrow_top_up_fee_or_technical_support_fee: 4.24,
      order_ams_commission_fee: 10.08,
      voucher_from_seller: 1.97,
      shipping_seller_protection_fee_amount: 0.49,
      actual_shipping_fee: 33.59,
      shopee_shipping_rebate: 33.59,
      escrow_amount: 140.13,
      total_adjustment_amount: 0,
    },
    order_status: "COMPLETED",
  });

  assert.equal(r.tarifa_venda, 73.87);
  assert.equal(r.valor_liquido, 140.13);
  assert.equal(r.divergencia, 0);
  assert.equal(r.final, true);
  assert.equal(r.linhas.length, 6);
  assert.deepEqual(
    r.linhas.find((l) => l.chave === "order_ams_commission_fee"),
    { chave: "order_ams_commission_fee", rotulo: "Comissão de anúncios (AMS)", valor: 10.08 },
  );
});

// Pedido 9077 / 260831SEM7SFGG - um dos 2 (de 42) com frete real pro vendedor.
test("normalizarRepasseShopee cobra o frete quando o rebate nao cobre (pedido 9077)", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 316.72,
      commission_fee: 37.77,
      service_fee: 32.3,
      ads_escrow_top_up_fee_or_technical_support_fee: 6.3,
      voucher_from_seller: 1.97,
      shipping_seller_protection_fee_amount: 0.49,
      actual_shipping_fee: 43.31,
      shopee_shipping_rebate: 37.23,
      escrow_amount: 231.81,
      total_adjustment_amount: 0,
    },
    order_status: "TO_CONFIRM_RECEIVE",
  });

  assert.equal(r.tarifa_venda, 78.83);
  assert.equal(r.custo_envio, 6.08);
  assert.equal(r.valor_liquido, 231.81);
  assert.equal(r.divergencia, 0);
  assert.equal(r.envio_coberto_pelo_marketplace, false);
  assert.equal(r.final, false);
});

test("normalizarRepasseShopee omite linhas de valor zero", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 100,
      commission_fee: 10,
      service_fee: 0,
      voucher_from_seller: 0,
      escrow_amount: 90,
    },
    order_status: "SHIPPED",
  });

  assert.deepEqual(r.linhas, [{ chave: "commission_fee", rotulo: "Comissão", valor: 10 }]);
});

test("normalizarRepasseShopee acusa divergencia quando falta uma taxa na soma", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 100,
      commission_fee: 10,
      escrow_amount: 85,
    },
    order_status: "COMPLETED",
  });

  assert.equal(r.valor_liquido, 85);
  assert.equal(r.divergencia, 5);
});

test("normalizarRepasseShopee usa o valor ajustado quando houve ajuste", () => {
  const r = normalizarRepasseShopee({
    order_income: {
      order_selling_price: 100,
      commission_fee: 10,
      escrow_amount: 90,
      escrow_amount_after_adjustment: 80,
      total_adjustment_amount: -10,
    },
    order_status: "COMPLETED",
  });

  assert.equal(r.liquido_informado, 80);
  assert.equal(r.valor_liquido, 80);
});

test("normalizarRepasseShopee devolve percentual nulo quando o bruto e zero", () => {
  const r = normalizarRepasseShopee({ order_income: {}, order_status: null });

  assert.equal(r.valor_bruto, 0);
  assert.equal(r.tarifa_percentual, null);
  assert.equal(r.linhas.length, 0);
  assert.equal(r.final, false);
});
