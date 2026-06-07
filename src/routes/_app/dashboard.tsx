import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Package, CheckCircle2, TrendingUp, ShoppingCart, Zap,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { getDashboardExpedicao, getDashboardVendas } from "@/lib/dashboard.functions";
import { getMLConnection } from "@/lib/ml.functions";
import { getBlingConnection } from "@/lib/bling.functions";
import { getProdutosOverview } from "@/lib/produtos.functions";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
});

function fmtBRL(v: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function fmtRel(iso?: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `há ${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

function fmtExpira(iso?: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "expirado";
  const h = Math.floor(diff / 3600_000);
  const min = Math.floor((diff % 3600_000) / 60_000);
  return h > 0 ? `expira em ${h}h ${min}min` : `expira em ${min}min`;
}

function StatCard({
  title, value, loading, icon: Icon, bg,
}: {
  title: string;
  value: string | number;
  loading: boolean;
  icon: React.ElementType;
  bg: string;
}) {
  return (
    <div className={`rounded-xl p-6 flex items-center gap-4 ${bg} text-white shadow-sm`}>
      <Icon className="h-10 w-10 opacity-80 shrink-0" />
      <div>
        <p className="text-sm font-medium opacity-80">{title}</p>
        {loading ? (
          <div className="mt-1 h-8 w-24 bg-white/20 rounded animate-pulse" />
        ) : (
          <p className="text-3xl font-bold tracking-tight">{value}</p>
        )}
      </div>
    </div>
  );
}

function fmtDia(dia: string): string {
  const [y, m, d] = dia.split("-");
  return `${d}/${m}/${y}`;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border rounded-lg shadow-lg px-3 py-2 text-sm">
      <p className="font-medium mb-1">{fmtDia(label)}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.dataKey === "valor" ? `Vendas: ${fmtBRL(entry.value)}` : `Pedidos: ${entry.value}`}
        </p>
      ))}
    </div>
  );
}

function DashboardPage() {
  const expFn = useServerFn(getDashboardExpedicao);
  const vendasFn = useServerFn(getDashboardVendas);
  const mlFn = useServerFn(getMLConnection);
  const blingFn = useServerFn(getBlingConnection);
  const ovFn = useServerFn(getProdutosOverview);

  const expQ = useQuery({ queryKey: ["dash-expedicao"], queryFn: () => expFn(), refetchInterval: 60_000 });
  const vendasQ = useQuery({ queryKey: ["dash-vendas"], queryFn: () => vendasFn(), refetchInterval: 60_000 });
  const mlQ = useQuery({ queryKey: ["ml-connection"], queryFn: () => mlFn(), refetchInterval: 60_000 });
  const blingQ = useQuery({ queryKey: ["bling-connection"], queryFn: () => blingFn(), refetchInterval: 60_000 });
  const ovQ = useQuery({ queryKey: ["produtos-overview"], queryFn: () => ovFn(), refetchInterval: 60_000 });

  const exp = expQ.data;
  const vendas = vendasQ.data ?? [];

  return (
    <div className="p-6 max-w-6xl space-y-8">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      {/* SEÇÃO 1 — Cards de expedição hoje */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          title="Pendentes agora"
          value={exp?.pendentes ?? 0}
          loading={expQ.isLoading}
          icon={Package}
          bg="bg-blue-900"
        />
        <StatCard
          title="Expedidos hoje"
          value={exp?.expedidos ?? 0}
          loading={expQ.isLoading}
          icon={CheckCircle2}
          bg="bg-green-600"
        />
        <StatCard
          title="Total hoje"
          value={fmtBRL(exp?.totalValor ?? 0)}
          loading={expQ.isLoading}
          icon={TrendingUp}
          bg="bg-slate-700"
        />
      </div>

      {/* SEÇÃO 2 — Gráfico de vendas últimos 30 dias */}
      <div className="bg-card border rounded-xl shadow-sm p-6">
        <h2 className="text-base font-semibold mb-4">Vendas — últimos 30 dias</h2>
        {vendasQ.isLoading ? (
          <div className="h-64 bg-muted rounded animate-pulse" />
        ) : vendas.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
            Nenhum dado disponível
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={256}>
            <LineChart data={vendas} margin={{ top: 5, right: 40, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis
                dataKey="dia"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: string) => { const [, m, d] = v.split("-"); return `${d}/${m}`; }}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) =>
                  v >= 1000 ? `R$${(v / 1000).toFixed(0)}k` : `R$${v}`
                }
              />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="valor"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                name="Vendas R$"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="pedidos"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                name="Pedidos"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* SEÇÃO 3 — Conexões */}
      <div className="grid grid-cols-2 gap-4">
        {/* Mercado Livre */}
        <div className="bg-card border rounded-xl shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <ShoppingCart className="h-5 w-5 text-yellow-500" />
            <span className="font-semibold">Mercado Livre</span>
          </div>
          {mlQ.isLoading ? (
            <div className="h-6 w-40 bg-muted rounded animate-pulse" />
          ) : mlQ.data?.connected ? (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3 w-3" /> Conectado · user {mlQ.data.ml_user_id}
              </span>
              <p className="text-xs text-muted-foreground">{fmtExpira(mlQ.data.expires_at)}</p>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
              Desconectado
            </span>
          )}
        </div>

        {/* Bling */}
        <div className="bg-card border rounded-xl shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-5 w-5 text-blue-500" />
            <span className="font-semibold">Bling</span>
          </div>
          {blingQ.isLoading ? (
            <div className="h-6 w-40 bg-muted rounded animate-pulse" />
          ) : blingQ.data ? (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3 w-3" /> Conectado · {(blingQ.data as any).bling_account_name ?? "MP Baby"}
              </span>
              <p className="text-xs text-muted-foreground">
                última sync {fmtRel(ovQ.data?.lastSyncedAt)}
              </p>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
              Desconectado
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
