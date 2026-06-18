// sync-produtos-local.mjs
// Roda no PC do dono (IP residencial) para contornar o bloqueio do Bling a datacenters.
// Uso: node scripts/sync-produtos-local.mjs
// Requer Node 18+ (fetch nativo).

// ─── CONFIGURAÇÃO — edite aqui antes de rodar ──────────────────────────────
const WORKER_BASE        = "https://babyworld.expede.workers.dev";
const ADMIN_KEY          = "B@by1262";
const BLING_CONNECTION_ID = "63e9ad29-e252-420c-9f0e-9d2b9f9f6a03";
// ───────────────────────────────────────────────────────────────────────────

const BLING_PRODUTOS_URL = "https://api.bling.com.br/Api/v3/produtos";
const PAGE_LIMIT         = 100;   // máximo da API Bling
const BATCH_SIZE         = 200;   // produtos por envio ao Worker
const PAGE_DELAY_MS      = 600;   // delay entre páginas (rate limit: 3 req/s)
const RATE_LIMIT_WAIT_MS = 5_000; // espera após 429
const MAX_RETRIES        = 3;

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

async function main() {
  console.log("=== sync-produtos-local ===");
  console.log(`Worker : ${WORKER_BASE}`);
  console.log(`ConnID : ${BLING_CONNECTION_ID}`);
  console.log("");

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
  let loteAtual     = [];

  async function flushLote() {
    if (loteAtual.length === 0) return;
    const lote = loteAtual.splice(0); // drena e esvazia
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
    const url = `${BLING_PRODUTOS_URL}?pagina=${pagina}&limite=${PAGE_LIMIT}&criterio=2`;

    let res;
    let tentativas = 0;
    let fetchOk = false;

    while (tentativas < MAX_RETRIES) {
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });

        if (res.status === 429) {
          console.log(`  Página ${pagina}: rate limit (429) — aguardando ${RATE_LIMIT_WAIT_MS / 1000}s...`);
          await sleep(RATE_LIMIT_WAIT_MS);
          tentativas++;
          continue;
        }

        if (res.status === 401) {
          await flushLote();
          console.error(`\nERRO: token expirado (401) na página ${pagina}.`);
          console.error("Renove a conexão Bling no painel e rode novamente.");
          console.log(`\nBuscados até agora : ${totalBuscados}`);
          console.log(`Enviados ao Worker : ${totalEnviados}`);
          console.log(`Upserted no banco  : ${totalUpserted}`);
          process.exit(1);
        }

        fetchOk = true;
        break;
      } catch (e) {
        tentativas++;
        console.error(`  Página ${pagina}: erro de rede (tentativa ${tentativas}/${MAX_RETRIES}):`, e.message);
        if (tentativas < MAX_RETRIES) await sleep(2_000);
      }
    }

    if (!fetchOk) {
      console.error(`  Página ${pagina}: falhou após ${MAX_RETRIES} tentativas. Abortando.`);
      break;
    }

    if (!res.ok) {
      console.error(`  Página ${pagina}: HTTP ${res.status} inesperado. Abortando.`);
      break;
    }

    const json     = await res.json().catch(() => ({}));
    const produtos = Array.isArray(json?.data) ? json.data : [];

    console.log(`Página ${pagina}: ${produtos.length} produto(s) recebido(s)`);

    if (produtos.length === 0) {
      console.log("Paginação concluída (página vazia).");
      break;
    }

    totalBuscados += produtos.length;
    loteAtual.push(...produtos);

    // Envia ao Worker quando o lote atingir BATCH_SIZE
    if (loteAtual.length >= BATCH_SIZE) {
      await flushLote();
    }

    // A API Bling retornou menos que o limite → última página
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
  console.log(`Enviados ao Worker : ${totalEnviados}`);
  console.log(`Upserted no banco  : ${totalUpserted}`);
  console.log("Sync concluído.");
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
