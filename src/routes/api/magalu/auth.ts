import { createFileRoute } from "@tanstack/react-router";
import { getMagaluAuthUrl } from "@/lib/magalu.functions";
import { bytesToHex } from "@/lib/token-crypto";

/**
 * Início do consentimento OAuth do Magalu.
 *
 * Diferente de `/api/ml/auth` e `/api/shopee/auth` (que não usam `state`), aqui
 * o `state` é gerado e guardado num cookie HttpOnly, conferido no callback. É
 * a defesa mínima contra alguém induzir o admin a plugar OUTRA conta Magalu no
 * EXPEDE — e não custa tabela nova.
 *
 * O que essa URL carrega de crítico está em `montarUrlConsentimento`
 * (`src/lib/magalu.ts`): `choose_tenants=true` e os 6 escopos. Na tela de
 * consentimento é obrigatório escolher o tenant **`organization`** (Baby Magia
 * LTDA), nunca o `person` — com o tenant errado tudo autentica e a etiqueta só
 * estoura 403 depois, em produção.
 */
export const Route = createFileRoute("/api/magalu/auth")({
  server: {
    handlers: {
      GET: async () => {
        const state = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(24)));
        const url = getMagaluAuthUrl(state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            "Set-Cookie": `magalu_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
          },
        });
      },
    },
  },
});
