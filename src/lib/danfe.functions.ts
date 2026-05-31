import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const REMETENTE_NOME = "MP BABY STORE COMERCIO EIRELI";
const REMETENTE_CNPJ = "38.173.755/0001-60";
const REMETENTE_IE = "129.527.249.115";
const REMETENTE_UF = "SP";

// 10cm x 15cm em pontos (1pt = 0.352777mm)
const W = 283.46;
const H = 425.2;
const MARGIN = 10;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR");
}

function formatChave(chave: string): string {
  // Grupos de 4 dígitos com espaço
  return chave.replace(/(.{4})(?=.)/g, "$1 ").trim();
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export type DanfeResult = { ok: true; pdf: string } | { ok: false; error: string };

export const gerarDanfeCustom = createServerFn({ method: "POST" })
  .inputValidator((d: { pedidoId: string }) => d)
  .handler(async ({ data }): Promise<DanfeResult> => {
    const { data: pedido, error: pedErr } = await supabaseAdmin
      .from("pedidos")
      .select(
        "id, numero, data_pedido, bling_nota_fiscal_numero, raw_json, cliente, pedido_itens(id, sku, ean, descricao, quantidade)",
      )
      .eq("id", data.pedidoId)
      .single();

    if (pedErr || !pedido) return { ok: false, error: "pedido_not_found" };

    const raw: any = pedido.raw_json ?? {};
    const chaveAcesso: string = raw?.notaFiscal?.chaveAcesso ?? "";
    console.log("[danfe] notaFiscal fields:", JSON.stringify(raw?.notaFiscal));

    const cliente: any = pedido.cliente ?? {};
    const nomeCliente = cliente?.nome ?? cliente?.razaoSocial ?? "—";
    const ufCliente = cliente?.endereco?.uf ?? cliente?.uf ?? "—";

    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const write = (text: string, x: number, y: number, size = 7, bold = false) =>
      page.drawText(String(text), {
        x,
        y,
        size,
        font: bold ? fontBold : font,
        color: rgb(0, 0, 0),
      });

    const hline = (y: number) =>
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: W - MARGIN, y },
        thickness: 0.4,
        color: rgb(0.6, 0.6, 0.6),
      });

    let y = H - MARGIN - 2;

    // Cabeçalho
    write("DANFE SIMPLIFICADO", MARGIN, y, 9, true);
    y -= 13;
    write(
      `NF nº ${pedido.bling_nota_fiscal_numero ?? "—"}   Série 1   Emissão: ${formatDate(pedido.data_pedido)}`,
      MARGIN, y, 6.5,
    );
    y -= 6;
    hline(y);
    y -= 11;

    // Chave de acesso
    write("Chave de Acesso:", MARGIN, y, 6.5, true);
    y -= 10;
    if (chaveAcesso) {
      const formatted = formatChave(chaveAcesso);
      // Divide em duas linhas para caber na largura
      const half = Math.ceil(formatted.length / 2);
      write(formatted.slice(0, half).trim(), MARGIN, y, 5.5);
      y -= 8;
      write(formatted.slice(half).trim(), MARGIN, y, 5.5);
    } else {
      write("(não disponível)", MARGIN, y, 6);
    }
    y -= 7;
    hline(y);
    y -= 11;

    // Remetente
    write("REMETENTE:", MARGIN, y, 6.5, true);
    y -= 10;
    write(REMETENTE_NOME, MARGIN, y, 6.5);
    y -= 9;
    write(`CNPJ: ${REMETENTE_CNPJ}   IE: ${REMETENTE_IE}   UF: ${REMETENTE_UF}`, MARGIN, y, 5.5);
    y -= 7;
    hline(y);
    y -= 11;

    // Destinatário
    write("DESTINATÁRIO:", MARGIN, y, 6.5, true);
    y -= 10;
    const maxNameChars = 42;
    const nomeDisplay =
      nomeCliente.length > maxNameChars
        ? nomeCliente.slice(0, maxNameChars - 1) + "…"
        : nomeCliente;
    write(nomeDisplay, MARGIN, y, 6.5);
    y -= 9;
    write(`UF: ${ufCliente}`, MARGIN, y, 6.5);
    y -= 7;
    hline(y);
    y -= 11;

    // Produtos
    write("PRODUTOS:", MARGIN, y, 6.5, true);
    y -= 10;

    const itens: any[] = (pedido as any).pedido_itens ?? [];
    for (const item of itens) {
      if (y < MARGIN + 10) break;
      const sku = item.sku ?? "—";
      const desc = String(item.descricao ?? "");
      const maxDesc = 30;
      const descDisplay = desc.length > maxDesc ? desc.slice(0, maxDesc - 1) + "…" : desc;
      const qtd = Number(item.quantidade ?? 1);
      write(`${sku} - ${descDisplay}`, MARGIN, y, 6);
      write(`Qtd: ${qtd}`, W - MARGIN - 38, y, 6);
      y -= 9;
    }

    const pdfBytes = await doc.save();
    return { ok: true, pdf: uint8ToBase64(pdfBytes) };
  });
