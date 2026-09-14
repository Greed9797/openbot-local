# Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/marketplace` page with Plugins, Bots and W3 Skills tabs that installs through existing flows.

**Architecture:** No new backend mechanics: W3 skills seed via idempotent SQL migration, bot templates live as a frontend constant, installs call existing `POST /servers`, agent create and `POST /grants` endpoints.

**Tech Stack:** Bun, Hono, Drizzle/Postgres, React 19, TanStack Router/Query, Tailwind v4.

**Spec:** `.specs/features/marketplace/design.md`

## Global Constraints

- No external connection, credential or routine activation in v1.
- Routines stay `active: false` and out of scope.
- No mock install buttons: no backend means no button.
- Portuguese UI copy, matching `/skills` and `/agents` tone.
- `bun run --cwd server typecheck`, `bun run --cwd app typecheck`, `bunx biome lint` on touched files.

---

## File Structure

- Create: `server/data/w3-skills/*.md` (14 verbatim copies from the W3 package `skills/*/SKILL.md`)
- Create: `server/drizzle/0010_w3_skills.sql` (idempotent seed, `origin = 'catalogue'`, `owner_user_id = NULL`)
- Create: `server/tests/marketplace-seed.integration.test.ts`
- Create: `app/src/components/marketplace/bot-templates.ts` (8 templates from COMPONENT_MAP)
- Create: `app/src/routes/_authed/_app/marketplace.tsx` (page + tabs + search)
- Modify: `app/src/components/app-sidebar/app-sidebar.tsx` (Marketplace entry below Agentes)
- Test: `app/tests/marketplace.test.ts`

---

### Task 1: W3 skill seed

**Files:**
- Create: `server/data/w3-skills/<14 slugs>.md` (copies, never edits, of the package files)
- Create: `server/drizzle/0010_w3_skills.sql`
- Test: `server/tests/marketplace-seed.integration.test.ts`

**Interfaces:**
- Consumes: `skills` table (`server/src/db/schema/plugins.ts`: `id, slug, owner_user_id NULL, title, summary, instructions, origin, installed_by`)
- Produces: 14 rows with `origin = 'catalogue'`; later tasks read them through the existing skills list path

Slugs (id = slug): `research-prospect`, `qualify-sales-opportunity`, `close-customer-loop`, `monitor-sales-pipeline`, `prepare-shopify-proposal`, `manage-shopify-project`, `audit-shopify-store`, `validate-shopify-launch`, `review-design`, `plan-seo-aeo-content`, `monitor-competitors`, `analyze-project-margin`, `research-product-opportunity`, `run-executive-review`. Title = slug humanizado (`research-prospect` → `Research Prospect`). Summary = campo `description:` do frontmatter de cada `SKILL.md`. Instructions = corpo do `SKILL.md` após o frontmatter.

SQL por skill (repetir 14x com valores próprios, escapar aspas simples dobrando):

```sql
INSERT INTO skills (id, slug, owner_user_id, title, summary, instructions, origin, installed_by)
VALUES ('research-prospect', 'research-prospect', NULL, 'Research Prospect', '<description>', '<corpo>', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;
```

- [ ] **Step 1: Write the failing test**

```typescript
// server/tests/marketplace-seed.integration.test.ts
import { describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { skills } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const EXPECTED_SLUGS = [
  "research-prospect",
  "qualify-sales-opportunity",
  "close-customer-loop",
  "monitor-sales-pipeline",
  "prepare-shopify-proposal",
  "manage-shopify-project",
  "audit-shopify-store",
  "validate-shopify-launch",
  "review-design",
  "plan-seo-aeo-content",
  "monitor-competitors",
  "analyze-project-margin",
  "research-product-opportunity",
  "run-executive-review",
];

describe("w3 skill seed", () => {
  test("seeds 14 catalogue skills", async () => {
    const rows = await database.select().from(skills);
    for (const slug of EXPECTED_SLUGS) {
      const row = rows.find((candidate) => candidate.slug === slug);
      expect(row).toBeDefined();
      expect(row?.origin).toBe("catalogue");
      expect(row?.ownerUserId).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/tests/marketplace-seed.integration.test.ts`
Expected: FAIL (14 slugs missing)

- [ ] **Step 3: Copy seed files and write migration**

