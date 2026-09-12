import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type CatalogueItem, pluginsPageQueryOptions } from "@/lib/plugins/queries";
import {
  BOT_TEMPLATES,
  type BotTemplate,
} from "@/components/marketplace/bot-templates";
import { installBotMutationOptions } from "@/lib/marketplace/mutations";
import { SkillAgents } from "@/components/skills/skill-agents";

export const Route = createFileRoute("/_authed/_app/marketplace")({
  component: MarketplacePage,
});

type Tab = "plugins" | "bots" | "skills";

/** W3 skill slug → section. The server owns the skill; this only groups the shelf. */
const W3_SKILL_CATEGORY: Record<string, string> = {
  "research-prospect": "Vendas",
  "qualify-sales-opportunity": "Vendas",
  "close-customer-loop": "Vendas",
  "monitor-sales-pipeline": "Vendas",
  "prepare-shopify-proposal": "Vendas",
  "manage-shopify-project": "Entrega",
  "audit-shopify-store": "Entrega",
  "validate-shopify-launch": "Entrega",
  "review-design": "Marketing",
  "plan-seo-aeo-content": "Marketing",
  "monitor-competitors": "Operação",
  "analyze-project-margin": "Operação",
  "research-product-opportunity": "Operação",
  "run-executive-review": "Operação",
};

function matches(query: string, ...fields: (string | null | undefined)[]) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

function CategoryChips({
  categories,
  active,
  onChange,
}: {
  categories: string[];
  active: string;
  onChange: (category: string) => void;
}) {
  if (categories.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {["Todos", ...categories].map((category) => (
        <Button
          key={category}
          onClick={() => onChange(category)}
          size="sm"
          type="button"
          variant={active === category ? "default" : "outline"}
        >
          {category}
        </Button>
      ))}
    </div>
  );
}

function PluginRow({ item }: { item: CatalogueItem }) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription>
          {item.vendor}
          {item.summary ? ` · ${item.summary}` : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button render={<Link to="/admin/plugins" />} size="sm" variant="outline">
          Adicionar
        </Button>
      </ItemActions>
    </Item>
  );
}

function BotRow({
  template,
  installed,
  installing,
  onInstall,
  error,
}: {
  template: BotTemplate;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  error: string | null;
}) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{template.name}</ItemTitle>
        <ItemDescription>
          {template.description} Usa: {template.skills.map((skill) => `/${skill}`).join(" ")}
        </ItemDescription>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {installed ? (
          <span className="text-muted-foreground text-sm">Adicionado</span>
        ) : (
          <Button disabled={installing} onClick={onInstall} size="sm" variant="outline">
            {installing ? "Adicionando…" : "Adicionar"}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

function MarketplacePage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("plugins");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Todos");
  const [installError, setInstallError] = useState<string | null>(null);

  const pluginsQuery = useQuery(pluginsPageQueryOptions());
  const agentsQuery = useQuery(agentListQueryOptions());
  const install = useMutation({
    ...installBotMutationOptions(queryClient),
    onError: (failure: Error) => {
      setInstallError(failure.message);
    },
  });

  const catalogue = pluginsQuery.data?.catalogue ?? [];
  const w3Skills = useMemo(
    () =>
      (pluginsQuery.data?.skills ?? []).filter(
        (skill) => skill.origin === "catalogue",
      ),
    [pluginsQuery.data],
  );
  const agentNames = useMemo(
    () => new Set((agentsQuery.data ?? []).map((agent) => agent.name)),
    [agentsQuery.data],
  );

  const pluginCategories = useMemo(
    () => [...new Set(catalogue.map((item) => item.vendor))].sort(),
    [catalogue],
  );
  const botCategories = useMemo(
    () => [...new Set(BOT_TEMPLATES.map((template) => template.category))].sort(),
    [],
  );
  const skillCategories = useMemo(
    () =>
      [...new Set(w3Skills.map((skill) => W3_SKILL_CATEGORY[skill.slug] ?? "Outros"))].sort(),
    [w3Skills],
  );

  const categories =
    tab === "plugins" ? pluginCategories : tab === "bots" ? botCategories : skillCategories;

  const visiblePlugins = catalogue.filter(
    (item) =>
      (category === "Todos" || item.vendor === category) &&
      matches(query, item.title, item.vendor, item.summary),
  );
  const visibleBots = BOT_TEMPLATES.filter(
    (template) =>
      (category === "Todos" || template.category === category) &&
      matches(query, template.name, template.title, template.description),
  );
  const visibleSkills = w3Skills.filter(
    (skill) =>
      (category === "Todos" || (W3_SKILL_CATEGORY[skill.slug] ?? "Outros") === category) &&
      matches(query, skill.title, skill.slug, skill.summary),
  );

  const tabs: { key: Tab; label: string }[] = [
    { key: "plugins", label: "Plugins" },
    { key: "bots", label: "Bots" },
    { key: "skills", label: "Skills W3" },
  ];

  return (
    <PageShell
      description="Plugins, Bots prontos e Skills W3 num só lugar. Nada instala escondido: cada cartão diz o que entra e onde liga."
      title="Marketplace"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map((entry) => (
            <Button
              key={entry.key}
              onClick={() => {
                setTab(entry.key);
                setCategory("Todos");
              }}
              size="sm"
              type="button"
              variant={tab === entry.key ? "default" : "outline"}
            >
              {entry.label}
            </Button>
          ))}
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Buscar
          <input
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nome, fornecedor, resumo…"
            type="search"
            value={query}
          />
        </label>

        <CategoryChips active={category} categories={categories} onChange={setCategory} />

        {pluginsQuery.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Não foi possível carregar o marketplace.
          </p>
        ) : null}

        {tab === "plugins" ? (
          <PageSection title="Plugins">
            {visiblePlugins.length === 0 ? (
              <Empty className="mt-4 h-[140px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    Nenhum plugin encontrado.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <PageRows>
                {visiblePlugins.map((item, index) => (
                  <StaggerItem index={index} key={item.key}>
                    <PluginRow item={item} />
                  </StaggerItem>
                ))}
              </PageRows>
            )}
          </PageSection>
        ) : null}

        {tab === "bots" ? (
          <PageSection title="Bots">
            {visibleBots.length === 0 ? (
              <Empty className="mt-4 h-[140px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    Nenhum Bot encontrado.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <PageRows>
                {visibleBots.map((template, index) => (
                  <StaggerItem index={index} key={template.key}>
                    <BotRow
                      error={installError}
                      installed={agentNames.has(template.name)}
                      installing={install.isPending}
                      onInstall={() => {
                        setInstallError(null);
                        install.mutate(template);
                      }}
                      template={template}
                    />
                  </StaggerItem>
                ))}
              </PageRows>
            )}
          </PageSection>
        ) : null}

        {tab === "skills" ? (
          <PageSection title="Skills W3">
            {visibleSkills.length === 0 ? (
              <Empty className="mt-4 h-[140px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    Nenhuma Skill encontrada.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <PageRows>
                {visibleSkills.map((skill, index) => (
                  <StaggerItem index={index} key={skill.id}>
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>{skill.title}</ItemTitle>
                        <ItemDescription>
                          <code className="font-mono text-foreground/80 text-xs">
                            /{skill.slug}
                          </code>
                          {skill.summary ? ` · ${skill.summary}` : null}
                        </ItemDescription>
                        <SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />
                      </ItemContent>
                    </Item>
                  </StaggerItem>
                ))}
              </PageRows>
            )}
          </PageSection>
        ) : null}
      </div>
    </PageShell>
  );
}
