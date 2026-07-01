import { definePlugin } from "nitro";
import { cronReconciliar, cronSyncPoll, cronMLStatus } from "../src/server";

// O preset Nitro cloudflare-module não usa o `scheduled` exportado em src/server.ts —
// Cron Triggers do Cloudflare chegam aqui via hook "cloudflare:scheduled".
// https://nitro.build/deploy/providers/cloudflare#runtime-hooks
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("cloudflare:scheduled", async ({ context }: any) => {
    context.waitUntil(
      cronSyncPoll().catch((e: unknown) => console.error("[cron-sync] poll erro:", e)),
    );
    context.waitUntil(
      cronReconciliar().catch((e: unknown) => console.error("[cron-reconciliar] erro:", e)),
    );
    context.waitUntil(
      cronMLStatus().catch((e: unknown) => console.error("[cron-ml-status] erro:", e)),
    );
  });
});
