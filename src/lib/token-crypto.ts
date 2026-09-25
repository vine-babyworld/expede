/**
 * Cifra de tokens OAuth em repouso — AES-256-GCM via Web Crypto API
 * (Cloudflare Workers + browser, sem `node:*`).
 *
 * Extraído de `bling.functions.ts` sem alteração de comportamento, para que a
 * conexão do Magalu use a mesma cifra em vez de guardar token em texto puro
 * como `shopee_connections` e `ml_connections` fazem.
 *
 * Formato gravado na coluna `bytea`: `\x` + hex de `[IV de 12 bytes][ciphertext
 * + authTag de 16 bytes, concatenados pelo WebCrypto]`.
 *
 * A chave é a mesma do Bling (`BLING_ENCRYPTION_KEY`), de propósito: é um
 * segredo que já existe no Worker, e IVs aleatórios por registro tornam o
 * compartilhamento seguro. Nada de variável nova com precedência — se uma
 * segunda chave entrasse aqui e divergisse, os tokens do Bling que já estão
 * gravados parariam de decriptar em produção.
 */

async function getCryptoKey(): Promise<CryptoKey> {
  const raw = process.env.BLING_ENCRYPTION_KEY;
  if (!raw) throw new Error("BLING_ENCRYPTION_KEY não configurado");
  const enc = new TextEncoder();
  const hash = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(raw));
  return globalThis.crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function encryptToken(plain: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  const ct = new Uint8Array(ctBuf);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return "\\x" + bytesToHex(out);
}

export async function decryptToken(buf: Uint8Array | string): Promise<string> {
  const key = await getCryptoKey();
  let b: Uint8Array;
  if (typeof buf === "string") {
    const hex = buf.startsWith("\\x") ? buf.slice(2) : buf;
    b = hexToBytes(hex);
  } else {
    b = buf;
  }
  // Copia para ArrayBuffer próprio para satisfazer BufferSource estrito.
  const iv = b.slice(0, 12);
  const ct = b.slice(12);
  const pt = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
