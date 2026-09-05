import assert from "node:assert/strict";
import test from "node:test";

import { marketplaceBadge, marketplaceBadgeOuNulo } from "../src/lib/marketplace-labels.ts";

test("cada marketplace conhecido tem nome e cor próprios", () => {
  assert.equal(marketplaceBadge("mercadolivre").nome, "Mercado Livre");
  assert.equal(marketplaceBadge("mercadolivreflex").nome, "Mercado Livre");
  assert.equal(marketplaceBadge("shopee").nome, "Shopee");
  assert.equal(marketplaceBadge("magalu").nome, "Magalu");
  assert.equal(marketplaceBadge("amazon").nome, "Amazon");

  // Cores distintas entre canais diferentes — o operador separa a fila pela cor.
  const cores = new Set(["mercadolivre", "shopee", "magalu", "amazon"].map((m) => marketplaceBadge(m).cor));
  assert.equal(cores.size, 4);
});

test("canal desconhecido mostra o próprio slug, não 'Outros'", () => {
  // Um canal que começou a cair na fila antes de ser mapeado precisa ser
  // identificável na tela.
  assert.equal(marketplaceBadge("tiktok").nome, "tiktok");
});

test("pedido legado sem marketplace vira traço nas listas e nada no card", () => {
  assert.equal(marketplaceBadge(null).nome, "—");
  assert.equal(marketplaceBadge(undefined).nome, "—");
  assert.equal(marketplaceBadgeOuNulo(null), null);
  assert.equal(marketplaceBadgeOuNulo("magalu")?.nome, "Magalu");
});
