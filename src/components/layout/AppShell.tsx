import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Package, ShoppingBag, Settings, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

const items = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Expedição", to: "/expedicao", icon: Package },
  { label: "Produtos", to: "/produtos", icon: ShoppingBag },
  { label: "Configurações", to: "/configuracoes", icon: Settings },
];

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <aside className="w-60 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col min-h-screen">
      <div className="px-6 py-6 border-b border-white/10">
        <Link to="/expedicao" className="block">
          <span className="text-2xl font-bold tracking-tight text-white">
            EX<span className="text-[#60A5FA]">PEDE</span>
          </span>
        </Link>
        <p className="text-xs text-white/50 mt-1">Gestão de Expedição</p>
      </div>
      <nav className="flex-1 py-4">
        {items.map((it) => {
          const active =
            pathname === it.to || (it.to !== "/" && pathname.startsWith(it.to));
          const Icon = it.icon;
          return (
            <Link
              key={it.to}
              to={it.to}
              className={`flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors border-l-[3px] ${
                active
                  ? "bg-sidebar-active border-[#60A5FA] text-white"
                  : "border-transparent text-white/70 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="h-5 w-5" />
              {it.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 text-[11px] text-white/40 border-t border-white/10">
        v0.2 — fase 2
      </div>
    </aside>
  );
}

export function Header() {
  const { profile, isAdmin, signOut } = useAuth();
  const nome = profile?.nome ?? "—";
  const inicial = nome.charAt(0).toUpperCase();

  return (
    <header className="h-14 border-b bg-card flex items-center justify-end px-6 gap-3">
      <div className="text-right">
        <div className="text-sm font-medium leading-tight">{nome}</div>
        <div className="text-[11px] text-muted-foreground leading-tight">
          {isAdmin ? "Administrador" : "Operador"}
        </div>
      </div>
      <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-semibold">
        {inicial}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => signOut()}
        className="ml-2"
        title="Sair"
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </header>
  );
}
