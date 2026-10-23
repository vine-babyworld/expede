import { supabase } from "@/integrations/supabase/client";

/**
 * Estoque físico de peças automotivas (Rufato) — menu "Peças de Carro".
 * Cadastro manual; o sistema só avisa, não dá baixa sozinho.
 * Tabela e RPC: supabase/migrations/20261023120000_pecas-estoque.sql.
 */

export interface PecaEstoque {
  id: string;
  sku: string;
  nome: string;
  quantidade: number;
  localizacao: string | null;
  updated_at: string;
}

export interface PedidoComPeca {
  pedido_id: string;
  numero: string | null;
  numero_loja: string | null;
  marketplace: string | null;
  data_pedido: string | null;
  sku: string;
  descricao: string | null;
  quantidade_pedido: number;
  peca_id: string;
  peca_nome: string;
  peca_quantidade: number;
  localizacao: string | null;
}

export const PECAS_ESTOQUE_KEY = ["pecas-estoque"] as const;
export const PEDIDOS_COM_PECA_KEY = ["pedidos-com-peca-em-estoque"] as const;

export async function fetchPecasEstoque(): Promise<PecaEstoque[]> {
  const { data, error } = await supabase
    .from("pecas_estoque")
    .select("id, sku, nome, quantidade, localizacao, updated_at")
    .order("nome", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Pedidos a expedir que vendem um SKU com saldo no estoque de peças (uma linha por item). */
export async function fetchPedidosComPeca(): Promise<PedidoComPeca[]> {
  const { data, error } = await supabase.rpc("pedidos_com_peca_em_estoque");
  if (error) throw error;
  return (data ?? []) as PedidoComPeca[];
}

/** Quantos pedidos distintos acendem o aviso — é o número do selo no menu. */
export function contarPedidos(linhas: PedidoComPeca[]): number {
  return new Set(linhas.map((l) => l.pedido_id)).size;
}

export interface PecaInput {
  sku: string;
  nome: string;
  quantidade: number;
  localizacao: string | null;
}

function traduzirErro(error: { code?: string; message: string }): Error {
  if (error.code === "23505") return new Error("Já existe uma peça cadastrada com esse SKU");
  return new Error(error.message);
}

export async function salvarPeca(id: string | null, input: PecaInput): Promise<void> {
  const { error } = id
    ? await supabase.from("pecas_estoque").update(input).eq("id", id)
    : await supabase.from("pecas_estoque").insert(input);
  if (error) throw traduzirErro(error);
}

export async function excluirPeca(id: string): Promise<void> {
  const { error } = await supabase.from("pecas_estoque").delete().eq("id", id);
  if (error) throw traduzirErro(error);
}