```bash
mkdir -p server/data/w3-skills
for s in research-prospect qualify-sales-opportunity close-customer-loop monitor-sales-pipeline prepare-shopify-proposal manage-shopify-project audit-shopify-store validate-shopify-launch review-design plan-seo-aeo-content monitor-competitors analyze-project-margin research-product-opportunity run-executive-review; do
  cp "/Users/vitormiguelgoedertdaluz/Documents/Codex/2026-09-12/comece-fazendo-snapshot-da-p-gina-3/outputs/w3-agent-foundations/skills/$s/SKILL.md" "server/data/w3-skills/$s.md"
done
```

Then write `server/drizzle/0010_w3_skills.sql` with the 14 INSERTs above and apply with the project's migrate command.

- [ ] **Step 4: Run test to verify it passes, twice**

Run: `bun test server/tests/marketplace-seed.integration.test.ts`
Expected: PASS. Re-apply migration, run again: PASS (idempotent, no `skills_slug_key` violation).

- [ ] **Step 5: Commit**

```bash
git add server/data/w3-skills server/drizzle/0010_w3_skills.sql server/tests/marketplace-seed.integration.test.ts
git commit -m "feat: seed W3 catalogue skills"
```

### Task 2: Bot templates constant

**Files:**
- Create: `app/src/components/marketplace/bot-templates.ts`
- Produces: `BOT_TEMPLATES: { key, name, title, description, skills: string[], memories: string[] }[]` with 8 entries (Sales, Delivery, Shopify/QA, Design, Marketing, Finance/Ops, Product, Director) derived from `COMPONENT_MAP.md`; Task 4 maps `name` → agent create `name`, `title` → `title`, `description` → `roleDescription`, `visibility: "private"`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { BOT_TEMPLATES } from "@/components/marketplace/bot-templates";

