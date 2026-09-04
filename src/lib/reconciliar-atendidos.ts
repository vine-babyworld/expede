export type OrigemCandidatoReconciliacao = "q1" | "q2" | "q3" | "q4" | "q5" | "q6";

export type CandidatoReconciliacao = {
  id: number;
  permitirSemNf: boolean;
  origem: OrigemCandidatoReconciliacao;
  dataPedido: string | null;
  /**
   * Só Q6 preenche: como ela varre as duas lojas numa consulta por loja, o
   * marketplace não pode ser deduzido da origem (como acontece com Q5=Shopee).
   */
  marketplace?: "mercadolivre" | "shopee";
};

export async function executarConsultasEmLotes<T>(
  tarefas: Array<() => Promise<T>>,
  limitePorLote: number,
  intervaloMs: number,
  esperar: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Array<PromiseSettledResult<T>>> {
  if (!Number.isInteger(limitePorLote) || limitePorLote <= 0) {
    throw new Error("limitePorLote deve ser um inteiro positivo");
  }

  const resultados: Array<PromiseSettledResult<T>> = [];
  for (let inicio = 0; inicio < tarefas.length; inicio += limitePorLote) {
    if (inicio > 0) await esperar(intervaloMs);
    const lote = tarefas.slice(inicio, inicio + limitePorLote);
    resultados.push(...await Promise.allSettled(lote.map((tarefa) => tarefa())));
  }
  return resultados;
}

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

/**
 * Q6 — rede de segurança para pedido faturado muito depois de ter sido feito.
 *
 * Q1/Q2/Q4/Q5 filtram por `dataInicial`/`dataFinal`, que é a data do PEDIDO. Um
 * pedido só entra na expedição quando é faturado, e o faturamento pode acontecer
 * semanas depois — nesse ponto o pedido já saiu da janela e nenhuma consulta
 * volta a enxergá-lo. Foi assim que o pedido 9137 (numeroLoja 2000018004864372,
 * feito em 18/08, faturado em 03/09) ficou permanentemente fora do EXPEDE: o
 * webhook do Bling era o único caminho e não chegou.
 *
 * `dataAlteracao*` filtra por quando o pedido MUDOU, então pega exatamente esse
 * caso, independente de quão antigo ele seja.
 */
export function construirUrlConsultaAlterados(
  baseUrl: string,
  lojaId: string,
  dataAlteracaoInicial: string,
  dataAlteracaoFinal: string,
): string {
  const params = new URLSearchParams({
    idLoja: lojaId,
    limite: "100",
    pagina: "1",
    dataAlteracaoInicial,
    dataAlteracaoFinal,
  });
  return `${baseUrl}?${params}`;
}

/**
 * Freio do Q6: como a busca por alteração não tem piso de data do pedido, ela
 * enxerga pedidos de meses atrás que foram tocados por qualquer motivo. Sem esse
 * horizonte, uma edição trivial num pedido velho o despejaria em "A expedir".
 */
export function pedidoDentroDoHorizonteAlteracao(
  dataPedido: string | null | undefined,
  pisoDataPedido: string,
): boolean {
  if (typeof dataPedido !== "string") return false;
  const dia = dataPedido.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false;
  return dia >= pisoDataPedido;
}

/**
 * A API do Bling ACEITA `?numeroLoja=` em pedidos/vendas e IGNORA o filtro:
 * verificado em 04/09/2026, pedir numeroLoja=2000018004864372 devolveu os 10
 * pedidos mais recentes da conta, nenhum deles o solicitado. Quem pegar
 * `lista[0]` importa o pedido errado — por isso a conferência é obrigatória do
 * lado do cliente, e não achar é um resultado legítimo.
 */
export function encontrarPedidoPorNumeroLoja<T extends { numeroLoja?: unknown }>(
  lista: T[],
  numeroLoja: string,
): T | null {
  return lista.find((p) => String(p.numeroLoja ?? "") === numeroLoja) ?? null;
}

const prioridadePorOrigem: Record<OrigemCandidatoReconciliacao, number> = {
  q1: 3,
  q5: 3,
  q4: 2,
  q2: 1,
  q3: 0,
  // Q6 é a rede de segurança mais ampla e a mais conservadora (só importa com NF):
  // fica abaixo de todas para nunca rebaixar o permitirSemNf de uma fonte específica.
  q6: 0,
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
