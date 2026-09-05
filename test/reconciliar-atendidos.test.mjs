import assert from "node:assert/strict";
import test from "node:test";

import {
  agregarCandidatosReconciliacao,
  janelaCivilBrt,
  planejarInspecoesReconciliacao,
  registrarErroConsulta,
} from "../src/lib/reconciliar-atendidos.ts";
import * as reconciliarAtendidos from "../src/lib/reconciliar-atendidos.ts";

const cand = (id, origem, dataPedido = "2026-09-01") => ({ id, origem, permitirSemNf: origem === "q2" || origem === "q4", dataPedido });

test("URLs ML usam dataInicial/dataFinal e Q4 mantém a restrição Atendido da loja", () => {
  const construirUrlsConsultasMl = reconciliarAtendidos.construirUrlsConsultasMl;
  assert.equal(typeof construirUrlsConsultasMl, "function");

  const urls = construirUrlsConsultasMl("https://api.bling.com.br/Api/v3/pedidos/vendas", "203482894", "2026-08-22", "2026-09-01");
  for (const url of [urls.q1, urls.q2, urls.q4]) {
    const params = new URL(url).searchParams;
    assert.equal(params.get("dataInicial"), "2026-08-22");
    assert.equal(params.get("dataFinal"), "2026-09-01");
    assert.equal(params.has("dataInicio"), false);
    assert.equal(params.has("dataFim"), false);
    assert.equal(params.get("idLoja"), "203482894");
  }
  assert.equal(new URL(urls.q4).searchParams.get("idSituacao"), "15");
});

test("consultas Bling são executadas em lotes de no máximo três por segundo", async () => {
  const executarConsultasEmLotes = reconciliarAtendidos.executarConsultasEmLotes;
  assert.equal(typeof executarConsultasEmLotes, "function");

  let janela = 0;
  const chamadas = [];
  const tarefas = ["q1", "q2", "q4", "q5"].map((nome) => async () => {
    chamadas.push({ nome, janela });
    return nome;
  });
  const esperas = [];

  const resultados = await executarConsultasEmLotes(tarefas, 3, 1_000, async (ms) => {
    esperas.push(ms);
    janela++;
  });

  assert.deepEqual(chamadas, [
    { nome: "q1", janela: 0 },
    { nome: "q2", janela: 0 },
    { nome: "q4", janela: 0 },
    { nome: "q5", janela: 1 },
  ]);
  assert.deepEqual(esperas, [1_000]);
  assert.deepEqual(resultados.map((resultado) => resultado.status), [
    "fulfilled", "fulfilled", "fulfilled", "fulfilled",
  ]);
});

test("fontes específicas vencem Q4 e Q4 vence a lista ampla Q2", () => {
  const candidatos = agregarCandidatosReconciliacao([
    cand(1, "q4"), cand(1, "q5"),
    cand(2, "q4"), cand(2, "q1"),
    cand(3, "q2"), cand(3, "q4"),
  ]);

  assert.deepEqual(candidatos, [cand(1, "q5"), cand(2, "q1"), cand(3, "q4")]);
});

test("agregação preserva a capacidade de Q2 sem trocar a origem confiável", () => {
  const candidatos = agregarCandidatosReconciliacao([
    cand(1, "q1"), cand(1, "q2"),
    cand(2, "q4"), cand(2, "q2"),
    cand(3, "q5"), cand(3, "q2"),
  ]);

  assert.deepEqual(candidatos, [
    { ...cand(1, "q1"), permitirSemNf: true },
    { ...cand(2, "q4"), permitirSemNf: true },
    { ...cand(3, "q5"), permitirSemNf: false },
  ]);
});

test("orçamento gira candidatos Q4 inválidos e deixa o válido alcançar inspeção", () => {
  const candidatos = [cand(1, "q4"), cand(2, "q4"), cand(3, "q4"), cand(4, "q4"), cand(5, "q4")];

  const primeiraRodada = planejarInspecoesReconciliacao(candidatos, 4, 0, 0);
  const segundaRodada = planejarInspecoesReconciliacao(candidatos, 4, 1, 1);

  assert.equal(primeiraRodada.length, 4);
  assert.equal(primeiraRodada.some((c) => c.id === 5), false, "os quatro inválidos podem consumir a primeira rodada");
  assert.equal(segundaRodada.some((c) => c.id === 5), true, "a rotação alcança o válido na rodada seguinte");
});

test("orçamento preserva ao menos uma vaga para fonte não-Q4", () => {
  const plano = planejarInspecoesReconciliacao([
    cand(1, "q4"), cand(2, "q4"), cand(3, "q4"), cand(4, "q4"), cand(5, "q1"),
  ], 4, 0, 0);

  assert.equal(plano.length, 4);
  assert.equal(plano.some((c) => c.origem === "q1"), true);
});

