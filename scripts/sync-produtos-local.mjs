// sync-produtos-local.mjs
// Roda no PC do dono (IP residencial) para contornar o bloqueio do Bling a datacenters.
// Uso: node scripts/sync-produtos-local.mjs
// Requer Node 18+ (fetch nativo).

// ─── CONFIGURAÇÃO — edite aqui antes de rodar ──────────────────────────────
const WORKER_BASE         = "https://babyworld.expede.workers.dev";
const ADMIN_KEY           = "B@by1262";
const BLING_CONNECTION_ID = "63e9ad29-e252-420c-9f0e-9d2b9f9f6a03";
// ───────────────────────────────────────────────────────────────────────────

const BLING_PRODUTOS_URL  = "https://api.bling.com.br/Api/v3/produtos";
const PAGE_LIMIT          = 100;    // máximo da API Bling por página
const BATCH_SIZE          = 200;    // produtos por envio ao Worker
const PAGE_DELAY_MS       = 600;    // delay entre páginas de listagem (rate limit ~3 req/s)
const DETAIL_DELAY_MS     = 350;    // delay entre chamadas de detalhe individual
const RATE_LIMIT_WAIT_MS  = 5_000;  // espera após 429
const MAX_RETRIES         = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getToken() {
  const res = await fetch(`${WORKER_BASE}/api/debug/bling-token`, {
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar token`);
  const json = await res.json();
  if (!json.access_token) throw new Error("access_token ausente: " + JSON.stringify(json));
  return json.access_token;
}

async function sendBatch(lote) {
  const res = await fetch(`${WORKER_BASE}/api/admin/importar-produtos-lote`, {
    method: "POST",
    headers: {
      "X-Admin-Key": ADMIN_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ blingConnectionId: BLING_CONNECTION_ID, produtos: lote }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao enviar lote`);
  return await res.json();
}

/**
 * Faz GET em uma URL do Bling com retry em 429 e abort em 401.
 * Retorna o objeto Response em caso de sucesso, ou null se falhar após MAX_RETRIES.
 * Em 401, encerra o processo inteiro (token expirado, inútil continuar).
 *
 * @param {string} label - identificação para logs (ex: "detalhe 123456")
 */
async function fetchBling(url, token, label) {
  let tentativas = 0;
  while (tentativas < MAX_RETRIES) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (e) {
      tentativas++;
      console.error(`  [${label}] erro de rede (tentativa ${tentativas}/${MAX_RETRIES}):`, e.message);
      if (tentativas < MAX_RETRIES) await sleep(2_000);
      continue;
    }

    if (res.status === 429) {
      tentativas++;
      console.log(`  [${label}] rate limit (429) — aguardando ${RATE_LIMIT_WAIT_MS / 1000}s... (tentativa ${tentativas}/${MAX_RETRIES})`);
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }

    if (res.status === 401) {
      console.error(`\nERRO: token expirado (401) em [${label}]. Renove a conexão Bling no painel e rode novamente.`);
      process.exit(1);
    }

    return res; // sucesso (ou erro HTTP diferente de 429/401 — caller decide)
  }

  console.warn(`  [${label}] falhou após ${MAX_RETRIES} tentativas — ignorado`);
  return null;
}

