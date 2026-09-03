import type { ReactNode } from "react";
import { MobileHidden } from "@/components/MobileHidden";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type ColumnPriority = "primary" | "secondary" | "desktop-only";

export interface ResponsiveColumn<T> {
  id: string;
  header: string;
  /** Renderiza a célula. O MESMO render é usado na <td> e no card. */
  cell: (row: T) => ReactNode;
  /**
   * primary      -> linha de destaque no topo do card (máx. 2 por tabela)
   * secondary    -> par rótulo/valor no corpo do card
   * desktop-only -> existe só na tabela; não aparece no card
   */
  priority: ColumnPriority;
  align?: "left" | "right";
  /** Classes aplicadas só à <th>/<td> no modo tabela. */
  className?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Navegação para o detalhe. Permitida no celular (é leitura). */
  onRowClick?: (row: T) => void;
  /**
   * Botões de ação da linha. NUNCA renderizados abaixo de md: o componente já os
   * envolve em <MobileHidden>, então a tela que chama não precisa lembrar disso.
   */
  rowActions?: (row: T) => ReactNode;
  /** Classes extras por linha (ex.: `opacity-50` em cancelado). Vale nos dois modos. */
  rowClassName?: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  /** Quantas linhas/cards de skeleton mostrar enquanto carrega. */
  skeletonRows?: number;
}

export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowActions,
  rowClassName,
  loading = false,
  empty,
  skeletonRows = 6,
}: ResponsiveTableProps<T>) {
  const colSpan = columns.length + (rowActions ? 1 : 0);
  const primary = columns.filter((c) => c.priority === "primary");
  const secondary = columns.filter((c) => c.priority === "secondary");

  return (
    <>
      {/* ── Desktop (>= md): tabela, com as mesmas classes visuais das tabelas atuais ── */}
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className={cn(
                    "px-4 py-3 font-medium",
                    c.align === "right" ? "text-right" : "text-left",
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
              {rowActions && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-t">
                  {Array.from({ length: colSpan }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="text-center py-12 text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-t transition-colors hover:bg-muted/30",
                    onRowClick && "cursor-pointer",
                    rowClassName?.(row),
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        "px-4 py-3",
                        c.align === "right" && "text-right",
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <MobileHidden>{rowActions(row)}</MobileHidden>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Celular (< md): um card por linha ── */}
      <div className="md:hidden space-y-2">
        {loading ? (
          Array.from({ length: skeletonRows }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
              <Skeleton className="h-5 w-2/3" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
          ))
        ) : rows.length === 0 ? (
          <div className="rounded-lg border bg-card py-12 text-center text-muted-foreground">
            {empty}
          </div>
        ) : (
          rows.map((row) => {
            const conteudo = (
              <>
                <div className="space-y-0.5">
                  {primary.map((c) => (
                    <div key={c.id} className="text-base font-medium leading-tight break-words">
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
                {secondary.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    {secondary.map((c) => (
                      <div key={c.id} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{c.header}</dt>
                        <dd className="break-words">{c.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            );

            const classes = cn(
              "w-full text-left rounded-lg border bg-card p-4 min-h-11 flex flex-col gap-3",
              rowClassName?.(row),
            );

            return onRowClick ? (
              <button
                key={rowKey(row)}
                type="button"
                onClick={() => onRowClick(row)}
                className={cn(
                  classes,
                  "active:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              >
                {conteudo}
              </button>
            ) : (
              <div key={rowKey(row)} className={classes}>
                {conteudo}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
