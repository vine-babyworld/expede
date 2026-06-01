import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { signQzRequest } from "@/lib/qztray.functions";

// Certificado público — pode ser hardcoded no frontend
const QZ_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJDCCAgygAwIBAgIUUkNtdPDJfZ7qTYOFdYOo6D5cc0kwDQYJKoZIhvcNAQEL
BQAwMjEPMA0GA1UEAwwGRVhQRURFMRIwEAYDVQQKDAlCYWJ5V29ybGQxCzAJBgNV
BAYTAkJSMB4XDTI2MDUzMTE2MjcwOVoXDTM2MDUyODE2MjcwOVowMjEPMA0GA1UE
AwwGRVhQRURFMRIwEAYDVQQKDAlCYWJ5V29ybGQxCzAJBgNVBAYTAkJSMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3SMLkBvIz7GViXH4KDffz8mc89v/
7kgaPBDY2xDlany7Ox6/LossK4e5vmIRPrx4tC5x5hP8ibX+0OWwJkfOfAlmYXEV
OLdvqaoevxx0xkz3y4GwI86OsLZGxw5QljFlpMaxLtsPqOF+gX30r6Vppv0+z8Yy
ldjV56BQGBuiqsBO2fkCE9oCjizOMoPzrnN8jkkJrGFbkLZx+Yq9ElLZVlcf6tXA
tBZyF6qXfwplv6pbrBga3akX0YC67ADgrcyKYIi2BXZ6rnslJZrsDLdpwaJt+bB7
JDx2XT1mS96b28CI5Q4/60PryKBvQzazR7ufeRlgRAjOBptEHGwnr+ysjQIDAQAB
ozIwMDAdBgNVHQ4EFgQUwCLWT/crl2zkifoYR/LYS62y9bswDwYDVR0TAQH/BAUw
AwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAumt4d9E2m9riBsIk2j+VS1XVa/k0o2yf
0XhhGljcOxOTPkpNXDhmftpZg1TysV3/pHVKa8Eb6juHwjOjN7tqj4fr7JD6wXFA
9jchZJyj6QJFWWVELrfMQYux5pCEEvWDVK3iYCDgzIPzxYtNqp3T1VKqfXPHMKSW
fKhEVFjy6R6QYhlb7IbQV3kMk6sfixttCdvdxnAfgwwQ6jqJiyihbuxWqyx+JyCv
qxxWDhw7Scw11WlphfNrHTzoOCMKi5O4FiYLBN0NEh1NpGvsT7SlanyAoKnhEu6I
WqiektkS0x6RnSjAax4/q4/MLExg7de1YS5SQwxoyDLCyAPzmrZEow==
-----END CERTIFICATE-----`;

export type QzTrayHook = {
  isConectado: boolean;
  conectando: boolean;
  listarImpressoras: () => Promise<string[]>;
  imprimirZpl: (zpl: string, impressora: string) => Promise<void>;
  imprimirPdf: (base64: string, impressora: string) => Promise<void>;
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
      qz.security.setSignatureAlgorithm("SHA1");
      qz.security.setSignaturePromise((toSign: string) => {
        return new Promise<string>((resolve, reject) => {
          signFn({ data: { toSign } })
            .then((r: any) => resolve(r.signature))
            .catch(reject);
        });
      });
      await qz.websocket.connect();
      setIsConectado(true);
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

  return { isConectado, conectando, listarImpressoras, imprimirZpl, imprimirPdf };
}
