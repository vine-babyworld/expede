// Server-only AES-256-GCM encryption helpers for Bling tokens.
// Tokens are stored as bytea: [12-byte IV][16-byte authTag][ciphertext].
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function getKey(): Buffer {
  const raw = process.env.BLING_ENCRYPTION_KEY;
  if (!raw) throw new Error("BLING_ENCRYPTION_KEY não configurado");
  // Aceita qualquer comprimento — derivamos 32 bytes via SHA-256.
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptToken(plain: string): Buffer {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptToken(buf: Buffer | Uint8Array | string): string {
  const key = getKey();
  let b: Buffer;
  if (typeof buf === "string") {
    // Supabase retorna bytea como string "\\x...."
    const hex = buf.startsWith("\\x") ? buf.slice(2) : buf;
    b = Buffer.from(hex, "hex");
  } else {
    b = Buffer.from(buf);
  }
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ct = b.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