describe("bot templates", () => {
  test("covers the 8 component-map responsibilities", () => {
    expect(BOT_TEMPLATES).toHaveLength(8);
    for (const template of BOT_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.title.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/tests/marketplace.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the constant** (8 entries; skills reference Task 1 slugs)
```typescript
export type BotTemplate = {
  key: string;
  name: string;
  title: string;
  description: string;
  skills: string[];
  memories: string[];
};

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    key: "sales",
    name: "Vendas",
    title: "Time comercial W3",
    description: "Prospecção, qualificação e pipeline no MCRM.",
    skills: ["research-prospect", "qualify-sales-opportunity", "close-customer-loop", "monitor-sales-pipeline", "prepare-shopify-proposal"],
    memories: ["ICP", "regras de qualificação", "ownership"],
  },
  // ... delivery, shopify-qa, design, marketing, finance-ops, product, director
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test app/tests/marketplace.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/components/marketplace/bot-templates.ts app/tests/marketplace.test.ts
git commit -m "feat: add marketplace bot templates"
```

### Task 3: Marketplace page with 3 tabs

**Files:**
- Create: `app/src/routes/_authed/_app/marketplace.tsx`
- Modify: `app/src/components/app-sidebar/app-sidebar.tsx` (Marketplace `SidebarMenuItem` below Agentes, `to="/marketplace"`, `IconBox`-style icon distinct from Habilidades)
- Test: extend `app/tests/marketplace.test.ts`

**Interfaces:**
- Consumes: `BOT_TEMPLATES` (Task 2); plugins list via the same query hook `/skills` page uses; W3 skills via the existing skills list query filtered by `origin === "catalogue"`
- Produces: rendered tabs `Plugins`, `Bots`, `Skills W3` with search input; Task 4 wires the Adicionar buttons

Follow `skills.tsx` patterns: `PageShell`, `PageSection`, `createFileRoute`, TanStack Query. Search filters name + description client-side. Category chips filter by template key / plugin category. Install buttons render disabled with title "Em breve" ONLY where Task 4 has no backend — but Task 4 covers all three, so no disabled buttons ship.

- [ ] **Step 1: Extend the test**

```typescript
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("marketplace page", () => {
  test("declares Plugins, Bots and Skills W3 tabs with search", async () => {
    const source = await readFile("app/src/routes/_authed/_app/marketplace.tsx", "utf8");
    expect(source).toMatch(/Plugins/);
    expect(source).toMatch(/Bots/);
    expect(source).toMatch(/Skills W3/);
    expect(source).toMatch(/Buscar/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/tests/marketplace.test.ts`
Expected: FAIL (file missing)

- [ ] **Step 3: Write the page** (tabs + search + sidebar entry; install handlers land in Task 4 as `onInstall*` props already calling the endpoints)

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/_app/marketplace")({
  component: Marketplace,
});

const TABS = ["Plugins", "Bots", "Skills W3"] as const;

function Marketplace() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Plugins");
  const [query, setQuery] = useState("");
  return (
    <PageShell title="Marketplace">
      <div role="tablist">
        {TABS.map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      <input placeholder="Buscar" value={query} onChange={(event) => setQuery(event.target.value)} />
      <PageSection>{tab === "Bots" ? <BotList query={query} /> : null}</PageSection>
    </PageShell>
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test app/tests/marketplace.test.ts` (PASS), `bun run --cwd app typecheck` (exit 0)

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/_authed/_app/marketplace.tsx app/src/components/app-sidebar/app-sidebar.tsx app/tests/marketplace.test.ts
git commit -m "feat: add marketplace page"
```

### Task 4: Install wiring through existing flows

**Files:**
  - Create: `app/src/lib/marketplace/queries.ts` (`marketplaceKeys = { all: ["marketplace"] as const }`, `marketplacePageQueryOptions()` reusing the plugins page query)
  - Create: `app/src/lib/marketplace/mutations.ts` (`installBotMutationOptions(queryClient: QueryClient)`, `installSkillMutationOptions(queryClient: QueryClient)` via `mutationOptions()`; `client()` from `@/lib/client`, never raw `fetch`)
  - Modify: `app/src/routes/_authed/_app/marketplace.tsx` (useMutation wiring + error text)
  - Test: extend `app/tests/marketplace.test.ts` + `server/tests/marketplace-seed.integration.test.ts`

Behaviors: Bot install posts `{ name: template.name, title: template.title, roleDescription: template.description, visibility: "private" }` (all required by `parseAgentInput`) then grants each `template.skills` via `POST /grants`; skill install posts `POST /grants { kind: "skill", ref: slug, agentId }` for the user's selected Bot (reuse the bot picker from `skill-agents.tsx`); plugin install navigates to the existing server-connect flow. Every failure surfaces the endpoint's error text; no silent no-op.

- [ ] **Step 1: Write failing tests** (grant round-trip: grant a W3 skill to a test agent, read back via `GET /for/:agentId`; bot-from-template creates an agent)

```typescript
test("granting a W3 skill to a bot is readable back", async () => {
  const agentId = await createTestAgent(database, "market-seed-bot");
  await pluginStore.grant("skill", "research-prospect", agentId, "tester@example.com");
  const granted = await pluginStore.listForAgent(agentId);
  expect(granted.skills).toContain("research-prospect");
  await pluginStore.revoke("skill", "research-prospect", agentId, "tester@example.com");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test server/tests/marketplace-seed.integration.test.ts app/tests/marketplace.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement handlers**
```tsx
// app/src/lib/marketplace/mutations.ts
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { BotTemplate } from "@/components/marketplace/bot-templates";
import { marketplaceKeys } from "./queries";

const FALLBACK = "Marketplace operation failed";

export function installBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (template: BotTemplate): Promise<void> => {
      const agent = await client<{ id: string }>("/api/agents", "agent", {
        method: "POST",
        body: { name: template.name, title: template.title, roleDescription: template.description, visibility: "private" },
        fallback: FALLBACK,
      });
      for (const skill of template.skills) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "skill", ref: skill, agentId: agent.id },
          fallback: FALLBACK,
        });
      }
    },
     onSuccess: () => queryClient.invalidateQueries({ queryKey: marketplaceKeys.all }),
  });
}

export function installSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { slug: string; agentId: string }): Promise<Response> =>
      client("/api/plugins/grants", {
        method: "POST",
        body: { kind: "skill", ref: input.slug, agentId: input.agentId },
        fallback: FALLBACK,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: marketplaceKeys.all }),
  });
}
```
- [ ] **Step 4: Run full gate**

Run: `bun test server/tests/marketplace-seed.integration.test.ts app/tests/marketplace.test.ts`, `bun run --cwd server typecheck`, `bun run --cwd app typecheck`, `bunx biome lint` on touched files
Expected: all exit 0

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/marketplace/queries.ts app/src/lib/marketplace/mutations.ts app/src/routes/_authed/_app/marketplace.tsx app/tests/marketplace.test.ts server/tests/marketplace-seed.integration.test.ts
git commit -m "feat: wire marketplace installs"
```
