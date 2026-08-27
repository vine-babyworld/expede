import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { PDFDocument } from "pdf-lib";
import { signQzRequest } from "@/lib/qztray.functions";
import { zplParaPdf, abrirEtiquetaPDF, uint8ToBase64, base64ToUint8 } from "@/lib/zpl-to-pdf";

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

// Etiqueta/DANFE são sempre ~10x15cm (mesmo tamanho usado em danfe-render.ts).
// Sem isso, qz-tray manda o PDF pro driver com rasterize=false e size=null —
// a página nativa do PDF (ex: A4 de um PDF de etiqueta gerado por marketplace)
// é impressa "como está" na mídia física de 10x15cm, saindo minúscula com uma
// área em branco enorme em vez de preencher a etiqueta.
const LABEL_PAGE_CONFIG = {
  size: { width: 100, height: 150 },
  units: "mm" as const,
  scaleContent: true,
  rasterize: true,
};

// Etiquetas da Shopee (download_shipping_document, THERMAL_AIR_WAYBILL) chegam como
// PDF em página A4 inteira (595x842pt) com a etiqueta térmica de verdade ocupando só
// uma região de ~105x148mm dentro dela — sem recortar essa região antes de imprimir,
// o scaleContent acima encolhe a página A4 inteira pra caber nos 100x150mm físicos da
// etiqueta, saindo pequena e cortada (é isso, não o LABEL_PAGE_CONFIG, que causava a
// etiqueta "cortada pela metade, em escala menor" reportada 2026-08). Região confirmada
// em pedidos reais (2026-08-24): x:[0,297] y:[423,842]pt. Só recorta se a página bater
// com A4 — PDFs já corretos (DANFE, ZPL convertido via Labelary) não são afetados.
const SHOPEE_A4_LABEL_CROP = { x: 0, y: 423, width: 297, height: 419 };

async function recortarSePaginaA4(base64: string): Promise<string> {
  try {
    const pdf = await PDFDocument.load(base64ToUint8(base64));
    if (pdf.getPageCount() !== 1) return base64;
    const page = pdf.getPage(0);
    const { width, height } = page.getSize();
    const ehA4 = width > 580 && width < 610 && height > 830 && height < 850;
    if (!ehA4) return base64;

    const { x, y, width: w, height: h } = SHOPEE_A4_LABEL_CROP;
    page.setMediaBox(x, y, w, h);
    page.setCropBox(x, y, w, h);
    return uint8ToBase64(await pdf.save());
  } catch (err) {
    console.error("[qztray] falha ao recortar etiqueta A4, imprimindo página inteira:", err);
    return base64;
  }
}

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

      if (impressora.toUpperCase().includes("PDF")) {
        const pdfBase64 = await zplParaPdf(zpl);
        const config = qz.configs.create(impressora, LABEL_PAGE_CONFIG);
        await qz.print(config, [{ type: "pixel", format: "pdf", flavor: "base64", data: pdfBase64 }]);
        return;
      }

      const config = qz.configs.create(impressora);
      await qz.print(config, [{ type: "raw", format: "plain", data: zpl }]);
    },
    [getQz, conectar],
  );

  const imprimirPdf = useCallback(
    async (base64: string, impressora: string): Promise<void> => {
      const qz = await getQz();
      if (!qz.websocket.isActive()) await conectar();
      const base64Recortado = await recortarSePaginaA4(base64);
      const config = qz.configs.create(impressora, LABEL_PAGE_CONFIG);
      await qz.print(config, [
        { type: "pixel", format: "pdf", flavor: "base64", data: base64Recortado },
      ]);
    },
    [getQz, conectar],
  );

  const visualizarEtiqueta = useCallback(async (zpl: string): Promise<void> => {
    await abrirEtiquetaPDF(zpl);
  }, []);

  return { isConectado, conectando, listarImpressoras, imprimirZpl, imprimirPdf, visualizarEtiqueta };
}
