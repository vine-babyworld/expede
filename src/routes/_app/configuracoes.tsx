import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/_app/configuracoes")({
  component: ConfiguracoesLayout,
});

function ConfiguracoesLayout() {
  const { isAdmin } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (!isAdmin) {
    return (
      <div className="p-4 md:p-8 max-w-3xl">
        <h1 className="text-3xl font-bold">Configurações</h1>
        <p className="mt-4 text-muted-foreground">
          Apenas administradores podem acessar esta área.
        </p>
      </div>
    );
  }

  const tabs = [
    { to: "/configuracoes", label: "Usuários", match: (p: string) => p === "/configuracoes" },
    { to: "/configuracoes/bling", label: "Bling", match: (p: string) => p.startsWith("/configuracoes/bling") },
    { to: "/configuracoes/marketplaces", label: "Marketplaces", match: (p: string) => p.startsWith("/configuracoes/marketplaces") },
    { to: "/configuracoes/notas-fiscais", label: "Notas Fiscais", match: (p: string) => p.startsWith("/configuracoes/notas-fiscais") },
  ];

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Configurações</h1>
      </div>
      <div className="mb-6 -mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto">
        <div className="border-b flex gap-1 min-w-max md:min-w-0">
          {tabs.map((t) => {
            const active = t.match(pathname);
            return (
              <Link
                key={t.to}
                to={t.to}
                aria-current={active ? "page" : undefined}
                className={`flex items-center whitespace-nowrap px-4 py-2 min-h-11 md:min-h-0 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