test("orçamento gira também fontes não-Q4 reservadas", () => {
  const candidatos = [
    cand(1, "q4"), cand(2, "q4"), cand(3, "q4"), cand(4, "q4"),
    cand(10, "q1"), cand(11, "q2"),
  ];

  const primeiraRodada = planejarInspecoesReconciliacao(candidatos, 4, 0, 0);
  const segundaRodada = planejarInspecoesReconciliacao(candidatos, 4, 1, 1);

  assert.equal(primeiraRodada.some((c) => c.id === 10), true, "a primeira fonte não-Q4 pode falhar ou pular");
  assert.equal(segundaRodada.some((c) => c.id === 11), true, "a segunda fonte não-Q4 aparece na rodada seguinte");
});

test("janela civil BRT não avança para o dia UTC seguinte", () => {
  assert.deepEqual(
    janelaCivilBrt(new Date("2026-09-02T00:30:00.000Z"), 10),
    { inicio: "2026-08-22", fim: "2026-09-01" },
  );
});

test("erro da lista Q4 é exposto no bucket e nos detalhes", () => {
  const bucket = { erros: [] };
  const detalhes = [];

  registrarErroConsulta(bucket, detalhes, "Q4", 503);

  assert.deepEqual(bucket.erros, ["Q4 erro ao buscar lista: 503"]);
  assert.deepEqual(detalhes, ["Q4 erro ao buscar lista: 503"]);
});

test("cada origem de consulta mapeia para o seu marketplace", () => {
  const { MARKETPLACE_POR_ORIGEM, LABEL_POR_ORIGEM } = reconciliarAtendidos;

  assert.equal(MARKETPLACE_POR_ORIGEM.q5, "shopee");
  assert.equal(MARKETPLACE_POR_ORIGEM.q6, "magalu");
  for (const origem of ["q1", "q2", "q3", "q4"]) {
    assert.equal(MARKETPLACE_POR_ORIGEM[origem], "mercadolivre", `${origem} deve ser ML`);
  }

  // Todo canal novo precisa de label e de marketplace — o mapa incompleto era o
  // que fazia um pedido cair no marketplace errado.
  assert.deepEqual(Object.keys(LABEL_POR_ORIGEM).sort(), Object.keys(MARKETPLACE_POR_ORIGEM).sort());
  assert.equal(LABEL_POR_ORIGEM.q6, "Q6");
});

test("Q6 (Magalu) tem a mesma prioridade de Q1/Q5 na deduplicação", () => {
  // Mesmo pedido visto por Q6 e Q2: vence Q6, que é a lista de faturados.
  const agregados = agregarCandidatosReconciliacao([
    { id: 77, origem: "q2", permitirSemNf: true, dataPedido: "2026-09-01" },
    { id: 77, origem: "q6", permitirSemNf: false, dataPedido: "2026-09-01" },
  ]);

  assert.equal(agregados.length, 1);
  assert.equal(agregados[0].origem, "q6");
  // Só a Q1 herda o permitirSemNf da Q2; Magalu sempre exige NF.
  assert.equal(agregados[0].permitirSemNf, false);
});

// --- Q7: rede de segurança para pedido faturado muito depois da data do pedido ---
// Regressão do pedido 9137 (numeroLoja 2000018004864372): feito em 18/08, faturado
// só em 03/09. Q1/Q2/Q4/Q5/Q6 filtram por dataInicial/dataFinal (data do PEDIDO)
// numa janela curta, então quando ele finalmente virou faturado já estava fora
// dela — invisível para o reconciliador para sempre. Ver Lição #37.

test("Q7 busca por data de ALTERAÇÃO, sem limitar pela data do pedido", () => {
  const construirUrlConsultaAlterados = reconciliarAtendidos.construirUrlConsultaAlterados;
  assert.equal(typeof construirUrlConsultaAlterados, "function");

  const url = construirUrlConsultaAlterados(
    "https://api.bling.com.br/Api/v3/pedidos/vendas",
    "203482894",
    "2026-08-25",
    "2026-09-04",
  );
  const params = new URL(url).searchParams;

  assert.equal(params.get("idLoja"), "203482894");
  assert.equal(params.get("dataAlteracaoInicial"), "2026-08-25");
  assert.equal(params.get("dataAlteracaoFinal"), "2026-09-04");
  // O ponto da correção: a data do pedido não pode restringir a busca.
  assert.equal(params.has("dataInicial"), false);
  assert.equal(params.has("dataFinal"), false);

  // Sem loja: uma chamada cobre as três lojas (e a próxima que entrar). Quem
  // separa o canal é marketplacePelaLojaBling sobre o loja.id de cada item.
  const semLoja = new URL(
    construirUrlConsultaAlterados("https://api.bling.com.br/Api/v3/pedidos/vendas", null, "2026-08-25", "2026-09-04"),
  ).searchParams;
  assert.equal(semLoja.has("idLoja"), false);
  assert.equal(semLoja.get("dataAlteracaoInicial"), "2026-08-25");
});

