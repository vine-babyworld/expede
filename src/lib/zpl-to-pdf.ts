import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const LABELARY_URL = "https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/";
const PAGE_W = 288; // 4" × 72 pt/in
const PAGE_H = 432; // 6" × 72 pt/in

export async function zplParaPdf(zpl: string): Promise<string> {
  try {
    const body = new URLSearchParams({ file: zpl });
    const res = await fetch(LABELARY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "image/png",
      },
      body: body.toString(),
    });

    if (res.ok && res.headers.get("content-type")?.includes("image")) {
      const pngBytes = new Uint8Array(await res.arrayBuffer());
      const pdfDoc = await PDFDocument.create();
      const pngImage = await pdfDoc.embedPng(pngBytes);
      const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      page.drawImage(pngImage, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
      return await pdfDoc.saveAsBase64();
    }

    console.warn(
      "[zplParaPdf] Labelary retornou status",
      res.status,
      res.headers.get("content-type"),
    );
  } catch (err) {
    console.warn("[zplParaPdf] Labelary indisponível, usando fallback:", err);
  }

  // Fallback: ZPL em texto monoespaçado para ao menos preservar o conteúdo
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const lines = zpl.split("\n").slice(0, 45);
  let y = PAGE_H - 10;
  for (const line of lines) {
    if (y < 4) break;
    page.drawText(line.substring(0, 48), { x: 4, y, size: 7, font, color: rgb(0, 0, 0) });
    y -= 9;
  }
  return await pdfDoc.saveAsBase64();
}
