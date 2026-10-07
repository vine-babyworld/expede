/**
 * Magalu — lógica pura da integração (sem I/O, sem env, sem banco).
 *
 * Fica separado de `magalu.functions.ts` (que faz fetch/Supabase/env) pela
 * mesma razão que `bipagem.ts` é separado de `bipagem.functions.ts`: o que é
 * pura decisão tem teste (`test/magalu.test.mjs`) e roda fora do Worker.
 *
 * Base de conhecimento: `docs/integrations/magalu.md`.
 */

// ── Constantes do canal ──────────────────────────────────────────────────────

export const MAGALU_AUTH_URL = "https://id.magalu.com/login";
export const MAGALU_TOKEN_URL = "https://id.magalu.com/oauth/token";
export const MAGALU_API_BASE = "https://api.magalu.com";
export const MAGALU_REDIRECT_URI = "https://babyworld.expede.workers.dev/api/magalu/callback";

/** Channel id de produção do Magazine Luiza (seção 1 da base). */
export const MAGALU_CHANNEL_ID = "9fe0d853-732b-4e4a-a0b0-cff988ed043d";

/**
 * Os dois tenants da conta. O consentimento TEM de ser dado pelo `organization`:
 * com o `person` tudo autentica e só estoura 403 depois, em produção. É por isso
 * que `choose_tenants=true` é obrigatório na URL — e por isso quem monta a URL
 * é o EXPEDE, não a memória de quem clica.
 */
export const MAGALU_TENANT_ORGANIZATION = "94725b94-9532-4475-8c3a-299b0e685dde";
export const MAGALU_TENANT_PERSON = "23e801cc-5245-46eb-86d9-bcab85db4964";

/**
 * Os 6 escopos gravados no client (`--scopes-default`). O escopo efetivo do
 * token é a UNIÃO de `--scopes-default` com o `scope=` desta URL — mandar os
 * dois iguais é o que garante que a logística não fique de fora.
 */
export const MAGALU_SCOPES = [
  "open:order-order-seller:read",
  "open:order-delivery-seller:read",
  "open:order-delivery-seller:write",
  "open:order-invoice-seller:read",
  "open:order-logistics-seller:read",
  "open:order-logistics-seller:write",
] as const;

// ── URL de consentimento ─────────────────────────────────────────────────────

export function montarUrlConsentimento(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  if (!opts.clientId) throw new Error("magalu: client_id ausente");
  if (!opts.redirectUri) throw new Error("magalu: redirect_uri ausente");
  if (!opts.state) throw new Error("magalu: state ausente");

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: (opts.scopes ?? MAGALU_SCOPES).join(" "),
    response_type: "code",
    state: opts.state,
    // Obrigatório para seller. Sem isso o consentimento vale só para a pessoa
    // física que fez login, e a etiqueta estoura 403 em produção.
    choose_tenants: "true",
  });
  return `${MAGALU_AUTH_URL}?${params.toString()}`;
}

// ── Margem de renovação de token ─────────────────────────────────────────────

/**
 * Quanto antes do vencimento o token deve ser renovado, em ms.
 *
 * Não é constante de propósito: o client saiu do IDM CLI com `TOKEN EXPIRATION`
 * de **20 s** (a doc promete 7200 s), e uma margem fixa de 60 s faria toda
 * chamada renovar — que é exatamente o caminho para o 429 da Lição #41 com o
 * Bling. A margem acompanha a vida do token: 10% dele, no mínimo 5 s, no máximo
 * 300 s, e nunca mais que metade da validade.
 */
export function calcularMargemRenovacaoMs(ttlSegundos: number | null | undefined): number {
  const ttl = typeof ttlSegundos === "number" && Number.isFinite(ttlSegundos) && ttlSegundos > 0
    ? ttlSegundos
    : 7200;
  const margemSegundos = Math.min(Math.max(ttl * 0.1, 5), 300, ttl * 0.5);
  return Math.round(margemSegundos * 1000);
}

export function precisaRenovar(opts: {
  agoraMs: number;
  expiraEmMs: number;
  ttlSegundos: number | null | undefined;
}): boolean {
  return opts.agoraMs >= opts.expiraEmMs - calcularMargemRenovacaoMs(opts.ttlSegundos);
}

// ── Discriminador de modalidade (Magalu Entregas × frete próprio) ────────────

export type DiscriminadoresModalidade = {
  /** Objeto cru, como veio. É o que a Etapa 2 existe para olhar. */
  provider: unknown;
  /** Cru. Nullable no spec — o null pode ser o próprio discriminador. */
  logistic_network: unknown;
  provider_id: unknown;
  provider_name: unknown;
  logistic_network_id: unknown;
  logistic_network_name: unknown;
  /**
   * Campos que a base ANTIGA documentava em `provider.extras` e que o spec
   * OpenAPI não tem. Se vierem preenchidos, a base antiga estava certa e o
   * spec é que está incompleto; se vierem `undefined`, a regra de roteamento
   * tem de sair de `provider`/`logistic_network`.
   */
  extras_legado: {
    is_mle: unknown;
    is_fulfillment: unknown;
    shipping_type: unknown;
    shipping_name: unknown;
  };
  /** Todas as chaves de `shipping`, para ver o que existe de verdade. */
  chaves_shipping: string[];
  /** Todas as chaves de `shipping.provider`. */
  chaves_provider: string[];
};

