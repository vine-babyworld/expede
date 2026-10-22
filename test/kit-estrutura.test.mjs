import assert from "node:assert/strict";
import test from "node:test";

import { componentesDaEstrutura, explodirItensPorEstrutura } from "../src/lib/kit-estrutura.ts";
import { validarBipagem } from "../src/lib/bipagem.ts";

// Cadastro real (produtos.raw_data em 22/10/2026): o kit e a unidade têm o MESMO GTIN.
const UNIDADE = {
  id: "prod-bb1269",
  bling_product_id: 16707455266,
  sku: "BB1269",
  gtin: "7908842863995",
  nome: "Sacos Armazenar Leite Materno Mom's Essentials Fisher Price",
  raw_data: { formato: "S", estrutura: { componentes: [] } },
};
const KIT3 = {
  id: "prod-bb1269-kit3",
  bling_product_id: 16707616388,
  sku: "BB1269-KIT3",
  gtin: "7908842863995",
  nome: "KIT 75 Sacos Armazenar Leite Materno Mom's Essentials Fisher Price",
  raw_data: {
    formato: "E",
    estrutura: { componentes: [{ produto: { id: 16707455266 }, quantidade: 3 }], tipoEstoque: "V" },
  },
};
const COLETOR = {
  id: "prod-bb1011",
  bling_product_id: 16111339713,
  sku: "BB1011",
  gtin: "7899999000011",
  nome: "Coletor de Leite",
  raw_data: { formato: "S" },
};
const KIT_COLETOR_2SACOS = {
  id: "prod-kit-bb1011-2bb1269",
  bling_product_id: 16707483177,
  sku: "KIT-BB1011+2BB1269",
  gtin: "7908842863995",
  nome: "Kit Coletor De Leite +2 Saco",
  raw_data: {
    formato: "E",
    estrutura: {
      componentes: [
        { produto: { id: 16111339713 }, quantidade: 1 },
        { produto: { id: 16707455266 }, quantidade: 2 },
      ],
    },
  },
};

function cadastro(...produtos) {
  return new Map(produtos.map((p) => [p.bling_product_id, p]));
}

// Item exatamente como vem em pedidos.raw_json.itens do pedido 2000019102234438.
function itemBling(over = {}) {
  return {
    id: 20095701430,
    codigo: "BB1269-KIT3",
    produto: { id: 16707616388 },
    descricao: "KIT 75 Sacos Armazenar Leite Materno Mom's Essentials Fisher Price",
    quantidade: 1,
    valor: 67.84,
    ...over,
  };
}

test("componentesDaEstrutura: produto simples não é kit", () => {
  assert.equal(componentesDaEstrutura(UNIDADE.raw_data), null);
  assert.equal(componentesDaEstrutura(null), null);
  assert.equal(componentesDaEstrutura({ formato: "E" }), null, "kit sem estrutura detalhada não dá para explodir");
});

test("componentesDaEstrutura: lê componentes do kit formato E", () => {
  assert.deepEqual(componentesDaEstrutura(KIT3.raw_data), [{ blingProductId: 16707455266, quantidade: 3 }]);
});

test("pedido 2000019102234438: BB1269-KIT3 x1 vira BB1269 x3", () => {
  const r = explodirItensPorEstrutura([itemBling()], cadastro(KIT3, UNIDADE));
  assert.equal(r.linhas.length, 1);
  const [linha] = r.linhas;
  assert.equal(linha.sku, "BB1269");
  assert.equal(linha.ean, "7908842863995");
  assert.equal(linha.produtoId, "prod-bb1269");
  assert.equal(linha.quantidade, 3);
  assert.equal(linha.blingItemId, 20095701430);
  assert.equal(linha.valorUnitario, null, "valor do kit não se divide por componente");
  assert.deepEqual(r.kitsExplodidos, ["BB1269-KIT3"]);
  assert.deepEqual(r.kitsSemComponente, []);
});

test("quantidade do item multiplica a do componente", () => {
  const r = explodirItensPorEstrutura([itemBling({ quantidade: 2 })], cadastro(KIT3, UNIDADE));
  assert.equal(r.linhas[0].quantidade, 6);
});

