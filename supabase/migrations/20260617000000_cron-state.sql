-- Tabela de controle de estado dos cron jobs.
-- Usada para implementar debounce durável entre isolates do CF Workers,
-- substituindo variáveis de módulo em memória que não persistem entre instâncias.
CREATE TABLE IF NOT EXISTS cron_state (
  job_name    TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
