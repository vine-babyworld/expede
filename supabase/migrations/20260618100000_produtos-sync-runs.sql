create table if not exists produtos_sync_runs (
  id uuid primary key default gen_random_uuid(),
  bling_connection_id uuid references bling_connections(id),
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  total_recebidos integer not null default 0,
  total_upserted integer not null default 0,
  total_erros integer not null default 0,
  origem text not null default 'pc-local',
  detalhes jsonb
);
alter table produtos_sync_runs enable row level security;

-- Consulta típica: última(s) run(s) de uma conexão Bling, mais recente primeiro.
-- Mesmo padrão de idx_sync_jobs_connection (20260527114333).
create index if not exists idx_produtos_sync_runs_connection
  on produtos_sync_runs (bling_connection_id, iniciado_em desc);
