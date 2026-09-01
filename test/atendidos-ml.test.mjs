import assert from "node:assert/strict";
import test from "node:test";

import { validarCandidatoAtendidoMl } from "../src/lib/atendidos-ml.ts";

const LOJA_ML_ID = "203482894";
const DATA_INICIO = "2026-08-22";

test("validarCandidatoAtendidoMl aceita somente detalhe Atendido da loja ML dentro da janela", () => {
  const casos = [
    {
      nome: "válido",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 }, data: "2026-08-22T10:00:00-03:00" },
      esperado: { valido: true },
    },
    {
      nome: "loja errada",
      detalhe: { loja: { id: 999 }, situacao: { id: 15 }, data: "2026-08-22" },
      esperado: { valido: false, motivo: "loja incorreta: 999 (esperada 203482894)" },
    },
    {
      nome: "situação diferente",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 9 }, data: "2026-08-22" },
      esperado: { valido: false, motivo: "situação incorreta: 9 (esperada 15)" },
    },
    {
      nome: "data anterior à janela",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 }, data: "2026-08-21T23:59:59-03:00" },
      esperado: { valido: false, motivo: "data anterior à janela: 2026-08-21 (início 2026-08-22)" },
    },
    {
      nome: "data malformada",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 }, data: "2026-08-22 inválida" },
      esperado: { valido: false, motivo: "data ausente ou inválida" },
    },
    {
      nome: "data ausente",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 } },
      esperado: { valido: false, motivo: "data ausente ou inválida" },
    },
    {
      nome: "hora impossível",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 }, data: "2026-08-22T99:99:00Z" },
      esperado: { valido: false, motivo: "data ausente ou inválida" },
    },
    {
      nome: "fuso impossível",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 }, data: "2026-08-22T10:00:00+99:99" },
      esperado: { valido: false, motivo: "data ausente ou inválida" },
    },
    {
      nome: "data posterior à janela",
      detalhe: { loja: { id: 203482894 }, situacao: { id: 15 }, data: "2026-09-02" },
      esperado: { valido: false, motivo: "data posterior à janela: 2026-09-02 (fim 2026-09-01)" },
    },
  ];

  for (const { nome, detalhe, esperado } of casos) {
    assert.deepEqual(validarCandidatoAtendidoMl(detalhe, LOJA_ML_ID, DATA_INICIO, "2026-09-01"), esperado, nome);
  }
});
