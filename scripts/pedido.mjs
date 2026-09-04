// pedido.mjs
// Diagnostica (e opcionalmente recupera) um pedido que não apareceu na expedição.
//
// Uso:
//   node --env-file=.env scripts/pedido.mjs 2000018004864372
//   node --env-file=.env scripts/pedido.mjs 2000018004864372 --importar
//
// Sem --importar não escreve nada: só responde "onde esse pedido está".
// Requer Node 20.6+ (fetch nativo + --env-file). ADMIN_KEY, SUPABASE_URL e
// SUPABASE_SERVICE_ROLE_KEY vêm do .env do projeto — nunca aparecem na tela.
//
// Por que este script existe, em vez de um passo-a-passo manual: a API do Bling
// ACEITA `?numeroLoja=` e IGNORA o filtro (verificado em 04/09/2026 — pedir um
// numeroLoja devolveu os 10 pedidos mais recentes da conta, nenhum deles o
// solicitado). Quem procura o pedido à mão e confia no primeiro resultado acaba
// olhando — ou importando — o pedido errado. Aqui a lista é sempre conferida.
// Ver Lição #38 em "05 - Erros e Soluções.md".

const WORKER_BASE = "https://babyworld.expede.workers.dev";
const ADMIN_KEY = process.env.ADMIN_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BLING_PEDIDOS_URL = "https://api.bling.com.br/Api/v3/pedidos/vendas";
const PAGINAS = 6; // 6 x 100 = ~6 semanas de vendas
const LIMITE = 100; // máximo da API Bling por página
const DELAY_MS = 400; // rate limit Bling ~3 req/s

const LOJAS = { 203482894: "Mercado Livre", 204014269: "Shopee" };
// Só os códigos confirmados no código do EXPEDE (a-expedir.tsx e nf-emissao.policy.ts).
// Os demais saem como número puro de propósito — rótulo chutado engana mais que ajuda.
const SITUACOES = { 6: "Em aberto", 9: "Faturado", 12: "Cancelado", 15: "Atendido" };

const numeroLoja = process.argv[2];
const importar = process.argv.includes("--importar");

