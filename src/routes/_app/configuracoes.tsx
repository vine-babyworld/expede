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
      <div className="p-8 max-w-3xl">
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
  ];

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
      </div>
      <div className="border-b mb-6 flex gap-1">
        {tabs.map((t) => {
          const active = t.match(pathname);
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
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
      <Outlet />
    </div>
  );
}
