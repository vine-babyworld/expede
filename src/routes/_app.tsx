import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { Sidebar, Header } from "@/components/layout/AppShell";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/_app" || location.pathname === "/") {
      throw redirect({ to: "/expedicao" });
    }
  },
  component: AppLayout,
});

function AppLayout() {
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