test("Q7 respeita um horizonte de data do pedido para não ressuscitar pedido antigo", () => {
  const dentroDoHorizonte = reconciliarAtendidos.pedidoDentroDoHorizonteAlteracao;
  assert.equal(typeof dentroDoHorizonte, "function");

  assert.equal(dentroDoHorizonte("2026-08-18", "2026-08-05"), true, "pedido 9137 entra");
  assert.equal(dentroDoHorizonte("2026-08-05", "2026-08-05"), true, "piso é inclusivo");
  assert.equal(dentroDoHorizonte("2026-07-30", "2026-08-05"), false, "antigo demais");
  assert.equal(dentroDoHorizonte(null, "2026-08-05"), false, "sem data não arrisca");
});

test("Q7 carrega o próprio marketplace e cede para a fonte específica do mesmo pedido", () => {
  const q7 = (id, marketplace) => ({
    id, origem: "q7", permitirSemNf: false, marketplace, dataPedido: "2026-08-18",
  });

  const candidatos = agregarCandidatosReconciliacao([
    q7(1, "magalu"),
    q7(2, "shopee"), cand(2, "q5"),
    q7(3, "mercadolivre"), cand(3, "q2"),
    q7(4, "magalu"), { id: 4, origem: "q6", permitirSemNf: false, dataPedido: "2026-09-01" },
  ]);

  assert.deepEqual(candidatos[0], q7(1, "magalu"), "sozinha, a Q7 preserva o marketplace");
  assert.equal(candidatos[1].origem, "q5", "Q5 é fonte específica e vence a Q7");
  assert.equal(candidatos[2].origem, "q2", "Q2 vence a Q7 e mantém permitirSemNf");
  assert.equal(candidatos[2].permitirSemNf, true);
  assert.equal(candidatos[3].origem, "q6", "Q6 (Magalu) vence a Q7");
});

test("Q7 aparece nos mapas de canal e rótulo", () => {
  const { MARKETPLACE_POR_ORIGEM, LABEL_POR_ORIGEM } = reconciliarAtendidos;
  assert.equal(LABEL_POR_ORIGEM.q7, "Q7");
  // A Q7 varre as três lojas: o mapa é só fallback de tipo, quem manda é o
  // campo `marketplace` do candidato.
  assert.ok(["mercadolivre", "shopee", "magalu"].includes(MARKETPLACE_POR_ORIGEM.q7));
});

test("Q7 disputa a vaga reservada das demais fontes, não o orçamento do Q4", () => {
  const plano = planejarInspecoesReconciliacao([
    cand(1, "q4"), cand(2, "q4"), cand(3, "q4"), cand(4, "q4"),
    { id: 5, origem: "q7", permitirSemNf: false, marketplace: "mercadolivre", dataPedido: "2026-08-18" },
  ], 4, 0, 0);

  assert.equal(plano.length, 4);
  assert.equal(plano.some((c) => c.origem === "q7"), true);
});

// --- Busca por numeroLoja: o Bling ACEITA o parâmetro e o IGNORA ---
// Verificado contra a API em 04/09/2026: pedir ?numeroLoja=2000018004864372
// devolveu os 10 pedidos mais recentes da conta, nenhum deles o solicitado.
// Quem confia em lista[0] importa o pedido errado. Ver Lição #38.

test("busca por numeroLoja confere a lista devolvida em vez de confiar na ordem", () => {
  const encontrarPedidoPorNumeroLoja = reconciliarAtendidos.encontrarPedidoPorNumeroLoja;
  assert.equal(typeof encontrarPedidoPorNumeroLoja, "function");

  const listaIgnorandoFiltro = [
    { id: 26784052100, numeroLoja: "2000018281873916" },
    { id: 26783922593, numeroLoja: "2000018281688362" },
  ];

  assert.equal(
    encontrarPedidoPorNumeroLoja(listaIgnorandoFiltro, "2000018004864372"),
    null,
    "não pode devolver o primeiro da lista quando o pedido pedido não está nela",
  );
  assert.deepEqual(
    encontrarPedidoPorNumeroLoja(listaIgnorandoFiltro, "2000018281688362"),
    { id: 26783922593, numeroLoja: "2000018281688362" },
    "acha o pedido certo em qualquer posição",
  );
  assert.equal(encontrarPedidoPorNumeroLoja([], "2000018004864372"), null);
  assert.deepEqual(
    encontrarPedidoPorNumeroLoja([{ id: 1, numeroLoja: 2000018004864372 }], "2000018004864372"),
    { id: 1, numeroLoja: 2000018004864372 },
    "comparação é textual: numeroLoja numérico ainda casa com o alvo",
  );
});
