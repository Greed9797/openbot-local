# Bot Histórico Tasks

**Design**: `.specs/features/bot-historico/design.md`
**Status**: Approved

---

## Execution Plan

### Phase 1: Data (Sequential)

Migration first — everything reads the flag.

```
T1 → T2
```

### Phase 2: Server (Sequential on T1)

Endpoint before realtime (routes exist before events use them).

```
T2 → T3
```

### Phase 3: App (Sequential on T2)

UI consumes the endpoint; realtime routing lands with the UI that observes it.

```
T3 → T4 → T5
```

---

## Task Breakdown

### T1: Add visivel_no_roster to channels

**What**: Schema column + partial index + generated migration.
**Where**: `server/src/db/schema/core.ts`, `server/drizzle/NNNN_*.sql`
**Depends on**: None
**Reuses**: `channels_recent_activity_idx` declaration pattern
**Requirement**: BH-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `channels.visivel_no_roster boolean not null default true` in schema + partial index where false
- [x] Migration generated via `db:generate`, applies cleanly to test DB
- [x] Gate check passes: `cd server && DATABASE_URL=... bun test tests/channel-routes.test.ts`
- [x] Test count: 42 pass (no silent deletions; no new tests — column-only, default preserves rows)

**Tests**: none (schema-only; covered by T2's store tests)
**Gate**: quick

**Commit**: `feat(bot-historico): add visivel_no_roster to channels`

---

### T2: Bot conversations endpoint + roster filter

**What**: `listBotConversations` store method, `GET /api/bots/:id/conversas`, `create` accepts visibility, `list` excludes hidden.
**Where**: `server/src/channels/routes.ts` (modify), `server/src/channels/bot-history-routes.ts` (new), `server/src/app.ts` (mount), `server/tests/bot-history.test.ts` (new)
**Depends on**: T1
**Reuses**: `list()` joins, `isThreadReadableBy`, `audit.ts` cursor/clamp
**Requirement**: BH-02, BH-03, BH-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Hidden conversation absent from `GET /api/channels`, present in `GET /api/bots/:id/conversas`
- [x] Search filters `name` + `lastMessage`; mid-body-only term returns nothing
- [x] 3-conversation cursor test pins both EARS-07 directions
- [x] Invalid cursor → 400 dito; non-member → same-shape 404
- [x] Gate check passes: `cd server && DATABASE_URL=... bun test tests/bot-history.test.ts tests/channel-routes.test.ts tests/channel-activity.integration.test.ts`
- [x] Test count: new file ≥8 tests pass + 42 existing pass

**Tests**: integration
**Gate**: full

**Commit**: `feat(bot-historico): bot conversations endpoint with search and cursor`

---

### T3: Route hidden activity to History, not the roster

**What**: `visivelNoRoster` on `ChannelActivityEvent`, emitted in `recordActivity`, client routes to History query.
**Where**: `server/src/channels/events.ts` (modify), `server/src/channels/routes.ts` (emit), `app/src/lib/channels/use-channel-events.ts` (modify), `app/src/lib/channels/queries.ts` (botKeys), tests both sides
**Depends on**: T2
**Reuses**: existing patch/sort `byRecency`; `botKeys` beside `channelKeys`
**Requirement**: BH-05

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Hidden-channel activity does NOT invalidate `channelKeys.list()`
- [x] Hidden-channel activity updates the History query data
- [x] Visible-channel behavior unchanged (existing tests green)
- [x] Gate check passes: server channel tests + `cd app && bun test tests/channel-history.test.tsx`
- [x] Test count: no deletions; new assertions pass

**Tests**: integration (server) + unit (app hook)
**Gate**: full

**Commit**: `feat(bot-historico): route hidden activity to History query`

---

### T4: Bot page tabs + History list UI

**What**: `/bot` tabs (Conversa/Histórico), searchable infinite list, read-only reopen + Continue, sidebar entry, Nova conversa.
**Where**: `app/src/routes/_authed/_app/bot.tsx` (modify), new list component + `useBotConversas`, `app/tests/bot-historico.test.tsx` (new)
**Depends on**: T3 (query keys + routing; endpoint T2 via transitividade T2 → T3)
**Reuses**: `ChannelChat`, `useStartChannel` seed pattern, `tasks/queries.ts` URLSearchParams pattern
**Requirement**: BH-01, BH-03, BH-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Two tabs render; draft survives tab switch
- [x] Search filters; scroll pages; item opens read-only with Continue
- [x] Continue makes it the active conversation; Nova conversa archives + zeroes
- [x] Unknown `?agent=` shows dito missing-bot state
- [x] Gate check passes: `cd app && bun test tests/bot-historico.test.tsx` (10 pass / 0 fail)
- [x] Test count: new file 10 tests pass; app suite 158 pass / 0 fail (`marketplace.test.ts` reads a repo-root-relative path and only passes from the repo root, where it does)

**Tests**: unit (testing-library, mocked fetch)
**Gate**: quick (file) then full suite

**Commit**: `feat(bot-historico): bot page tabs with searchable History`

---

### T5: Isolation pin + final gates

**What**: Thread-scoping test (BH-06) + repo-wide gates + biome.
**Where**: `server/tests/bot-history.test.ts` (append) or focused new assertions; no prod code unless a gap surfaces
**Depends on**: T4
**Reuses**: hydrate/preload scoping, existing runner tests
**Requirement**: BH-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Switching conversations never concatenates histories (assert thread scoping, not model output) — `app/tests/bot-historico.test.tsx` "trocar de conversa não junta os históricos"; proven to bite by mutating the hydrate to read a fixed thread (1 fail), restored after
- [x] `bun test` whole repo green (1439 pass / 0 fail, 151 files); `docker compose config` rc=0; biome clean on touched files
- [x] Gate check passes: full `bun test` + `tsc --noEmit` clean in `app/` and `server/`

**Tests**: integration
**Gate**: build

**Commit**: `test(bot-historico): pin conversation isolation and final gates`

---

## Parallel Execution Map

```
Phase 1 (Sequential):
  T1 ──→ T2

Phase 2 (Sequential):
  T2 ──→ T3

Phase 3 (Sequential):
  T3 ──→ T4 ──→ T5
```

**Parallelism constraint:** No `[P]` flags — every task touches the channel data path; shared migration/store/event/UI state. Sequential by design, not by caution.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: schema + migration | 1 column + 1 index + 1 generated file | ✅ Granular |
| T2: endpoint + filter | 1 store method + 1 route file + mount + 1 test file | ✅ Granular (one endpoint) |
| T3: realtime routing | 1 event field + emit + 1 hook + keys | ✅ Granular (one signal) |
| T4: bot page UI | 1 route + 1 list + 1 hook + 1 test file | ✅ Granular (one surface) |
| T5: isolation pin + gates | assertions + repo gates, no new surface | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | root | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T2 | T2 → T3 | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |

---

## Test Co-location Validation

No `.specs/codebase/TESTING.md` exists; repo convention (observed): server channel behavior → `server/tests/*.integration.test.ts` + `channel-routes.test.ts` via bun; app UI → `app/tests/*.test.tsx` via bun. Every task creating prod code ships its tests in the same task/commit.

| Task | Code Layer Created/Modified | Task Says | Status |
| ---- | --------------------------- | --------- | ------ |
| T1 | schema only (default preserves) | none | ✅ OK (covered by T2) |
| T2 | store + route (integration) | integration | ✅ OK |
| T3 | event + hook (both sides) | integration + unit | ✅ OK |
| T4 | route + component (UI) | unit | ✅ OK |
| T5 | assertions + gates | integration | ✅ OK |
