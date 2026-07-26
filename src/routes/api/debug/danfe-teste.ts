import { createFileRoute } from "@tanstack/react-router";
import { renderDanfePdf, type DanfeInput } from "@/lib/danfe-render";

// Casos extremos para validar que nada é cortado com "…" e que tudo cabe na etiqueta:
// nome de cliente longo, descrições longas, SKU longo sem espaços, e mais itens do
// que cabem confortavelmente em fonte padrão (força o ajuste automático de fonte).
const MOCK: DanfeInput = {
  nfNumero: "016533",
  dataPedido: new Date().toISOString(),
  chaveAcesso: "35260738173755000160550010001653319068899",
  nomeCliente: "Sergio Luiz Ferreira Lucas de Albuquerque Nascimento (sergio_luiz_9284)",
  docCliente: "705.926.874-06",
  ufCliente: "RN",
  numeroLoja: "2000017394642408",
  itens: [
    {
      sku: "21670-21671",
      descricao:
        "Par Parabarro Punto 2007 2008 2009 2010 2011 2012 2013 Dianteiro Preto Texturizado Original",
      quantidade: 1,
    },
    {
      sku: "BLCB08-1PK03KRATATATATATATATATATATATATA",
      descricao: "Kit Naturau - 1,00 al Palitinho Bovino 4un P/cães super resistente sabor churrasco",
      quantidade: 3,
    },
    { sku: "SKU-001", descricao: "Item curto", quantidade: 12 },
    { sku: "SKU-002", descricao: "Outro item de exemplo", quantidade: 2 },
    { sku: "SKU-003", descricao: "Mais um item para testar o limite da etiqueta", quantidade: 5 },
  ],
};

export const Route = createFileRoute("/api/debug/danfe-teste")({
  server: {
    handlers: {
      GET: async () => {
        const pdfBytes = await renderDanfePdf(MOCK);
        return new Response(new Uint8Array(pdfBytes), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "inline; filename=danfe-teste.pdf",
          },
        });
      },
    },
  },
});
