/**
 * Bot templates for the Marketplace Bots tab.
 *
 * Static compositions derived from the W3 COMPONENT_MAP responsibilities. Installing one creates
 * an agent profile and grants its skills through the existing routes; nothing here connects an
 * integration or activates a routine.
 */
export type BotTemplate = {
  key: string;
  name: string;
  title: string;
  description: string;
  category: "Vendas" | "Entrega" | "Marketing" | "Operação";
  skills: string[];
  memories: string[];
};

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    key: "sales",
    name: "Vendas",
    category: "Vendas",
    title: "Time comercial W3",
    description: "Prospecção, qualificação e pipeline no MCRM.",
    skills: [
      "research-prospect",
      "qualify-sales-opportunity",
      "close-customer-loop",
      "monitor-sales-pipeline",
      "prepare-shopify-proposal",
    ],
    memories: ["ICP", "regras de qualificação", "ownership"],
  },
  {
    key: "delivery",
    name: "Delivery",
    category: "Entrega",
    title: "Coordenação de projetos",
    description: "Escopo, marcos, riscos e handoffs de projeto.",
    skills: ["manage-shopify-project"],
    memories: ["escopo", "marcos", "critérios de aceite", "riscos"],
  },
  {
    key: "shopify-qa",
    name: "Shopify e QA",
    category: "Entrega",
    title: "Loja pronta para vender",
    description: "Auditoria, validação e gates de lançamento da loja.",
    skills: ["audit-shopify-store", "validate-shopify-launch"],
    memories: ["restrições da loja", "baselines", "gates de lançamento"],
  },
  {
    key: "design",
    name: "Design",
    category: "Marketing",
    title: "Revisão de design",
    description: "Revisão acionável de sites e lojas.",
    skills: ["review-design"],
    memories: ["regras de marca", "padrões aprovados", "acessibilidade"],
  },
  {
    key: "marketing",
    name: "Marketing",
    category: "Marketing",
    title: "Conteúdo e concorrência",
    description: "SEO/AEO, conteúdo e monitoramento de concorrentes.",
    skills: ["plan-seo-aeo-content", "monitor-competitors"],
    memories: ["audiência", "ofertas", "voz", "pauta de temas"],
  },
  {
    key: "finance-ops",
    name: "Financeiro e Operação",
    category: "Operação",
    title: "Margem sob controle",
    description: "Margem por projeto e matriz de aprovação.",
    skills: ["analyze-project-margin"],
    memories: ["modelo de custos", "regras de margem", "matriz de aprovação"],
  },
  {
    key: "product",
    name: "Produto",
    category: "Operação",
    title: "Oportunidades de produto",
    description: "Investigação de oportunidades e portfólio SaaS.",
    skills: ["research-product-opportunity", "monitor-competitors"],
    memories: ["hipóteses", "decisões", "histórico de experimentos"],
  },
  {
    key: "director",
    name: "Direção",
    category: "Operação",
    title: "Revisão executiva",
    description: "Prioridades, bloqueios, decisões e responsáveis.",
    skills: ["run-executive-review"],
    memories: ["prioridades", "decisões", "responsáveis", "limites"],
  },
];
