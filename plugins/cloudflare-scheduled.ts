import { definePlugin } from "nitro";
import { cronReconciliar, cronSyncPoll, cronMLStatus, cronNfStatus, cronNfEmissao, cronRepasseMl } from "../src/server";

// O preset Nitro cloudflare-module não usa o `scheduled` exportado em src/server.ts —
// Cron Triggers do Cloudflare chegam aqui via hook "cloudflare:scheduled".
// https://nitro.build/deploy/providers/cloudflare#runtime-hooks
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("cloudflare:scheduled", async ({ context }: any) => {
    // Os cinco crons disputam o mesmo limite de 3 req/s do Bling. Disparados em
    // paralelo (waitUntil sem await) eles amplificavam o 429 que travava a fila
    // de emissão de NF. Serializados, cada um continua isolado pelo próprio
    // catch: falha de um não impede os seguintes.
    const tarefas: Array<[string, () => Promise<unknown>]> = [
      ["cron-sync", cronSyncPoll],
      ["cron-reconciliar", cronReconciliar],
      ["cron-ml-status", cronMLStatus],
      ["cron-nf-status", cronNfStatus],
      ["cron-nf-emissao", cronNfEmissao],
      ["cron-repasse", cronRepasseMl],
    ];

    context.waitUntil(
      (async () => {
        for (const [nome, tarefa] of tarefas) {
          try {
            await tarefa();
          } catch (e: unknown) {
            console.error(`[${nome}] erro:`, e);
          }
        }
      })(),
    );
  });
});
