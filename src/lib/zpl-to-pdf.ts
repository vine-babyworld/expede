// Converte ZPL → PDF via Labelary (8dpmm, 4x6 polegadas).
// Nunca cai em fallback de texto — se Labelary falhar, lança erro.

const LABELARY_URL = "https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/";

// Converte Uint8Array para base64 em chunks para evitar stack overflow em PDFs grandes.
function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    for (let j = i; j < end; j++) binary += String.fromCharCode(bytes[j]);
  }
  return btoa(binary);
}

// Retorna base64 do PDF renderizado.
// Lança Error se Labelary falhar — o caller decide o que fazer.
export async function zplParaPdf(zpl: string): Promise<string> {
  // TODO: ler ^PW e ^LL do ZPL para calcular width/height reais em polegadas
  const formData = new FormData();
  formData.append("file", new Blob([zpl], { type: "text/plain" }), "label.zpl");

  const res = await fetch(LABELARY_URL, {
    method: "POST",
    headers: { Accept: "application/pdf" },
    body: formData,
  });

  const warnings = res.headers.get("X-Warnings") ?? "";

  if (!res.ok) {
    console.error(`[zplParaPdf] Labelary ${res.status}`, warnings || "(sem X-Warnings)");
    throw new Error(`Labelary erro ${res.status}${warnings ? `: ${warnings}` : ""}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("pdf")) {
    console.warn("[zplParaPdf] content-type inesperado:", ct, warnings || "");
    throw new Error(`Labelary retornou tipo inválido: ${ct}`);
  }

  if (warnings) console.warn("[zplParaPdf] X-Warnings:", warnings);

  const bytes = new Uint8Array(await res.arrayBuffer());
  return uint8ToBase64(bytes);
}

// Abre o ZPL renderizado como PDF numa nova aba do browser.
export async function abrirEtiquetaPDF(zpl: string): Promise<void> {
  const base64 = await zplParaPdf(zpl);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (win) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