test("kit com componentes diferentes gera uma linha por componente", () => {
  const r = explodirItensPorEstrutura(
    [itemBling({ codigo: "KIT-BB1011+2BB1269", produto: { id: 16707483177 } })],
    cadastro(KIT_COLETOR_2SACOS, UNIDADE, COLETOR),
  );
  const porSku = Object.fromEntries(r.linhas.map((l) => [l.sku, l.quantidade]));
  assert.deepEqual(porSku, { BB1011: 1, BB1269: 2 });
});

test("mesmo componente vindo de item avulso e de kit soma numa linha só (unique pedido_id,sku)", () => {
  const r = explodirItensPorEstrutura(
    [itemBling(), { id: 1, codigo: "BB1269", produto: { id: 16707455266 }, descricao: "Saco", quantidade: 1, valor: 20 }],
    cadastro(KIT3, UNIDADE),
  );
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].sku, "BB1269");
  assert.equal(r.linhas[0].quantidade, 4);
});

test("item que não é kit passa direto (sku/descrição/valor do Bling)", () => {
  const r = explodirItensPorEstrutura(
    [{ id: 7, codigo: "BB1269", produto: { id: 16707455266 }, descricao: "Saco", quantidade: 2, valor: 20 }],
    cadastro(UNIDADE),
  );
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].sku, "BB1269");
  assert.equal(r.linhas[0].quantidade, 2);
  assert.equal(r.linhas[0].valorUnitario, 20);
  assert.equal(r.linhas[0].descricao, "Saco");
  assert.equal(r.linhas[0].explodido, false);
  assert.deepEqual(r.kitsExplodidos, []);
});

test("item sem produto no cadastro passa direto (o chamador resolve o produto como antes)", () => {
  const r = explodirItensPorEstrutura([itemBling()], new Map());
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].sku, "BB1269-KIT3");
  assert.equal(r.linhas[0].explodido, false);
});

test("kit cujo componente não está no cadastro NÃO é explodido pela metade e é reportado", () => {
  const r = explodirItensPorEstrutura([itemBling()], cadastro(KIT3));
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].sku, "BB1269-KIT3");
  assert.equal(r.linhas[0].explodido, false);
  assert.deepEqual(r.kitsSemComponente, ["BB1269-KIT3"]);
});

test("manterComoItem: kit já impresso/bipado fica inteiro e não é reportado como falha", () => {
  const r = explodirItensPorEstrutura([itemBling()], cadastro(KIT3, UNIDADE), {
    manterComoItem: new Set(["BB1269-KIT3"]),
  });
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].sku, "BB1269-KIT3");
  assert.equal(r.linhas[0].quantidade, 1);
  assert.deepEqual(r.kitsExplodidos, []);
  assert.deepEqual(r.kitsSemComponente, []);
});

test("kit dentro de kit é aberto até a unidade", () => {
  const KIT_DE_KITS = {
    id: "prod-kit-de-kits",
    bling_product_id: 999,
    sku: "KIT-2xKIT3",
    gtin: null,
    nome: "Dois kits de 75",
    raw_data: { formato: "E", estrutura: { componentes: [{ produto: { id: 16707616388 }, quantidade: 2 }] } },
  };
  const r = explodirItensPorEstrutura(
    [itemBling({ codigo: "KIT-2xKIT3", produto: { id: 999 } })],
    cadastro(KIT_DE_KITS, KIT3, UNIDADE),
  );
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0].sku, "BB1269");
  assert.equal(r.linhas[0].quantidade, 6);
});

test("regressão: com o kit explodido, 1 bipe NÃO conclui o pedido; 3 bipes concluem", () => {
  const { linhas } = explodirItensPorEstrutura([itemBling()], cadastro(KIT3, UNIDADE));
  const itens = linhas.map((l, i) => ({
    id: `item-${i}`,
    sku: l.sku,
    ean: l.ean,
    produto_gtin: null,
    descricao: l.descricao,
    quantidade: l.quantidade,
    quantidade_bipada: 0,
  }));

  for (let bipe = 1; bipe <= 3; bipe++) {
    const r = validarBipagem({ itens, itemAtivoId: null, codigo: "7908842863995" });
    assert.equal(r.status, "sucesso", `bipe ${bipe}`);
    r.item.quantidade_bipada += 1;
    const concluido = itens.every((i) => i.quantidade_bipada >= i.quantidade);
    assert.equal(concluido, bipe === 3, `pedido concluído só no 3º bipe (bipe ${bipe})`);
  }
  assert.equal(validarBipagem({ itens, itemAtivoId: null, codigo: "7908842863995" }).status, "pedido_completo");
});
