import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { listUsers, createUser, setUserAtivo } from "@/lib/users.functions";
import { UserPlus, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_app/configuracoes")({
  component: ConfiguracoesPage,
});

function ConfiguracoesPage() {
  const { isAdmin } = useAuth();
  const list = useServerFn(listUsers);
  const create = useServerFn(createUser);
  const toggle = useServerFn(setUserAtivo);
  const qc = useQueryClient();

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users-admin"],
    queryFn: () => list(),
    enabled: isAdmin,
  });

  const toggleMut = useMutation({
    mutationFn: (vars: { id: string; ativo: boolean }) =>
      toggle({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users-admin"] });
      toast.success("Status atualizado");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-3xl">
        <h1 className="text-3xl font-bold">Configurações</h1>
        <p className="mt-4 text-muted-foreground">
          Apenas administradores podem acessar esta área.
        </p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
          <p className="text-sm text-muted-foreground mt-1">Usuários do sistema</p>
        </div>
        <NovoUsuarioDialog
          onCreated={() => qc.invalidateQueries({ queryKey: ["users-admin"] })}
          createFn={create}
        />
      </div>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Nome</th>
              <th className="px-4 py-3 font-medium">E-mail</th>
              <th className="px-4 py-3 font-medium">Papel</th>
              <th className="px-4 py-3 font-medium">Ativo</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin inline" />
              </td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                Nenhum usuário.
              </td></tr>
            ) : users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-3 font-medium">{u.nome}</td>
                <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-primary/10 text-primary">
                    {u.roles[0] ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Switch
                    checked={u.ativo}
                    onCheckedChange={(v) => toggleMut.mutate({ id: u.id, ativo: v })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NovoUsuarioDialog({
  createFn,
  onCreated,
}: {
  createFn: ReturnType<typeof useServerFn<typeof createUser>>;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "operador">("operador");

  const mut = useMutation({
    mutationFn: () => createFn({ data: { nome, email, password, role } }),
    onSuccess: () => {
      toast.success("Usuário criado");
      setOpen(false);
      setNome(""); setEmail(""); setPassword(""); setRole("operador");
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><UserPlus className="h-4 w-4 mr-2" />Novo usuário</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Novo usuário</DialogTitle></DialogHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label>E-mail</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label>Senha temporária (mín 8 caracteres)</Label>
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <div className="space-y-2">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "operador")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="operador">Operador</SelectItem>
                <SelectItem value="admin">Administrador</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={mut.isPending}>
              {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
