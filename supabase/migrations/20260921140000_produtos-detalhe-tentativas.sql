-- Rastreia por produto o resultado da fase de detalhes do sync com o Bling.
--
-- Motivação: até 09/2026 a fase de detalhes carimbava `detail_synced_at` mesmo quando a
-- chamada ao Bling FALHAVA. O lote pendente é sempre "os primeiros N sem carimbo", então
-- carimbar era a única forma de o job não repetir para sempre o mesmo produto quebrado —
-- o preço era o produto sumir do enriquecimento em silêncio, sem EAN, para sempre, e o
-- job ainda reportar "concluído" em verde.
--
-- Com estas colunas o produto que falha continua PENDENTE (sem `detail_synced_at`), mas
-- sai da fila depois de `detail_attempts` tentativas, e o motivo fica gravado na linha em
-- vez de se perder no array `erros` do job (que guarda só as últimas 50 entradas).

alter table public.produtos
  add column if not exists detail_attempts smallint not null default 0,
  add column if not exists detail_last_error text,
  add column if not exists detail_last_attempt_at timestamptz;

comment on column public.produtos.detail_attempts is
  'Tentativas consecutivas de buscar o detalhe no Bling que falharam. Zerado a cada sucesso.';
comment on column public.produtos.detail_last_error is
  'Mensagem da última falha ao buscar o detalhe no Bling. NULL quando o último detalhe deu certo.';
comment on column public.produtos.detail_last_attempt_at is
  'Quando o detalhe foi tentado pela última vez, tendo dado certo ou não.';

-- A fila da fase de detalhes é "sem detail_synced_at e ainda com tentativas disponíveis".
-- Sem este índice, cada lote faz seq scan na tabela inteira.
create index if not exists idx_produtos_detalhe_pendente
  on public.produtos (bling_connection_id, detail_attempts)
  where detail_synced_at is null;
