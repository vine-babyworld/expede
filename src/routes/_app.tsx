import { Outlet, createFileRoute, useNavigate, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { Sidebar, Header } from "@/components/layout/AppShell";
import { useAuth } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, loading, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login", replace: true });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (location.pathname === "/_app" || location.pathname === "/") {
      navigate({ to: "/expedicao", replace: true });
    }
  }, [location.pathname, navigate]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile && !profile.ativo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Conta desativada</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Sua conta foi desativada. Contate um administrador.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
