// sync-produtos-local.mjs
// Roda no PC do dono (IP residencial) para contornar o bloqueio do Bling a datacenters.
//
// Uso: node --env-file=.env scripts/sync-produtos-local.mjs
//        → sincroniza TODAS as conexões Bling conectadas
//      node --env-file=.env scripts/sync-produtos-local.mjs --conn=<uuid> [--conn=<uuid>]
//        → restringe às conexões informadas
//
// Requer Node 20.6+ (fetch nativo + --env-file). ADMIN_KEY vem do .env do projeto
// (era hardcoded aqui antes e ficou dessincronizado do secret do Worker).

// ─── CONFIGURAÇÃO ──────────────────────────────────────────────────────────
const WORKER_BASE = "https://babyworld.expede.workers.dev";
const ADMIN_KEY   = process.env.ADMIN_KEY;

// A conexão era cravada aqui, e por isso a segunda conta Bling nunca era importada.
// Agora a lista vem do Worker; --conn só serve para restringir.
const CONEXOES_PEDIDAS = process.argv
  .slice(2)
  .filter((a) => a.startsWith("--conn="))
  .map((a) => a.slice("--conn=".length).trim())
  .filter(Boolean);
// ───────────────────────────────────────────────────────────────────────────

if (!ADMIN_KEY) {
  console.error("ERRO: ADMIN_KEY não encontrado. Rode com: node --env-file=.env scripts/sync-produtos-local.mjs");
  process.exit(1);
}

const BLING_PRODUTOS_URL  = "https://api.bling.com.br/Api/v3/produtos";
const PAGE_LIMIT          = 100;    // máximo da API Bling por página
const BATCH_SIZE          = 200;    // produtos por envio ao Worker
const PAGE_DELAY_MS       = 600;    // delay entre páginas de listagem (rate limit ~3 req/s)
const DETAIL_DELAY_MS     = 350;    // delay entre chamadas de detalhe individual
const RATE_LIMIT_WAIT_MS  = 5_000;  // espera após 429
const MAX_RETRIES         = 3;
const MAX_TOKEN_RENOVACOES = 3;     // renovações de token por requisição (import longo atravessa a expiração)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Busca o token de uma conexão. Sem argumento, o Worker escolhe a conexão mais antiga.
 *  Devolve o objeto inteiro: { access_token, connection_id, nome, expira_em }. */
