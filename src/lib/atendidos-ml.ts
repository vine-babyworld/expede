export type ValidacaoCandidatoAtendidoMl =
  | { valido: true }
  | { valido: false; motivo: string };

function dataCalendarioValida(valor: unknown): string | null {
  if (typeof valor !== "string") return null;

  const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)))?$/.exec(valor);
  if (!match) return null;
  const data = match[1];

  const parsed = new Date(`${data}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data
    ? null
    : data;
}

export function validarCandidatoAtendidoMl(
  detalhe: any,
  lojaMlId: string,
  dataInicio: string,
  dataFim: string,
): ValidacaoCandidatoAtendidoMl {
  const lojaId = detalhe?.loja?.id;
  if (lojaId == null || String(lojaId) !== lojaMlId) {
    return { valido: false, motivo: `loja incorreta: ${lojaId ?? "ausente"} (esperada ${lojaMlId})` };
  }

  const situacaoId = detalhe?.situacao?.id;
  if (situacaoId !== 15) {
    return { valido: false, motivo: `situação incorreta: ${situacaoId ?? "ausente"} (esperada 15)` };
  }

  const data = dataCalendarioValida(detalhe?.data);
  if (!data) return { valido: false, motivo: "data ausente ou inválida" };
  if (data < dataInicio) {
    return { valido: false, motivo: `data anterior à janela: ${data} (início ${dataInicio})` };
  }
  if (data > dataFim) {
    return { valido: false, motivo: `data posterior à janela: ${data} (fim ${dataFim})` };
  }

  return { valido: true };
}