if (!numeroLoja || numeroLoja.startsWith("--")) {
  console.error("Uso: node --env-file=.env scripts/pedido.mjs <numeroLoja> [--importar]");
  process.exit(1);
}
for (const [nome, valor] of [
  ["ADMIN_KEY", ADMIN_KEY],
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_KEY],
]) {
  if (!valor) {
    console.error(
      `ERRO: ${nome} não encontrado. Rode com: node --env-file=.env ${process.argv[1]} ${numeroLoja}`,
    );
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rotulo = (mapa, id) => `${id}${mapa[id] ? ` (${mapa[id]})` : ""}`;

async function getToken() {
  const res = await fetch(`${WORKER_BASE}/api/debug/bling-token`, {
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  if (!res.ok) throw new Error(`falha ao obter token Bling: HTTP ${res.status}`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error("Worker respondeu sem access_token");
  return access_token;
}

async function buscarNoExpede() {
  const url =
    `${SUPABASE_URL}/rest/v1/pedidos` +
    `?numero_loja=eq.${encodeURIComponent(numeroLoja)}` +
    `&select=numero,numero_loja,marketplace,situacao_id,data_pedido,bling_nota_fiscal_numero,` +
    `ml_shipment_status,ml_shipment_substatus,printed_at,arquivado,pedido_itens(sku,quantidade,quantidade_bipada)`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase respondeu HTTP ${res.status}`);
  return (await res.json())[0] ?? null;
}

// Varredura conferida no cliente — ver comentário do cabeçalho sobre o filtro ignorado.
async function buscarNoBling(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  for (let pagina = 1; pagina <= PAGINAS; pagina++) {
    const res = await fetch(`${BLING_PEDIDOS_URL}?limite=${LIMITE}&pagina=${pagina}`, { headers });
    if (!res.ok) throw new Error(`Bling respondeu HTTP ${res.status} na página ${pagina}`);
    const lista = (await res.json()).data ?? [];
    const achado = lista.find((p) => String(p.numeroLoja ?? "") === numeroLoja);
    if (achado) {
      const det = await fetch(`${BLING_PEDIDOS_URL}/${achado.id}`, { headers });
      return { resumo: achado, detalhe: det.ok ? (await det.json()).data : null, pagina };
    }
    if (lista.length < LIMITE) return null; // última página
    await sleep(DELAY_MS);
  }
  return null;
}

async function main() {
  console.log(`\nPedido ${numeroLoja}\n${"─".repeat(60)}`);

  const noExpede = await buscarNoExpede();
  if (noExpede) {
    const itens = noExpede.pedido_itens ?? [];
    const pendente = itens.some((i) => Number(i.quantidade_bipada) < Number(i.quantidade));
    console.log("EXPEDE:  ENCONTRADO");
    console.log(
      `         numero ${noExpede.numero} · ${noExpede.marketplace} · ${rotulo(SITUACOES, noExpede.situacao_id)}`,
    );
    console.log(
      `         data ${String(noExpede.data_pedido).slice(0, 10)} · NF ${noExpede.bling_nota_fiscal_numero ?? "—"}`,
    );
    console.log(
      `         envio ML: ${noExpede.ml_shipment_status ?? "—"}${noExpede.ml_shipment_substatus ? ` / ${noExpede.ml_shipment_substatus}` : ""}`,
    );
    console.log(
      `         impresso: ${noExpede.printed_at ? String(noExpede.printed_at).slice(0, 16).replace("T", " ") : "não"}` +
        ` · arquivado: ${noExpede.arquivado ? "sim" : "não"}`,
    );
    console.log(
      `         itens: ${itens.length}${itens.length ? ` (${pendente ? "ainda há item a bipar" : "todos bipados"})` : ""}`,
    );
    console.log('\nEste pedido já está no EXPEDE. Se não aparece em "A expedir", o motivo está');
    console.log(
      "nas linhas acima: sem NF, arquivado, já impresso, já enviado no ML, ou tudo bipado.",
    );
    return;
  }

  console.log("EXPEDE:  AUSENTE\n");
  console.log(`Procurando no Bling (até ${PAGINAS * LIMITE} vendas mais recentes)...`);

  const token = await getToken();
  const achado = await buscarNoBling(token);

  if (!achado) {
    console.log("\nBling:   NÃO ENCONTRADO");
    console.log("\nO pedido não está nas vendas recentes do Bling. Ou é mais antigo que a");
    console.log("varredura, ou nunca chegou do marketplace — nesse caso o problema está na");
    console.log("integração marketplace→Bling, e não no EXPEDE.");
    process.exitCode = 1;
    return;
  }

  const d = achado.detalhe ?? achado.resumo;
  const temNf = Boolean(d.notaFiscal?.id);
  console.log(`\nBling:   ENCONTRADO (página ${achado.pagina})`);
  console.log(`         bling_pedido_id ${d.id} · numero ${d.numero}`);
  console.log(`         loja ${rotulo(LOJAS, d.loja?.id)} · ${rotulo(SITUACOES, d.situacao?.id)}`);
  console.log(
    `         data ${d.data}${d.dataSaida && d.dataSaida !== d.data ? ` · saída ${d.dataSaida}` : ""}`,
  );
  console.log(`         NF: ${temNf ? d.notaFiscal.id : "NENHUMA"}`);

  if (d.data && d.dataSaida && d.dataSaida > d.data) {
    const dias = Math.round((new Date(d.dataSaida) - new Date(d.data)) / 86_400_000);
    if (dias > 10) {
      console.log(`\n  ⚠ Faturado ${dias} dias depois do pedido — é o caso da Lição #37:`);
      console.log("    fora da janela de 10 dias, a reconciliação não enxergava mais o pedido.");
    }
  }
  if (!temNf) {
    console.log("\n  ⚠ Sem NF no Bling. O EXPEDE só expede pedido com NF (ou Flex).");
    console.log("    Emita a nota no Bling primeiro; a importação sozinha não resolve.");
  }

  if (!importar) {
    console.log("\nPara importar, rode de novo com --importar:");
    // process.argv[1] em vez de caminho fixo: quando o script é chamado de outro
    // diretório pelo caminho completo, a sugestão precisa ser colável do jeito
    // que a pessoa realmente invocou.
    console.log(`  node --env-file=.env ${process.argv[1]} ${numeroLoja} --importar`);
    return;
  }

  console.log("\nImportando...");
  // Sempre por blingPedidoId: é o identificador que a API respeita de verdade.
  const res = await fetch(`${WORKER_BASE}/api/admin/importar-pedido`, {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ blingPedidoId: d.id }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    console.error(`FALHOU: HTTP ${res.status} ${JSON.stringify(json)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `OK — numero ${json.numero} · numeroLoja ${json.numeroLoja} · NF ${json.notaFiscalId ?? "—"}`,
  );
  console.log("\nConfira rodando o script de novo sem --importar.");
}

main().catch((err) => {
  console.error(`\nERRO: ${err.message}`);
  process.exitCode = 1;
});