async function getToken(connectionId) {
  const url = connectionId
    ? `${WORKER_BASE}/api/debug/bling-token?connection_id=${encodeURIComponent(connectionId)}`
    : `${WORKER_BASE}/api/debug/bling-token`;
  const res = await fetch(url, { headers: { "X-Admin-Key": ADMIN_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar token`);
  const json = await res.json();
  if (!json.access_token) throw new Error("access_token ausente: " + JSON.stringify(json));
  return json;
}

/** Conexões Bling conectadas, segundo o Worker. Um Worker antigo (sem suporte a
 *  ?listar=1) responde com um objeto de token em vez de uma lista — nesse caso
 *  devolve null e o chamador cai no comportamento antigo (conexão padrão). */
async function listarConexoes() {
  const res = await fetch(`${WORKER_BASE}/api/debug/bling-token?listar=1`, {
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao listar conexões`);
  const json = await res.json();
  if (!Array.isArray(json.connections)) {
    console.warn("⚠  Worker sem suporte a ?listar=1 (deploy antigo). Seguindo com a conexão padrão.");
    return null;
  }
  return json.connections;
}

/** Token corrente. Fica em escopo de módulo porque um import longo (~20 min) pode
 *  atravessar a expiração do access token do Bling. */
let tokenAtual = null;

/** Conexão sendo sincronizada agora — usada no envio do lote e na renovação do token. */
let conexaoAtual = null;

/** Rebusca o token no Worker. O endpoint /api/debug/bling-token chama
 *  getDecryptedAccessToken, que renova sozinho quando o token está expirado (ou a
 *  menos de 60s disso) — então um 401 no meio do import se resolve aqui, sem
 *  nenhuma intervenção manual no painel do Bling. */
async function renovarToken(motivo) {
  console.log(`  Renovando token Bling (${motivo})...`);
  tokenAtual = (await getToken(conexaoAtual)).access_token;
  console.log("  Token renovado, retomando.");
}

async function sendBatch(lote) {
  const res = await fetch(`${WORKER_BASE}/api/admin/importar-produtos-lote`, {
    method: "POST",
    headers: {
      "X-Admin-Key": ADMIN_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ blingConnectionId: conexaoAtual, produtos: lote }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao enviar lote`);
  return await res.json();
}

/**
 * Faz GET em uma URL do Bling com retry em 429 e em 401.
 * Retorna o objeto Response em caso de sucesso, ou null se falhar após MAX_RETRIES.
 * Em 401, renova o token pelo Worker e repete a requisição (até MAX_TOKEN_RENOVACOES
 * vezes); só aborta se a própria renovação falhar.
 *
 * @param {string} label - identificação para logs (ex: "detalhe 123456")
 */
async function fetchBling(url, label) {
  let tentativas = 0;
  let renovacoes = 0;
  while (tentativas < MAX_RETRIES) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokenAtual}`, Accept: "application/json" },
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
      if (renovacoes >= MAX_TOKEN_RENOVACOES) {
        console.error(`\nERRO: 401 persistente em [${label}] após ${renovacoes} renovação(ões) de token. Abortando.`);
        process.exit(1);
      }
      renovacoes++;
      try {
        await renovarToken(`401 em ${label}`);
      } catch (e) {
        console.error(`\nERRO: falha ao renovar o token após 401 em [${label}]:`, e.message);
        console.error("Reautorize a conexão Bling no painel e rode novamente.");
        process.exit(1);
      }
      continue;
    }

    return res; // sucesso (ou erro HTTP diferente de 429/401 — caller decide)
  }

  console.warn(`  [${label}] falhou após ${MAX_RETRIES} tentativas — ignorado`);
  return null;
}

/** Importa todos os produtos de UMA conexão Bling.
 *  Devolve os totais da conexão, ou null se ela falhou (as outras seguem). */
async function sincronizarConexao(conexao) {
  // 1. Obtém token via Worker (descriptografado do Supabase)
  let tk;
  try {
    console.log(`\nBuscando token Bling no Worker (${conexao.id ?? "conexão padrão"})...`);
    tk = await getToken(conexao.id);
  } catch (e) {
    console.error(`ERRO ao buscar token de ${conexao.id ?? "conexão padrão"}:`, e.message);
    return null;
  }

  tokenAtual   = tk.access_token;
  conexaoAtual = conexao.id ?? tk.connection_id ?? null;
  if (!conexaoAtual) {
    console.error("ERRO: não foi possível determinar o id da conexão (Worker desatualizado?).");
    console.error("      Atualize o deploy do Worker ou rode com --conn=<uuid>.");
    return null;
  }

  const nome   = conexao.nome ?? tk.nome ?? null;
  const rotulo = nome ? `${nome} (${conexaoAtual})` : conexaoAtual;
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`Conexão: ${rotulo}`);
  console.log("──────────────────────────────────────────────────────────────");

  let pagina        = 0;
  let totalBuscados = 0;
  let totalEnviados = 0;
  let totalUpserted = 0;
  let totalComGtin  = 0;
  let totalSemGtin  = 0;
  let loteAtual     = [];
  let avisouRunLog  = false;

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
      // O Worker responde run_logged=false quando não conseguiu registrar a run.
      // Avisa uma única vez — o import em si continua válido.
      if (result.run_logged === false && !avisouRunLog) {
        avisouRunLog = true;
        console.warn(
          "\n⚠  AVISO: o Worker não conseguiu gravar o log da run (run_logged=false).\n" +
            "   A tabela `produtos_sync_runs` provavelmente não existe em produção.\n" +
            "   Aplique a migração `supabase/migrations/20260618100000_produtos-sync-runs.sql`.\n" +
            "   Os produtos continuam sendo importados normalmente; só o histórico de sync fica sem registro.\n",
        );
      }
    } catch (e) {
      console.error(`  → ERRO ao enviar lote de ${lote.length} produtos:`, e.message);
    }
  }

  // 2. Pagina o Bling
  while (true) {
    pagina += 1;
    const urlListagem = `${BLING_PRODUTOS_URL}?pagina=${pagina}&limite=${PAGE_LIMIT}&criterio=2`;

    // ── Busca a página de listagem ────────────────────────────────────────────
    const resListagem = await fetchBling(urlListagem, `listagem p${pagina}`);

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
      const resDetalhe = await fetchBling(urlDetalhe, `detalhe ${p.id}`);

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

  console.log(`\n--- Conexão ${rotulo} ---`);
  console.log(`Buscados do Bling  : ${totalBuscados}`);
  console.log(`  Com GTIN         : ${totalComGtin}`);
  console.log(`  Sem GTIN         : ${totalSemGtin}`);
  console.log(`Enviados ao Worker : ${totalEnviados}`);
  console.log(`Upserted no banco  : ${totalUpserted}`);

  return { totalBuscados, totalComGtin, totalSemGtin, totalEnviados, totalUpserted };
}

