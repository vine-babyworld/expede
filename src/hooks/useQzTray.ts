import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { signQzRequest } from "@/lib/qztray.functions";
import { zplParaPdf, abrirEtiquetaPDF } from "@/lib/zpl-to-pdf";

// Certificado público — pode ser hardcoded no frontend
const QZ_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUPJhNgSQNIlLnSN+tbSGk7wqwXX0wDQYJKoZIhvcNAQEL
BQAwMDEPMA0GA1UEAwwGRVhQRURFMRAwDgYDVQQKDAdNUCBCYWJ5MQswCQYDVQQG
EwJCUjAeFw0yNjA2MDgxODE0MDdaFw0zNjA2MDUxODE0MDdaMDAxDzANBgNVBAMM
BkVYUEVERTEQMA4GA1UECgwHTVAgQmFieTELMAkGA1UEBhMCQlIwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCuzSwoW5QVLZvg/ewYUykBpUMwhr0frk3w
U8E7q5BtbVpGSV0OSKOmB9yfiZ6WbBuBww5HDT/ICa1NgNobFJhZRSuxuSQ3wfKK
pAaA4EuZG5I+T542SmLhXdwVCmbDPCsDccCr3ja13ZkAtw1xOBqB8sqYX6/4akl5
edHhrIoPvZ5V3KEP4Edv4AySb1YJ1C717h3FH2hrVQGqdCGWJc4WqLmacxJZoNfQ
3Vqj+sZIffmupDhjtrLhTQyl4vupxqUbaetXYZKdTHv/GtaWYDbjT/jy2RnTinT6
EcfPFnsVaYidzqOTn82EX6L5KWodg6gfKcfuCS4F9BBR6kQDVC9pAgMBAAGjUzBR
MB0GA1UdDgQWBBQXtfV2PbQpeFc9qyrJ9vid2JJD4TAfBgNVHSMEGDAWgBQXtfV2
PbQpeFc9qyrJ9vid2JJD4TAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCut+Gll8vPkeKAoNkqQVxOcOtj92TWagrB1K8n+bAvYkPvNhhmM0/7G9IU
1glPKXnPvZunXS4hvCwN3leVRnpQ8gOBgYU+WrpRK4+tvSv440h76vF6Nwxcp757
Cxb/oHXW6Y4VCwcpsR5uVeWbxSMyGF96egctQL0RVP91dVOw9BKJNUXpp6/43PQt
PMtBysAkAbPw+ZgVfh2FwnJ+QmxlA1ptjgNFYMiddpSlXYeN9JlskRHI96tBbNsI
9jWlRHo/9ZRGdPpw5Yv1Fe1SKheFTWO+z2Q1AKPvVxC44eI7G5RRdwaNL5JBbLfO
s5yqb7e3yG+dRCWyxatk/+KNLPQK
-----END CERTIFICATE-----`;

export type QzTrayHook = {
  isConectado: boolean;
  conectando: boolean;
  listarImpressoras: () => Promise<string[]>;
  imprimirZpl: (zpl: string, impressora: string) => Promise<void>;
  imprimirPdf: (base64: string, impressora: string) => Promise<void>;
  visualizarEtiqueta: (zpl: string) => Promise<void>;
};

export function useQzTray(): QzTrayHook {
  const [isConectado, setIsConectado] = useState(false);
  const [conectando, setConectando] = useState(false);
  const signFn = useServerFn(signQzRequest);
  const qzRef = useRef<any>(null);
  const initialized = useRef(false);

  const getQz = useCallback(async () => {
    if (!qzRef.current) {
      // Dynamic import to keep qz-tray out of SSR bundle
      const mod = await import("qz-tray");
      qzRef.current = mod.default ?? mod;
    }
    return qzRef.current;
  }, []);

  const conectar = useCallback(async () => {
    const qz = await getQz();
    if (qz.websocket.isActive()) return;
    setConectando(true);
    try {
      qz.security.setCertificatePromise(
        (resolve: (v: string) => void) => resolve(QZ_CERTIFICATE),
      );
      qz.security.setSignatureAlgorithm("SHA512");
      qz.security.setSignaturePromise((toSign: string) => {
        return (resolve: (sig: string) => void, reject: (err: any) => void) => {
          signFn({ data: { toSign } })
            .then((r: any) => resolve(r.signature))
            .catch(reject);
        };
      });
      qz.api.setTrustLevel('local');
      await qz.websocket.connect();
      setIsConectado(true);
      qz.websocket.setClosedCallbacks([(evt: any) => {
        setIsConectado(false);
        if (evt?.reason !== "Closed by client") {
          setTimeout(() => conectar(), 2000);
        }
      }]);
    } catch (err) {
      console.error("[qztray] falha ao conectar:", err);
      setIsConectado(false);
    } finally {
      setConectando(false);
    }
  }, [getQz, signFn]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    conectar();
  }, [conectar]);

  const listarImpressoras = useCallback(async (): Promise<string[]> => {
    const qz = await getQz();
    if (!qz.websocket.isActive()) await conectar();
    const result = await qz.printers.find();
    return Array.isArray(result) ? result : [result];
  }, [getQz, conectar]);

  const imprimirZpl = useCallback(
    async (zpl: string, impressora: string): Promise<void> => {
      const qz = await getQz();
      if (!qz.websocket.isActive()) await conectar();
      const config = qz.configs.create(impressora);

      if (impressora.toUpperCase().includes("PDF")) {
        const pdfBase64 = await zplParaPdf(zpl);
        await qz.print(config, [{ type: "pixel", format: "pdf", flavor: "base64", data: pdfBase64 }]);
        return;
      }

      await qz.print(config, [{ type: "raw", format: "plain", data: zpl }]);
    },
    [getQz, conectar],
  );

  const imprimirPdf = useCallback(
    async (base64: string, impressora: string): Promise<void> => {
      const qz = await getQz();
      if (!qz.websocket.isActive()) await conectar();
      const config = qz.configs.create(impressora);
      await qz.print(config, [
        { type: "pixel", format: "pdf", flavor: "base64", data: base64 },
      ]);
    },
    [getQz, conectar],
  );

  const visualizarEtiqueta = useCallback(async (zpl: string): Promise<void> => {
    await abrirEtiquetaPDF(zpl);
  }, []);

  return { isConectado, conectando, listarImpressoras, imprimirZpl, imprimirPdf, visualizarEtiqueta };
}
