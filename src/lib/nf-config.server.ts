import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Kill switch do controlador de emissão de NF do Mercado Livre. */
export const NF_CONFIG_CONTROLADOR_ML = "nf_emissao_ml_ativa";
/** Quando true, pedidos ML Flex deixam de ser emissão manual e entram na fila. */
export const NF_CONFIG_FLEX = "nf_emissao_flex_ativa";

/**
 * Falha fechada: chave ausente ou erro de leitura devolve `false`. Uma flag que
 * autoriza ação fiscal irreversível nunca deve ligar por acidente de rede.
 */
export async function lerFlagConfig(key: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.error(`[nf-config] falha ao ler ${key}:`, error.message);
    return false;
  }
  return data?.value === true;
}

export async function gravarFlagConfig(key: string, valor: boolean): Promise<void> {
  const { error } = await (supabaseAdmin as any)
    .from("app_config")
    .upsert(
      { key, value: valor, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw new Error(error.message);
}
