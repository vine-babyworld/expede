import { createServerFn } from "@tanstack/react-start";

export type SignResult = { signature: string };

export const signQzRequest = createServerFn({ method: "POST" })
  .inputValidator((d: { toSign: string }) => d)
  .handler(async ({ data }): Promise<SignResult> => {
    const pem = process.env.QZ_TRAY_PRIVATE_KEY;
    console.log(
      "[qztray] key present:", !!pem,
      "starts:", pem?.slice(0, 40),
    );
    if (!pem) throw new Error("QZ_TRAY_PRIVATE_KEY não configurado");

    try {
      // Handles both literal \n (stored as escaped in .env) and real newlines
      const normalized = pem.replace(/\\n/g, "\n");
      const base64 = normalized
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s+/g, "");

      const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

      const key = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        der.buffer as ArrayBuffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const bytes = new TextEncoder().encode(data.toSign);
      const sig = await globalThis.crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes);

      let binary = "";
      const sigBytes = new Uint8Array(sig);
      for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
      return { signature: btoa(binary) };
    } catch (err: any) {
      console.error("[qztray sign error]", err.message, err.stack);
      throw err;
    }
  });
