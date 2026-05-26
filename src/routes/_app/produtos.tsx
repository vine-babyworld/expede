import { createFileRoute } from "@tanstack/react-router";
import { EmConstrucao } from "@/components/EmConstrucao";

export const Route = createFileRoute("/_app/produtos")({
  component: () => <EmConstrucao titulo="Produtos" />,
});
