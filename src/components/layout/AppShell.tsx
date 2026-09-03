import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard, Package, ShoppingBag, Settings, LogOut,
  ClipboardList, History, Menu,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const items = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Expedição", to: "/expedicao", icon: Package },
  { label: "Histórico", to: "/historico", icon: History },
  { label: "Pedidos", to: "/pedidos", icon: ClipboardList },
  { label: "Produtos", to: "/produtos", icon: ShoppingBag },
  { label: "Configurações", to: "/configuracoes", icon: Settings },
];

function isActive(pathname: string, to: string) {
  return pathname === to || (to !== "/" && pathname.startsWith(to));
}

/** Título da rota atual, derivado do mesmo array `items` — sem string duplicada. */
function tituloDaRota(pathname: string): string {
  return items.find((it) => isActive(pathname, it.to))?.label ?? "EXPEDE";
}

/**
 * Conteúdo de navegação — fonte única de verdade.
 * Usado pela <aside> do desktop e pelo <Sheet> do celular.
 */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-6 border-b border-white/10">
        <Link to="/expedicao" className="block" onClick={onNavigate}>
          <img
            src="/expede-logo-light.png"
            alt="EXPEDE"
            width={1500}
            height={390}
            className="h-12 w-auto"
          />
        </Link>
        <p className="text-xs text-white/50 mt-1">Gestão de Expedição</p>
      </div>
      <nav className="flex-1 py-4">
        {items.map((it) => {
          const active = isActive(pathname, it.to);
          const Icon = it.icon;
          return (
            <Link
              key={it.to}
              to={it.to}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
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
      <div className="p-4 text-xs md:text-[11px] text-white/40 border-t border-white/10">
        v0.2 — fase 2
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-60 shrink-0 bg-sidebar text-sidebar-foreground flex-col min-h-screen">
      <SidebarNav />
    </aside>
  );
}

/** Avatar — uma definição só, usada no desktop e no gatilho do menu do celular. */
function AvatarChip({ inicial }: { inicial: string }) {
  return (
    <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-semibold">
      {inicial}
    </div>
  );
}

export function Header() {
  const { profile, isAdmin, signOut } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);

  // Fecha o drawer ao navegar — senão ele fica aberto por cima da página nova.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const nome = profile?.nome ?? "—";
  const inicial = nome.charAt(0).toUpperCase();
  const cargo = isAdmin ? "Administrador" : "Operador";

  return (
    <header className="h-14 border-b bg-card flex items-center justify-between md:justify-end px-4 md:px-6 gap-3">
      {/* Celular: hambúrguer + título da rota */}
      <div className="flex items-center gap-2 min-w-0 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label="Abrir menu de navegação"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-72 p-0 bg-sidebar text-sidebar-foreground border-white/10"
          >
            <SheetTitle className="sr-only">Navegação</SheetTitle>
            <SidebarNav onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>
        <span className="truncate text-base font-semibold">{tituloDaRota(pathname)}</span>
      </div>

      {/* Desktop: nome/cargo + avatar + Sair — idêntico ao de hoje */}
      <div className="hidden md:flex items-center gap-3">
        <div className="text-right">
          <div className="text-sm font-medium leading-tight">{nome}</div>
          <div className="text-[11px] text-muted-foreground leading-tight">{cargo}</div>
        </div>
        <AvatarChip inicial={inicial} />
        <Button variant="ghost" size="sm" onClick={() => signOut()} className="ml-2" title="Sair">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Celular: avatar abre menu com nome, cargo e Sair */}
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Conta de ${nome}`}
            >
              <AvatarChip inicial={inicial} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-sm font-medium">{nome}</div>
              <div className="text-xs font-normal text-muted-foreground">{cargo}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()} className="min-h-11 text-base">
              <LogOut className="mr-2 h-4 w-4" />
              Sair
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
