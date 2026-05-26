import { createFileRoute } from "@tanstack/react-router";
import { ExpedicaoPage } from "@/features/expedicao/ExpedicaoPage";

export const Route = createFileRoute("/_app/expedicao")({
  component: ExpedicaoPage,
});