async function main() {
  console.log("=== sync-produtos-local (com GTIN via detalhe) ===");
  console.log(`Worker : ${WORKER_BASE}`);
  console.log(`ConnID : ${BLING_CONNECTION_ID}`);
  console.log("");
  console.log("⚠  ATENÇÃO: esta versão busca o detalhe de cada produto para obter o GTIN.");
  console.log("   Estimativa: ~2700 produtos × 350ms = ~16 minutos só nos detalhes.");
  console.log("   Deixe o terminal aberto e não interrompa o processo.\n");

  // 1. Obtém token via Worker (descriptografado do Supabase)
  let token;
  try {
    console.log("Buscando token Bling no Worker...");
    token = await getToken();
    console.log("Token OK.\n");
  } catch (e) {
    console.error("ERRO ao buscar token:", e.message);
    process.exit(1);
  }

  let pagina        = 0;
  let totalBuscados = 0;
  let totalEnviados = 0;
  let totalUpserted = 0;
  let totalComGtin  = 0;
  let totalSemGtin  = 0;
  let loteAtual     = [];

  async function flushLote() {
    if (loteAtual.length === 0) return;
    const lote = loteAtual.splice(0);
    try {
      const result = await sendBatch(lote);
      totalEnviados += lote.length;
      totalUpserted += result.total_upserted ?? 0;
      console.log(
        `  → Enviados ${lote.length} produtos | upserted=${result.total_upserted ?? "?"} erros=${result.total_erros ?? 0}`,
      );
    } catch (e) {
      console.error(`  → ERRO ao enviar lote de ${lote.length} produtos:`, e.message);
    }
  }

  // 2. Pagina o Bling
  while (true) {
    pagina += 1;
    const urlListagem = `${BLING_PRODUTOS_URL}?pagina=${pagina}&limite=${PAGE_LIMIT}&criterio=2`;

    // ── Busca a página de listagem ────────────────────────────────────────────
    const resListagem = await fetchBling(urlListagem, token, `listagem p${pagina}`);

    if (!resListagem) {
      console.error(`  Página ${pagina}: falhou na listagem. Abortando.`);
      break;
    }
    if (!resListagem.ok) {
      console.error(`  Página ${pagina}: HTTP ${resListagem.status} na listagem. Abortando.`);
      break;
    }

    const jsonListagem = await resListagem.json().catch(() => ({}));
    const produtos     = Array.isArray(jsonListagem?.data) ? jsonListagem.data : [];

    console.log(`Página ${pagina}: ${produtos.length} produto(s) na listagem`);

    if (produtos.length === 0) {
      console.log("Paginação concluída (página vazia).");
      break;
    }

    totalBuscados += produtos.length;

    // ── Enriquece cada produto com GTIN via detalhe ───────────────────────────
    let gtinEncontrados = 0;
    let gtinAusentes    = 0;

    for (const p of produtos) {
      const urlDetalhe = `${BLING_PRODUTOS_URL}/${p.id}`;
      const resDetalhe = await fetchBling(urlDetalhe, token, `detalhe ${p.id}`);

      if (resDetalhe && resDetalhe.ok) {
        const jsonDetalhe = await resDetalhe.json().catch(() => ({}));
        const gtin = jsonDetalhe?.data?.gtin;
        if (gtin) {
          p.gtin = String(gtin);
          gtinEncontrados++;
        } else {
          gtinAusentes++;
        }
      } else {
        // fetchBling retornou null (esgotou retries) ou HTTP inesperado — segue sem gtin
        gtinAusentes++;
      }

      await sleep(DETAIL_DELAY_MS);
    }

    totalComGtin  += gtinEncontrados;
    totalSemGtin  += gtinAusentes;
    console.log(`  Detalhes: GTIN encontrado=${gtinEncontrados} ausente/falhou=${gtinAusentes}`);

    // ── Acumula no lote e envia se atingiu BATCH_SIZE ─────────────────────────
    loteAtual.push(...produtos);
    if (loteAtual.length >= BATCH_SIZE) {
      await flushLote();
    }

    if (produtos.length < PAGE_LIMIT) {
      console.log("Última página detectada.");
      break;
    }

    await sleep(PAGE_DELAY_MS);
  }

  // Envia sobra do último lote
  await flushLote();

  console.log("\n=== RESUMO FINAL ===");
  console.log(`Buscados do Bling  : ${totalBuscados}`);
  console.log(`  Com GTIN         : ${totalComGtin}`);
  console.log(`  Sem GTIN         : ${totalSemGtin}`);
  console.log(`Enviados ao Worker : ${totalEnviados}`);
  console.log(`Upserted no banco  : ${totalUpserted}`);
  console.log("Sync concluído.");
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
