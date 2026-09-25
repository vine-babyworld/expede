import assert from "node:assert/strict";
import test from "node:test";

import {
  calcularMargemRenovacaoMs,
  coletarEntregas,
  detectarFormatoBinario,
  extrairDiscriminadoresDeModalidade,
  montarUrlConsentimento,
  precisaRenovar,
  MAGALU_SCOPES,
} from "../src/lib/magalu.ts";

// ── URL de consentimento ─────────────────────────────────────────────────────

test("url de consentimento leva choose_tenants=true", () => {
  const url = new URL(montarUrlConsentimento({ clientId: "cid", redirectUri: "https://x/cb", state: "s1" }));
  assert.equal(url.origin + url.pathname, "https://id.magalu.com/login");
  assert.equal(url.searchParams.get("choose_tenants"), "true");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x/cb");
  assert.equal(url.searchParams.get("state"), "s1");
});

test("url de consentimento pede os dois escopos de logistica", () => {
  const url = new URL(montarUrlConsentimento({ clientId: "cid", redirectUri: "https://x/cb", state: "s1" }));
  const escopos = (url.searchParams.get("scope") ?? "").split(" ");
  assert.ok(escopos.includes("open:order-logistics-seller:read"));
  assert.ok(escopos.includes("open:order-logistics-seller:write"));
  assert.equal(escopos.length, MAGALU_SCOPES.length);
});

test("url de consentimento recusa parametro faltando", () => {
  assert.throws(() => montarUrlConsentimento({ clientId: "", redirectUri: "https://x", state: "s" }));
  assert.throws(() => montarUrlConsentimento({ clientId: "c", redirectUri: "", state: "s" }));
  assert.throws(() => montarUrlConsentimento({ clientId: "c", redirectUri: "https://x", state: "" }));
});

// ── Margem de renovacao ──────────────────────────────────────────────────────

test("token de 7200s renova com margem de 300s (teto)", () => {
  assert.equal(calcularMargemRenovacaoMs(7200), 300_000);
});

test("token de 20s nao vira renovacao a cada chamada", () => {
  // O client saiu do IDM CLI com TOKEN EXPIRATION de 20s. Margem fixa de 60s
  // faria toda chamada renovar — o caminho do 429 da Licao #41.
  const margem = calcularMargemRenovacaoMs(20);
  assert.equal(margem, 5_000);
  assert.ok(margem < 20_000, "margem nunca pode passar da validade do token");
});

test("margem nunca passa de metade da validade", () => {
  assert.equal(calcularMargemRenovacaoMs(8), 4_000);
  assert.equal(calcularMargemRenovacaoMs(4), 2_000);
});

test("ttl ausente ou invalido assume os 7200s da doc", () => {
  assert.equal(calcularMargemRenovacaoMs(null), 300_000);
  assert.equal(calcularMargemRenovacaoMs(undefined), 300_000);
  assert.equal(calcularMargemRenovacaoMs(0), 300_000);
  assert.equal(calcularMargemRenovacaoMs(-5), 300_000);
  assert.equal(calcularMargemRenovacaoMs(Number.NaN), 300_000);
});

test("precisaRenovar respeita a margem", () => {
  const agoraMs = 1_000_000;
  // 7200s: margem 300s. Falta 301s -> ainda nao; falta 299s -> renova.
  assert.equal(precisaRenovar({ agoraMs, expiraEmMs: agoraMs + 301_000, ttlSegundos: 7200 }), false);
  assert.equal(precisaRenovar({ agoraMs, expiraEmMs: agoraMs + 299_000, ttlSegundos: 7200 }), true);
  // token ja vencido sempre renova
  assert.equal(precisaRenovar({ agoraMs, expiraEmMs: agoraMs - 1, ttlSegundos: 7200 }), true);
});

// ── Discriminadores de modalidade ────────────────────────────────────────────

test("dumpa provider e logistic_network crus, sem decidir nada", () => {
  const entrega = {
    id: "6c764444-436d-4659-8cec-304414b05259",
    shipping: {
      provider: { id: "prov-1", name: "Magalu Entregas" },
      logistic_network: { id: "net-9", name: "MLE" },
      recipient: {},
    },
  };
  const d = extrairDiscriminadoresDeModalidade(entrega);
  assert.deepEqual(d.provider, { id: "prov-1", name: "Magalu Entregas" });
  assert.deepEqual(d.logistic_network, { id: "net-9", name: "MLE" });
  assert.equal(d.provider_id, "prov-1");
  assert.equal(d.provider_name, "Magalu Entregas");
  assert.equal(d.logistic_network_id, "net-9");
  assert.deepEqual(d.chaves_shipping.sort(), ["logistic_network", "provider", "recipient"]);
  assert.deepEqual(d.chaves_provider.sort(), ["id", "name"]);
});