function chavesDe(valor: unknown): string[] {
  return valor && typeof valor === "object" ? Object.keys(valor as Record<string, unknown>) : [];
}

function pegar(valor: unknown, caminho: string): unknown {
  let atual: unknown = valor;
  for (const parte of caminho.split(".")) {
    if (atual == null || typeof atual !== "object") return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

/**
 * Extrai de uma entrega tudo que pode distinguir Magalu Entregas de frete
 * próprio, **sem decidir nada**. A regra de roteamento só será escrita depois
 * de ver estes campos vindos de um pedido real (pergunta 2 da Etapa 2).
 */
export function extrairDiscriminadoresDeModalidade(delivery: unknown): DiscriminadoresModalidade {
  const shipping = pegar(delivery, "shipping");
  const provider = pegar(shipping, "provider");
  const logisticNetwork = pegar(shipping, "logistic_network");

  return {
    provider: provider ?? null,
    logistic_network: logisticNetwork ?? null,
    provider_id: pegar(provider, "id"),
    provider_name: pegar(provider, "name"),
    logistic_network_id: pegar(logisticNetwork, "id"),
    logistic_network_name: pegar(logisticNetwork, "name"),
    extras_legado: {
      is_mle: pegar(provider, "extras.is_mle"),
      is_fulfillment: pegar(provider, "extras.is_fulfillment"),
      shipping_type: pegar(provider, "extras.shipping_type"),
      shipping_name: pegar(provider, "extras.shipping_name"),
    },
    chaves_shipping: chavesDe(shipping),
    chaves_provider: chavesDe(provider),
  };
}

/**
 * Acha as entregas dentro de qualquer um dos formatos que a API devolve:
 * envelope de lista (`{meta, results}`), pedido único (`{deliveries: []}`) ou
 * uma entrega solta. O formato exato de cada rota ainda é suposição — por isso
 * a função aceita os três em vez de assumir um.
 */
export function coletarEntregas(payload: unknown): unknown[] {
  if (payload == null || typeof payload !== "object") return [];

  const results = (payload as Record<string, unknown>).results;
  if (Array.isArray(results)) {
    return results.flatMap((r) => {
      const aninhadas = (r as Record<string, unknown>)?.deliveries;
      return Array.isArray(aninhadas) && aninhadas.length > 0 ? aninhadas : [r];
    });
  }

  const deliveries = (payload as Record<string, unknown>).deliveries;
  if (Array.isArray(deliveries)) return deliveries;

  if ("id" in (payload as Record<string, unknown>)) return [payload];
  return [];
}

// ── Detecção de formato do arquivo baixado ───────────────────────────────────

export type FormatoEtiqueta = "pdf" | "zpl" | "zip" | "png" | "jpeg" | "html" | "desconhecido";

/**
 * Descobre o que a `signed_url` realmente entregou, pelos bytes — não pelo
 * `Content-Type`, que já mentiu em outros canais. É o que responde a pergunta 3
 * ("`format: zpl` devolve ZPL imprimível?"): um ZPL de verdade começa com `^XA`.
 */
export function detectarFormatoBinario(bytes: Uint8Array): FormatoEtiqueta {
  if (bytes.length === 0) return "desconhecido";

  const inicio = String.fromCharCode(...bytes.slice(0, 64));

  if (inicio.startsWith("%PDF-")) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  if (bytes[0] === 0x89 && inicio.slice(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";

  const semEspaco = inicio.replace(/^[\s﻿]+/, "");
  if (semEspaco.startsWith("^XA") || semEspaco.startsWith("~")) return "zpl";
  if (/^<(!doctype html|html)/i.test(semEspaco)) return "html";

  return "desconhecido";
}

// ── Etiqueta: seleção de entregas, corpo do POST e tradução de erro ──────────

/**
 * Status de entrega que fecham a janela da etiqueta. Medido em 15/09/2026
 * (seção 16 da base): `shipping-labels` recusa entrega `shipped` com
 * `400 SHIPPING_LABEL_SHIPPED`. `delivered` vem depois de `shipped` na ordem
 * prática da seção 3 — se `shipped` já recusa, `delivered` também.
 */
const STATUS_ENTREGA_DESPACHADA = new Set(["shipped", "delivered"]);

/**
 * `frozen` é intermediário e sem transição definida (seção 3): "não mexe,
 * re-consulta". Emitir etiqueta para uma entrega congelada é exatamente mexer.
 */
const STATUS_ENTREGA_CONGELADA = "frozen";
const STATUS_ENTREGA_CANCELADA = "cancelled";

export type SelecaoEntregasEtiqueta =
  | { ok: true; ids: string[] }
  | {
      ok: false;
      motivo:
        | "magalu_sem_entrega"
        | "magalu_etiqueta_ja_despachada"
        | "magalu_entrega_congelada"
        | "magalu_entregas_canceladas";
    };

function statusDe(entrega: unknown): string {
  const s = entrega && typeof entrega === "object" ? (entrega as Record<string, unknown>).status : undefined;
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function idDe(entrega: unknown): string | null {
  const id = entrega && typeof entrega === "object" ? (entrega as Record<string, unknown>).id : undefined;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * Escolhe, entre as entregas de um pedido (saída de `coletarEntregas`), as que
 * podem ir para `shipping-labels`. Exclui `cancelled`, `shipped`, `delivered`,
 * `frozen` e entrega sem `id` (UUID — o `code` com prefixo `LU-` não serve).
 *
 * Status desconhecido/ausente NÃO é excluído: quem decide se a etiqueta sai é a
 * API do Magalu, e o erro dela é traduzido por `traduzirErroEtiquetaMagalu`.
 * Excluir aqui um status que não conhecemos seria recusar em silêncio uma
 * etiqueta que talvez existisse.
 *
 * Quando nada é elegível, o motivo segue a ordem de utilidade para quem está
 * no balcão: "já despachada" (não adianta tentar de novo) > "congelada"
 * (tentar mais tarde) > "cancelada".
 */
export function selecionarEntregasParaEtiqueta(entregas: unknown[]): SelecaoEntregasEtiqueta {
  if (!Array.isArray(entregas) || entregas.length === 0) return { ok: false, motivo: "magalu_sem_entrega" };

  const ids: string[] = [];
  let algumaDespachada = false;
  let algumaCongelada = false;
  let algumaCancelada = false;

  for (const entrega of entregas) {
    const status = statusDe(entrega);
    if (status === STATUS_ENTREGA_CANCELADA) {
      algumaCancelada = true;
      continue;
    }
    if (STATUS_ENTREGA_DESPACHADA.has(status)) {
      algumaDespachada = true;
      continue;
    }
    if (status === STATUS_ENTREGA_CONGELADA) {
      algumaCongelada = true;
      continue;
    }
    const id = idDe(entrega);
    if (id && !ids.includes(id)) ids.push(id);
  }

  if (ids.length > 0) return { ok: true, ids };
  if (algumaDespachada) return { ok: false, motivo: "magalu_etiqueta_ja_despachada" };
  if (algumaCongelada) return { ok: false, motivo: "magalu_entrega_congelada" };
  if (algumaCancelada) return { ok: false, motivo: "magalu_entregas_canceladas" };
  return { ok: false, motivo: "magalu_sem_entrega" };
}

export type CorpoEtiquetaMagalu = {
  channel: { id: string; extras: Record<string, string> };
  deliveries: Array<{ id: string }>;
  label: { format: "zpl" | "pdf"; type: "summary" | "full"; extras: Record<string, string> };
};

/**
 * Corpo de `POST /seller/v1/logistics/shipping-labels` (seção 4). O
 * `channel.id` sai da constante porque a entrega real não tem nó `channel`
 * (seção 16). N entregas no mesmo POST = uma única `signed_url` com o lote.
 */
export function montarCorpoEtiquetaMagalu(
  deliveryIds: string[],
  formato: "zpl" | "pdf" = "zpl",
  tipo: "summary" | "full" = "summary",
): CorpoEtiquetaMagalu {
  return {
    channel: { id: MAGALU_CHANNEL_ID, extras: {} },
    deliveries: deliveryIds.map((id) => ({ id })),
    label: { format: formato, type: tipo, extras: {} },
  };
}

const SLUG_ETIQUETA_DESPACHADA = "SHIPPING_LABEL_SHIPPED";

/**
 * Traduz o erro da API (`{slug, message, details:[{field,location,slug,message}]}`,
 * seção 7b/16) num código curto e estável para a tela e para o log.
 *
 * `SHIPPING_LABEL_SHIPPED` pode vir no topo ou só em `details[]` — no 9262
 * veio em `details[0].slug` com `slug` de topo `BAD_REQUEST`. Para os demais, o
 * slug mais específico vence: o primeiro de `details[]`, senão o do topo.
 */
export function traduzirErroEtiquetaMagalu(status: number, corpo: unknown): string {
  const obj = corpo && typeof corpo === "object" ? (corpo as Record<string, unknown>) : {};
  const slugTopo = typeof obj.slug === "string" ? obj.slug : "";
  const slugsDetalhe = Array.isArray(obj.details)
    ? obj.details
        .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).slug : undefined))
        .filter((s): s is string => typeof s === "string" && s !== "")
    : [];

  if (slugTopo === SLUG_ETIQUETA_DESPACHADA || slugsDetalhe.includes(SLUG_ETIQUETA_DESPACHADA)) {
    return "magalu_etiqueta_ja_despachada";
  }

  const slug = slugsDetalhe[0] || slugTopo || "sem_slug";
  return `magalu_api_error:${status}:${slug}`;
}
