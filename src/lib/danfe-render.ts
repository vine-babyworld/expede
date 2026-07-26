import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DANFE_LOGO_PNG_BASE64 } from "@/lib/danfe-logo";

const REMETENTE_NOME = "MP BABY STORE COMERCIO EIRELI";
const REMETENTE_CNPJ = "38.173.755/0001-60";
const REMETENTE_IE = "129.527.249.115";
const REMETENTE_UF = "SP";

// 10cm × 15cm em pontos (1pt ≈ 0.3528mm)
const W = 283.46;
const H = 425.2;
const MARGIN = 10;
const USABLE_W = W - 2 * MARGIN;

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

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Quebra de texto (sem "…") ─────────────────────────────────────────────
// Quebra em palavras; se uma única "palavra" não couber sozinha na largura
// (ex.: SKU longo sem espaços), quebra por caractere. Nunca corta com reticências.
function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];

  const breakLongWord = (word: string): string => {
    let chunk = "";
    for (const ch of word) {
      const test = chunk + ch;
      if (chunk && font.widthOfTextAtSize(test, size) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk = test;
      }
    }
    return chunk;
  };

  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      current = test;
      continue;
    }
    if (current) lines.push(current);
    current =
      font.widthOfTextAtSize(word, size) > maxWidth ? breakLongWord(word) : word;
  }
  if (current) lines.push(current);
  return lines;
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
  page: PDFPage,
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

export type DanfeItem = { sku: string | null; descricao: string; quantidade: number };

export type DanfeInput = {
  nfNumero: string;
  dataPedido: string | null;
  chaveAcesso: string;
  nomeCliente: string;
  docCliente: string;
  ufCliente: string;
  numeroLoja: string;
  itens: DanfeItem[];
};

const ITEM_FONT_SIZES = [6.5, 6, 5.5, 5, 4.5, 4];
const ITEM_LINE_GAP = 1.7;
const ITEM_CONT_INDENT = 6; // recuo das linhas de continuação (hanging indent)