async function main() {
  console.log("=== sync-produtos-local (com GTIN via detalhe) ===");
  console.log(`Worker : ${WORKER_BASE}`);
  console.log("");
  console.log("⚠  ATENÇÃO: esta versão busca o detalhe de cada produto para obter o GTIN.");
  console.log("   Estimativa: ~2800 produtos × 350ms = ~16 minutos POR CONEXÃO.");
  console.log("   Deixe o terminal aberto e não interrompa o processo.");

  // Resolve quais conexões sincronizar
  let conexoes;
  if (CONEXOES_PEDIDAS.length > 0) {
    conexoes = CONEXOES_PEDIDAS.map((id) => ({ id, nome: null }));
    console.log(`\nConexões pedidas via --conn: ${conexoes.length}`);
  } else {
    const listadas = await listarConexoes();
    // null = Worker antigo (sem ?listar=1): cai na conexão padrão que ele escolher.
    conexoes = listadas ?? [{ id: null, nome: null }];
    if (conexoes.length === 0) {
      console.error("ERRO: nenhuma conexão Bling conectada.");
      process.exit(1);
    }
    console.log(`\nConexões conectadas: ${conexoes.length}`);
  }

  const totais = {
    totalBuscados: 0, totalComGtin: 0, totalSemGtin: 0, totalEnviados: 0, totalUpserted: 0,
  };
  const falhas = [];

  for (const conexao of conexoes) {
    const r = await sincronizarConexao(conexao);
    if (!r) {
      falhas.push(conexao.id ?? "(padrão)");
      continue;
    }
    for (const k of Object.keys(totais)) totais[k] += r[k];
  }

  console.log("\n=== RESUMO FINAL ===");
  console.log(`Conexões OK        : ${conexoes.length - falhas.length}/${conexoes.length}`);
  if (falhas.length > 0) console.log(`Conexões com falha : ${falhas.join(", ")}`);
  console.log(`Buscados do Bling  : ${totais.totalBuscados}`);
  console.log(`  Com GTIN         : ${totais.totalComGtin}`);
  console.log(`  Sem GTIN         : ${totais.totalSemGtin}`);
  console.log(`Enviados ao Worker : ${totais.totalEnviados}`);
  console.log(`Upserted no banco  : ${totais.totalUpserted}`);
  console.log(falhas.length > 0 ? "Sync concluído COM FALHAS." : "Sync concluído.");
  if (falhas.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