test("is_mle ausente aparece como undefined, nao como false", () => {
  // A diferenca importa: `false` seria "frete proprio", `undefined` e "o spec
  // nao tem esse campo" — que e exatamente a duvida da pergunta 2.
  const d = extrairDiscriminadoresDeModalidade({ shipping: { provider: { id: "p" } } });
  assert.equal(d.extras_legado.is_mle, undefined);
  assert.equal(d.extras_legado.shipping_name, undefined);
});

test("is_mle presente e reportado como veio", () => {
  const d = extrairDiscriminadoresDeModalidade({
    shipping: { provider: { extras: { is_mle: true, shipping_name: "Magalu Entregas" } } },
  });
  assert.equal(d.extras_legado.is_mle, true);
  assert.equal(d.extras_legado.shipping_name, "Magalu Entregas");
});

test("logistic_network nulo nao quebra nem vira objeto", () => {
  const d = extrairDiscriminadoresDeModalidade({ shipping: { logistic_network: null, provider: null } });
  assert.equal(d.logistic_network, null);
  assert.equal(d.logistic_network_id, undefined);
  assert.deepEqual(d.chaves_provider, []);
});

test("entrega vazia ou invalida nao lanca", () => {
  for (const entrada of [null, undefined, 42, "x", {}]) {
    const d = extrairDiscriminadoresDeModalidade(entrada);
    assert.deepEqual(d.chaves_shipping, []);
  }
});

// ── Coleta de entregas nos tres formatos de resposta ─────────────────────────

test("coleta entregas do envelope de lista de pedidos", () => {
  const payload = { meta: {}, results: [{ code: "9262", deliveries: [{ id: "d1" }, { id: "d2" }] }] };
  assert.deepEqual(coletarEntregas(payload), [{ id: "d1" }, { id: "d2" }]);
});

test("coleta entregas do envelope de lista de entregas", () => {
  const payload = { meta: {}, results: [{ id: "d1" }, { id: "d2" }] };
  assert.deepEqual(coletarEntregas(payload), [{ id: "d1" }, { id: "d2" }]);
});

test("coleta entregas de um pedido unico", () => {
  assert.deepEqual(coletarEntregas({ code: "9262", deliveries: [{ id: "d1" }] }), [{ id: "d1" }]);
});

test("coleta uma entrega solta", () => {
  assert.deepEqual(coletarEntregas({ id: "d1", status: "approved" }), [{ id: "d1", status: "approved" }]);
});

test("payload sem entrega devolve lista vazia", () => {
  assert.deepEqual(coletarEntregas({ meta: {}, results: [] }), []);
  assert.deepEqual(coletarEntregas(null), []);
  assert.deepEqual(coletarEntregas("erro"), []);
});

// ── Deteccao de formato pelo conteudo ────────────────────────────────────────

function bytes(texto) {
  return new TextEncoder().encode(texto);
}

test("PDF e reconhecido pelo magic number", () => {
  assert.equal(detectarFormatoBinario(bytes("%PDF-1.4\n%\xE2\xE3")), "pdf");
});

test("ZPL e reconhecido por ^XA", () => {
  assert.equal(detectarFormatoBinario(bytes("^XA^FO50,50^A0N,40^FDteste^FS^XZ")), "zpl");
  // Com BOM/quebra na frente continua sendo ZPL.
  assert.equal(detectarFormatoBinario(bytes("\n  ^XA^XZ")), "zpl");
});

test("HTML de erro nao passa por etiqueta", () => {
  // O caso que mata em silencio: a signed_url expirou e devolveu uma pagina.
  assert.equal(detectarFormatoBinario(bytes("<!DOCTYPE html><html><body>403")), "html");
});

test("zip e png sao distinguidos", () => {
  assert.equal(detectarFormatoBinario(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), "zip");
  assert.equal(detectarFormatoBinario(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "png");
});

test("vazio e desconhecido nao viram falso positivo", () => {
  assert.equal(detectarFormatoBinario(new Uint8Array([])), "desconhecido");
  assert.equal(detectarFormatoBinario(bytes("alguma coisa qualquer")), "desconhecido");
});