export async function renderDanfePdf(input: DanfeInput): Promise<Uint8Array> {
  const {
    nfNumero,
    dataPedido,
    chaveAcesso,
    nomeCliente,
    docCliente,
    ufCliente,
    numeroLoja,
    itens,
  } = input;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([W, H]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImage = await pdfDoc.embedPng(base64ToUint8(DANFE_LOGO_PNG_BASE64));

  const write = (text: string, x: number, y: number, size = 7, bold = false) =>
    page.drawText(String(text), { x, y, size, font: bold ? fontBold : font, color: rgb(0, 0, 0) });

  const centerText = (text: string, y: number, size = 7, bold = false) => {
    const width = (bold ? fontBold : font).widthOfTextAtSize(text, size);
    write(text, MARGIN + (USABLE_W - width) / 2, y, size, bold);
  };

  const writeWrapped = (
    text: string,
    x: number,
    y: number,
    size: number,
    maxWidth: number,
    bold = false,
    lineHeight = size + 2,
  ): number => {
    const lines = wrapText(bold ? fontBold : font, text, size, maxWidth);
    for (const line of lines) {
      write(line, x, y, size, bold);
      y -= lineHeight;
    }
    return y;
  };

  const hline = (yPos: number) =>
    page.drawLine({
      start: { x: MARGIN, y: yPos },
      end: { x: W - MARGIN, y: yPos },
      thickness: 0.4,
      color: rgb(0.6, 0.6, 0.6),
    });

  let y = H - MARGIN - 2;

  // ── Cabeçalho: logo + título centralizado ──────────────────────────────
  const LOGO_SIZE = 36;
  const logoDims = logoImage.scale(LOGO_SIZE / logoImage.width);
  page.drawImage(logoImage, {
    x: MARGIN,
    y: y - LOGO_SIZE,
    width: logoDims.width,
    height: logoDims.height,
  });
  centerText("DANFE SIMPLIFICADO", y - 12, 9, true);
  centerText(REMETENTE_NOME, y - 22, 6, true);
  y -= LOGO_SIZE + 4;

  centerText(
    `Número ${nfNumero || "—"} / Série 1   Emissão: ${formatDate(dataPedido)}`,
    y, 6.5,
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
    const modW = USABLE_W / code128CModules(chaveAcesso.replace(/\D/g, "").length);
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
  const nomeDisplay = cleanNome(nomeCliente) || "—";
  y = writeWrapped(nomeDisplay, MARGIN, y, 6.5, USABLE_W, false, 8);
  write(`CNPJ/CPF: ${docCliente}   UF: ${ufCliente}`, MARGIN, y, 5.5);
  y -= 7;
  hline(y);
  y -= 10;

  // ── Produtos (com fonte adaptativa — nunca corta nem trunca) ───────────
  write("PRODUTOS:", MARGIN, y, 6.5, true);
  y -= 9;

  const produtosTopY = y;

  // Reserva o espaço do rodapé (dados adicionais + código de barras) ANTES
  // de decidir o tamanho da fonte dos itens, para garantir que tudo caiba
  // numa única etiqueta sem sobrepor nem cortar conteúdo.
  const quemRecebeLines = wrapText(font, `QUEM RECEBE: ${nomeDisplay}`, 6, USABLE_W);
  const footerH =
    9 /* "DADOS ADICIONAIS:" */ +
    8 /* CANAL */ +
    8 /* NUMERO PEDIDO LOJA */ +
    quemRecebeLines.length * 7.5 +
    36 /* código de barras inferior + margem */;
  const itemsBottomY = MARGIN + footerH;
  const availableItemsHeight = produtosTopY - itemsBottomY;

  const buildItemLines = (size: number) =>
    itens.map((item) => {
      const qtd = Number(item.quantidade ?? 1);
      const sku = item.sku ?? "—";
      const desc = String(item.descricao ?? "").trim();
      return wrapText(font, `${qtd}x — ${sku} — ${desc}`, size, USABLE_W);
    });

  let chosenSize = ITEM_FONT_SIZES[ITEM_FONT_SIZES.length - 1];
  let chosenLines = buildItemLines(chosenSize);
  for (const size of ITEM_FONT_SIZES) {
    const lines = buildItemLines(size);
    const totalLines = lines.reduce((acc, l) => acc + l.length, 0);
    if (totalLines * (size + ITEM_LINE_GAP) <= availableItemsHeight) {
      chosenSize = size;
      chosenLines = lines;
      break;
    }
    chosenLines = lines; // mantém o menor tamanho testado como fallback
  }

  const lineH = chosenSize + ITEM_LINE_GAP;
  let itemsY = produtosTopY;
  let itemsRendered = 0;
  for (let i = 0; i < chosenLines.length; i++) {
    const lines = chosenLines[i];
    // Garante que o item inteiro (todas as linhas) caiba antes de começar a desenhá-lo.
    if (itemsY - lines.length * lineH < itemsBottomY) break;
    for (let li = 0; li < lines.length; li++) {
      write(lines[li], li === 0 ? MARGIN : MARGIN + ITEM_CONT_INDENT, itemsY, chosenSize);
      itemsY -= lineH;
    }
    itemsRendered++;
  }
  if (itemsRendered < itens.length) {
    const restantes = itens.length - itemsRendered;
    write(
      `+ ${restantes} ${restantes === 1 ? "item adicional" : "itens adicionais"} — ver pedido completo`,
      MARGIN, itemsY, Math.max(chosenSize - 0.5, 4), true,
    );
    itemsY -= lineH;
  }

  y = itemsBottomY;
  hline(y);
  y -= 10;

  // ── Dados adicionais ──────────────────────────────────────────────────
  write("DADOS ADICIONAIS:", MARGIN, y, 6.5, true);
  y -= 9;
  write("CANAL: Mercado Livre", MARGIN, y, 6);
  y -= 8;
  write(`NÚMERO PEDIDO LOJA: ${numeroLoja || "—"}`, MARGIN, y, 6);
  y -= 8;
  y = writeWrapped(`QUEM RECEBE: ${nomeDisplay}`, MARGIN, y, 6, USABLE_W, false, 7.5);

  // ── Código de barras inferior (número do pedido no canal) ─────────────
  const barcodesY = MARGIN + 8;
  if (numeroLoja && /^\d+$/.test(numeroLoja)) {
    const barH = 22;
    const modW = USABLE_W / code128CModules(numeroLoja.length);
    drawCode128C(page, numeroLoja, MARGIN, barcodesY, modW, barH);
    const labelWidth = fontBold.widthOfTextAtSize(numeroLoja, 7);
    write(numeroLoja, MARGIN + USABLE_W / 2 - labelWidth / 2, barcodesY - 9, 7, true);
  } else if (numeroLoja) {
    // fallback: número em texto grande estilo Code39
    write(`*${numeroLoja}*`, MARGIN, barcodesY, 10, true);
  }

  return pdfDoc.save();
}
