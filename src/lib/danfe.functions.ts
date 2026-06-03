import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDecryptedAccessToken } from "@/lib/bling.functions";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const REMETENTE_NOME = "MP BABY STORE COMERCIO EIRELI";
const REMETENTE_CNPJ = "38.173.755/0001-60";
const REMETENTE_IE = "129.527.249.115";
const REMETENTE_UF = "SP";

// 10cm × 15cm em pontos (1pt ≈ 0.3528mm)
const W = 283.46;
const H = 425.2;
const MARGIN = 10;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR");
}

function formatChave(chave: string): string {
  return chave.replace(/(.{4})(?=.)/g, "$1 ").trim();
}

function cleanNome(nome: string): string {
  // Remove "(username)" no final: "Fulano da Silva (fulano123)" → "Fulano da Silva"
  return nome.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Code128C ────────────────────────────────────────────────────────────────
// Cada símbolo: [b1,s1,b2,s2,b3,s3] — larguras de módulo, começa com barra
// Valores 0-99 = dados (pares de dígitos), 105 = Start C, stop separado
const C128: number[][] = [
  [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],
  [1,2,1,3,2,2],[1,3,1,2,2,2],[1,2,2,2,1,3],[1,2,2,3,1,2],
  [1,3,2,2,1,2],[2,2,1,2,1,3],[2,2,1,3,1,2],[2,3,1,2,1,2],
  [1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],[1,1,3,2,2,2],
  [1,2,3,1,2,2],[1,2,3,2,2,1],[2,2,3,2,1,1],[2,2,1,1,3,2],
  [2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],
  [3,1,1,2,2,2],[3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],
  [3,2,2,1,1,2],[3,2,2,2,1,1],[2,1,2,1,2,3],[2,1,2,3,2,1],
  [2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],[1,3,1,3,2,1],
  [1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],
  [2,3,1,1,1,3],[2,3,1,3,1,1],[1,1,2,1,3,3],[1,1,2,3,3,1],
  [1,3,2,1,3,1],[1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],
  [3,1,3,1,2,1],[2,1,1,3,3,1],[2,3,1,1,3,1],[2,1,3,1,1,3],
  [2,1,3,3,1,1],[2,1,3,1,3,1],[3,1,1,1,2,3],[3,1,1,3,2,1],
  [3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],
  [3,1,4,1,1,1],[2,2,1,4,1,1],[4,3,1,1,1,1],[1,1,1,2,2,4],
  [1,1,1,4,2,2],[1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],
  [1,4,1,2,2,1],[1,1,2,2,1,4],[1,1,2,4,1,2],[1,2,2,1,1,4],
  [1,2,2,4,1,1],[1,4,2,1,1,2],[1,4,2,2,1,1],[2,4,1,2,1,1],
  [2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
  [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],
  [1,2,4,1,1,2],[1,2,4,2,1,1],[4,1,1,2,1,2],[4,2,1,1,1,2],
  [4,2,1,2,1,1],[2,1,2,1,4,1],[2,1,4,1,2,1],[4,1,2,1,2,1],
  [1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],[1,1,4,1,1,3],
  [1,1,4,3,1,1],[4,1,1,1,1,3],[4,1,1,3,1,1],[1,1,3,1,4,1],
  // 100=CodeA 101=CodeB 102=FNC1 103=StartA 104=StartB 105=StartC
  [1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],
  [2,1,1,4,1,2],[2,1,1,2,1,4],[2,1,1,2,3,2],
];
const C128_STOP = [2,3,3,1,1,1,2]; // 13 módulos

function drawCode128C(
  page: ReturnType<PDFDocument["addPage"]>,
  digits: string,
  x: number,
  y: number,
  moduleW: number,
  barH: number,
) {
  const d = digits.replace(/\D/g, "");
  const padded = d.length % 2 !== 0 ? "0" + d : d;
  const data: number[] = [];
  for (let i = 0; i < padded.length; i += 2)
    data.push(parseInt(padded.slice(i, i + 2), 10));

  let check = 105;
  for (let i = 0; i < data.length; i++) check += (i + 1) * data[i];
  check = check % 103;

  let cx = x;
  const drawPat = (pat: number[]) => {
    let dark = true;
    for (const w of pat) {
      if (dark)
        page.drawRectangle({ x: cx, y, width: w * moduleW, height: barH, color: rgb(0, 0, 0) });
      cx += w * moduleW;
      dark = !dark;
    }
  };

  for (const v of [105, ...data, check]) drawPat(C128[v]);
  drawPat(C128_STOP);
}

function code128CModules(numDigits: number): number {
  const pairs = Math.ceil(numDigits / 2);
  return (pairs + 2) * 11 + 13; // (data+start+check)*11 + stop(13)
}

// ────────────────────────────────────────────────────────────────────────────

export type DanfeResult = { ok: true; pdf: string } | { ok: false; error: string };

export const gerarDanfeCustom = createServerFn({ method: "POST" })
  .inputValidator((d: { pedidoId: string }) => d)
  .handler(async ({ data }): Promise<DanfeResult> => {
    const { data: pedido, error: pedErr } = await supabaseAdmin
      .from("pedidos")
      .select(
        "id, numero, numero_loja, data_pedido, bling_nota_fiscal_id, bling_nota_fiscal_numero, raw_json, pedido_itens(id, sku, descricao, quantidade)",
      )
      .eq("id", data.pedidoId)
      .single();

    if (pedErr || !pedido) return { ok: false, error: "pedido_not_found" };

    const raw: any = pedido.raw_json ?? {};

    // ── Busca NF na API Bling ──────────────────────────────────────────────
    let chaveAcesso = "";
    let nfNumero: string = (pedido as any).bling_nota_fiscal_numero ?? "";

    if ((pedido as any).bling_nota_fiscal_id) {
      try {
        const { data: conn } = await supabaseAdmin
          .from("bling_connections")
          .select("id")
          .eq("status", "connected")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (conn) {
          const token = await getDecryptedAccessToken(conn.id);
          const nfRes = await fetch(
            `https://api.bling.com.br/Api/v3/nfe`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
          );
          if (nfRes.ok) {
            const nfJson: any = await nfRes.json().catch(() => null);
            const nf = nfJson?.data?.find(
              (n: any) => n.id === (pedido as any).bling_nota_fiscal_id,
            );
            chaveAcesso = nf?.chaveAcesso ?? "";
            nfNumero = String(nf?.numero ?? nfNumero);
            console.log("[danfe] NF Bling ok — chave:", !!chaveAcesso, "numero:", nfNumero);
          } else {
            console.warn("[danfe] NF Bling erro HTTP:", nfRes.status);
          }
        }
      } catch (err) {
        console.warn("[danfe] erro ao buscar NF Bling:", err);
      }
    }

    // ── Dados do destinatário ─────────────────────────────────────────────
    const contato: any = raw?.contato ?? {};
    const nomeCliente = cleanNome(contato?.nome ?? "") || "—";
    const docCliente = contato?.numeroDocumento ?? "—";
    const ufCliente = raw?.transporte?.etiqueta?.uf ?? contato?.endereco?.uf ?? "—";
    const numeroLoja: string = (pedido as any).numero_loja ?? "";

    // ── Monta PDF ─────────────────────────────────────────────────────────
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([W, H]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const write = (text: string, x: number, y: number, size = 7, bold = false) =>
      page.drawText(String(text), { x, y, size, font: bold ? fontBold : font, color: rgb(0, 0, 0) });

    const hline = (yPos: number) =>
      page.drawLine({
        start: { x: MARGIN, y: yPos },
        end: { x: W - MARGIN, y: yPos },
        thickness: 0.4,
        color: rgb(0.6, 0.6, 0.6),
      });

    const usableW = W - 2 * MARGIN;
    let y = H - MARGIN - 2;

    // ── Cabeçalho ─────────────────────────────────────────────────────────
    write("DANFE SIMPLIFICADO", MARGIN, y, 9, true);
    y -= 12;
    write(
      `Numero ${nfNumero || "—"} / Serie 1   Emissão: ${formatDate((pedido as any).data_pedido)}`,
      MARGIN, y, 6.5,
    );
    y -= 7;
    hline(y);
    y -= 10;

    // ── Chave de acesso ───────────────────────────────────────────────────
    write("Chave de Acesso:", MARGIN, y, 6.5, true);
    y -= 9;
    if (chaveAcesso) {
      const fmt = formatChave(chaveAcesso);
      const half = Math.ceil(fmt.length / 2);
      write(fmt.slice(0, half).trim(), MARGIN, y, 5.5);
      y -= 7;
      write(fmt.slice(half).trim(), MARGIN, y, 5.5);
      y -= 9;
      // Código de barras Code128C da chave (44 dígitos numéricos)
      const barH = 18;
      const modW = usableW / code128CModules(chaveAcesso.replace(/\D/g, "").length);
      drawCode128C(page, chaveAcesso, MARGIN, y - barH, modW, barH);
      y -= barH + 4;
    } else {
      write("(chave não disponível — verifique NF no Bling)", MARGIN, y, 6);
      y -= 9;
    }
    hline(y);
    y -= 10;

    // ── Emitente ──────────────────────────────────────────────────────────
    write("EMITENTE:", MARGIN, y, 6.5, true);
    y -= 9;
    write(REMETENTE_NOME, MARGIN, y, 6.5);
    y -= 8;
    write(`CNPJ: ${REMETENTE_CNPJ}   IE: ${REMETENTE_IE}   UF: ${REMETENTE_UF}`, MARGIN, y, 5.5);
    y -= 7;
    hline(y);
    y -= 10;

    // ── Destinatário ──────────────────────────────────────────────────────
    write("DESTINATÁRIO:", MARGIN, y, 6.5, true);
    y -= 9;
    const maxNameChars = 42;
    const nomeDisplay =
      nomeCliente.length > maxNameChars
        ? nomeCliente.slice(0, maxNameChars - 1) + "…"
        : nomeCliente;
    write(nomeDisplay, MARGIN, y, 6.5);
    y -= 8;
    write(`CNPJ/CPF: ${docCliente}   UF: ${ufCliente}`, MARGIN, y, 5.5);
    y -= 7;
    hline(y);
    y -= 10;

    // ── Produtos ──────────────────────────────────────────────────────────
    write("PRODUTOS:", MARGIN, y, 6.5, true);
    y -= 9;

    const itens: any[] = (pedido as any).pedido_itens ?? [];
    for (const item of itens) {
      if (y < MARGIN + 95) break; // reserva espaço para dados adicionais + barcode
      const sku = item.sku ?? "—";
      const desc = String(item.descricao ?? "");
      const maxDesc = 28;
      const descDisplay = desc.length > maxDesc ? desc.slice(0, maxDesc - 1) + "…" : desc;
      const qtd = Number(item.quantidade ?? 1);
      write(`${qtd}x — ${sku} — ${descDisplay}`, MARGIN, y, 6);
      y -= 8;
    }

    hline(y);
    y -= 10;

    // ── Dados adicionais ──────────────────────────────────────────────────
    write("DADOS ADICIONAIS:", MARGIN, y, 6.5, true);
    y -= 9;
    write("CANAL: Mercado Livre", MARGIN, y, 6);
    y -= 8;
    write(`NUMERO PEDIDO LOJA: ${numeroLoja || "—"}`, MARGIN, y, 6);
    y -= 8;
    write(`QUEM RECEBE: ${nomeDisplay}`, MARGIN, y, 6);

    // ── Código de barras inferior (número do pedido no canal) ─────────────
    const barcodesY = MARGIN + 30;
    if (numeroLoja && /^\d+$/.test(numeroLoja)) {
      const barH = 22;
      const modW = usableW / code128CModules(numeroLoja.length);
      drawCode128C(page, numeroLoja, MARGIN, barcodesY, modW, barH);
      const labelX = MARGIN + usableW / 2 - (numeroLoja.length * 3.5);
      write(numeroLoja, labelX, barcodesY - 9, 7, true);
    } else if (numeroLoja) {
      // fallback: número em texto grande estilo Code39
      write(`*${numeroLoja}*`, MARGIN, barcodesY, 10, true);
    }

    const pdfBytes = await pdfDoc.save();
    return { ok: true, pdf: uint8ToBase64(pdfBytes) };
  });
