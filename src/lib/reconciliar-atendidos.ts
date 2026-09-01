export type OrigemCandidatoReconciliacao = "q1" | "q2" | "q3" | "q4" | "q5";

export type CandidatoReconciliacao = {
  id: number;
  permitirSemNf: boolean;
  origem: OrigemCandidatoReconciliacao;
  dataPedido: string | null;
};

export function construirUrlsConsultasMl(
  baseUrl: string,
  lojaMlId: string,
  dataInicial: string,
  dataFinal: string,
): { q1: string; q2: string; q4: string } {
  const construir = (situacao?: number) => {
    const params = new URLSearchParams({
      idLoja: lojaMlId,
      limite: "50",
      pagina: "1",
      dataInicial,
      dataFinal,
    });
    if (situacao != null) params.set("idSituacao", String(situacao));
    return `${baseUrl}?${params}`;
  };

  return { q1: construir(9), q2: construir(), q4: construir(15) };
}

const prioridadePorOrigem: Record<OrigemCandidatoReconciliacao, number> = {
  q1: 3,
  q5: 3,
  q4: 2,
  q2: 1,
  q3: 0,
};

export function agregarCandidatosReconciliacao(candidatos: CandidatoReconciliacao[]): CandidatoReconciliacao[] {
  const porId = new Map<number, CandidatoReconciliacao[]>();
  for (const candidato of candidatos) {
    porId.set(candidato.id, [...(porId.get(candidato.id) ?? []), candidato]);
  }
  return [...porId.values()].map((membros) => {
    const principal = membros.reduce((melhor, candidato) =>
      prioridadePorOrigem[candidato.origem] > prioridadePorOrigem[melhor.origem] ? candidato : melhor,
    );
    const temQ2 = membros.some((candidato) => candidato.origem === "q2");

    return {
      ...principal,
      permitirSemNf: principal.origem === "q1" ? principal.permitirSemNf || temQ2 : principal.permitirSemNf,
    };
  });
}

export function planejarInspecoesReconciliacao(
  candidatos: CandidatoReconciliacao[],
  limite: number,
  deslocamentoQ4: number,
  deslocamentoDemais: number,
): CandidatoReconciliacao[] {
  if (limite <= 0) return [];

  const q4 = candidatos.filter((c) => c.origem === "q4");
  const demais = candidatos.filter((c) => c.origem !== "q4");
  const inicioQ4 = q4.length === 0 ? 0 : deslocamentoQ4 % q4.length;
  const inicioDemais = demais.length === 0 ? 0 : deslocamentoDemais % demais.length;
  const q4Rotacionada = [...q4.slice(inicioQ4), ...q4.slice(0, inicioQ4)];
  const demaisRotacionados = [...demais.slice(inicioDemais), ...demais.slice(0, inicioDemais)];

  // Uma vaga fica para Q1/Q2/Q5 quando houver candidatos dessas fontes; Q4 usa o
  // restante e gira a cada execução, portanto detalhes inválidos não monopolizam a fila.
  const reservaDemais = demais.length > 0 ? 1 : 0;
  const q4Selecionada = q4Rotacionada.slice(0, limite - reservaDemais);
  const demaisSelecionados = demaisRotacionados.slice(0, limite - q4Selecionada.length);
  return [...demaisSelecionados, ...q4Selecionada];
}

function diaCivilBrt(instante: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instante);
  const parte = (tipo: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === tipo)?.value;
  return `${parte("year")}-${parte("month")}-${parte("day")}`;
}

function adicionarDiasCivis(data: string, dias: number): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

export function janelaCivilBrt(instante: Date, dias: number): { inicio: string; fim: string } {
  const fim = diaCivilBrt(instante);
  return { inicio: adicionarDiasCivis(fim, -dias), fim };
}

export function registrarErroConsulta(
  bucket: { erros: string[] },
  detalhes: string[],
  label: string,
  motivo: unknown,
): void {
  const mensagem = `${label} erro ao buscar lista: ${String(motivo)}`;
  bucket.erros.push(mensagem);
  detalhes.push(mensagem);
}
