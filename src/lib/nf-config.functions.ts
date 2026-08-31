import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "@/lib/users.functions";

export type NfConfig = {
  /** Emitir NF automaticamente também para pedidos ML Flex. */
  flexAtiva: boolean;
};

export const getNfConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<NfConfig> => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const { lerFlagConfig, NF_CONFIG_FLEX } = await import("@/lib/nf-config.server");
    return { flexAtiva: await lerFlagConfig(NF_CONFIG_FLEX) };
  });

export const setNfFlexAtiva = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ ativa: z.boolean() }).parse(input))
  .handler(async ({ data, context }): Promise<NfConfig> => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const { gravarFlagConfig, NF_CONFIG_FLEX } = await import("@/lib/nf-config.server");
    await gravarFlagConfig(NF_CONFIG_FLEX, data.ativa);
    // Rastro operacional: é mudança de política fiscal, precisa aparecer no
    // `wrangler tail` junto com os ciclos do controlador.
    console.log(
      `[nf-config] nf_emissao_flex_ativa=${data.ativa} alterado por ${userId}`,
    );
    return { flexAtiva: data.ativa };
  });
