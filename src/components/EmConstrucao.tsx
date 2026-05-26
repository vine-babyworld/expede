import { Construction } from "lucide-react";

export function EmConstrucao({ titulo }: { titulo: string }) {
  return (
    <div className="p-10">
      <h1 className="text-3xl font-bold text-foreground">{titulo}</h1>
      <div className="mt-10 rounded-xl border bg-card p-12 flex flex-col items-center justify-center text-center max-w-2xl mx-auto shadow-sm">
        <Construction className="h-16 w-16 text-muted-foreground/60 mb-4" />
        <p className="text-lg font-medium text-foreground">Em construção</p>
        <p className="text-sm text-muted-foreground mt-2">
          Esta seção será implementada em uma fase futura do projeto.
        </p>
      </div>
    </div>
  );
}
