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
