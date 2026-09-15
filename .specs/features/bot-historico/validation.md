# Bot Histórico Validation

**Date**: 2026-09-15
**Spec**: `.specs/features/bot-historico/spec.md`
**Design**: `.specs/features/bot-historico/design.md`
**Tasks**: `.specs/features/bot-historico/tasks.md`
**Verifier**: independent (did not write the code). Evidence or zero: every PASS cites a file:line I read or a command I ran. Anything not exercised is INCONCLUSIVE, never PASS.
**Commits**: `459d4ea` (T1), `ec31f30` (T2), `eb3e081` (T3), `2dce0ab` (T4), `ac203f7` (T5), branch `local-fork`.

---

## Task Completion

| Task | Status | Notes |
| ---- | ------ | ----- |
| T1 | Done | Column + partial index present in schema and in live DB (`psql \d channels` shows `visivel_no_roster boolean NOT NULL DEFAULT true` and `channels_bot_history_idx ... WHERE visivel_no_roster = false`) |
| T2 | Done | All Done-when boxes hold, with two coverage gaps noted under BH-03/BH-07 (mid-body exclusion and limit-clamp extremes have code but no test) |
| T3 | Done | Both directions hold; one new biome violation in its test file (see Commands §6) |
| T4 | Done | All Done-when boxes hold |
| T5 | Partial | Isolation pin is real (mutation check reproduced below). "Biome clean on touched files" is ticked but NOT satisfied: `app/tests/channel-events.test.tsx:21` fails `biome check` |

---

## User Story Validation

### P1: Bot page with tabs (BH-01) — MVP

| Criterion | Result |
| --------- | ------ |
| WHEN person opens `/bot?agent=<id>` THEN system shows Conversa + Histórico tabs | PASS — `app/src/components/bot/bot-tabs.tsx:28-57` renders both `role="tab"` buttons; `app/tests/bot-historico.test.tsx:238-243` asserts both exist |
| WHEN person switches tabs THEN other tab's state kept (no lost draft, no remount loop) | PASS — both panels stay mounted; hidden tab gets `className "hidden"` + `aria-hidden`, never unmounted (`bot-tabs.tsx:59-71`). Draft-survival test types "minuta", switches twice, value intact (`bot-historico.test.tsx:245-261`, passing in the 11/11 run) |

**Status**: BH-01 Complete

### P1: New conversation stays out of the roster (BH-02) — MVP

| Criterion | Result |
| --------- | ------ |
| WHEN person presses "Nova conversa" THEN system creates channel with `visivel_no_roster=false` bound to the bot, opens it empty in Conversa, previous conversation stays in History | PASS — POST body `{ agentIds: [botId], visivelNoRoster: false }` (`bot-history-list.tsx:46`); create honors it with default `?? true` (`server/src/channels/routes.ts:157`); Continue/Nova-conversa both route through `abrirNaConversa` which sets the channel active and jumps to Conversa (`bot.tsx:78-87`); "Nova conversa abre vazia, sem herdar a anterior" passes (`bot-historico.test.tsx:447-471`) |
| WHEN any client calls `GET /api/channels` THEN hidden channels never included (server-side WHERE, not screen filter) | PASS — `.where(eq(channels.visivelNoRoster, true))` inside `list()` (`routes.ts:222-257`), with comment stating why it must be server-side. Store-level test: hidden created → `store.list(owner)` is `[]` while `listBotConversations` returns it (`bot-history.test.ts:158-168`); HTTP-level test: POST hidden → `GET /ch` returns `{ channels: [] }` and history has it (`bot-history.test.ts:213-235`) |
| `create` defaults to visible | PASS — schema `.notNull().default(true)` (`server/src/db/schema/core.ts:260`), `options?.visivelNoRoster ?? true` (`routes.ts:157`), "create defaults to visible" test (`bot-history.test.ts:202-211`) |

**Status**: BH-02 Complete

### P1: History list with search (BH-03) — MVP

| Criterion | Result |
| --------- | ------ |
| WHEN person types in History search THEN server filters by `name` + `lastMessage` | PASS — `or(ilike(channels.name, term), ilike(channels.lastMessage, term))` (`routes.ts:359-363`); "finds by channel name" and "finds by last message preview" against a real DB (`bot-history.test.ts:256-303`); app test asserts the query string reaches the server (`q=fatura`) rather than filtering locally (`bot-historico.test.tsx:265-291`) |
| WHEN term exists only mid-conversation THEN system returns nothing | INCONCLUSIVE — the predicate only touches `name`/`lastMessage` columns so a mid-body term *cannot* match through this code path, but no test plants body text (e.g. in `local_thread_history`) and asserts exclusion. "a term that matches nothing returns nothing" (`bot-history.test.ts:305-322`) uses a nonsense term, which does not exercise the documented phase-1 boundary |
| WHEN person scrolls THEN keyset cursor over activity ordering, no skip/duplicate of stable rows | PASS — predicate `(activity < cursor) OR (activity = cursor AND id < cursor.id)` over `ORDER BY activity DESC, id DESC` with `limit+1`/`hasNextPage` (`routes.ts:364-376,404-418`); "pages three conversations exactly once when nothing moves" (`bot-history.test.ts:348-365`); app "carregar mais pagina sem pular" passes |

**Status**: BH-03 Partial (criterion 2 unexercised). Minor adjacent caveat (P3, not a criterion fail): the search term is wrapped in `%...%` raw (`routes.ts:311`), so user-typed `%`/`_` act as LIKE wildcards. Verified `%` is a wildcard in this DB (`psql`: `'anything' ILIKE '%'` → `t`). No other server search escapes wildcards either (only `ilike` site in `server/src`), so this matches existing rigor — noted, not charged.

### P1: Reopen old conversation read-only (BH-04) — MVP

| Criterion | Result |
| --------- | ------ |
| WHEN person clicks a History item THEN conversation opens locked for reading, with Continue | PASS — detail renders `ChatTranscript` from `readThreadMessages`, no composer anywhere in the file, Continue + Voltar buttons (`bot-history-detail.tsx:17-79`); test asserts messages shown, `queryByRole("textbox")` null, Continue hands back `c1` (`bot-historico.test.tsx:374-404`) |
| WHEN person presses Continue THEN it becomes the active conversation | PASS — `onContinuar={abrirNaConversa}` (`bot.tsx:94`) sets it active, clears detail, switches tab (`bot.tsx:78-82`); "Continuar traz a conversa escolhida para a aba Conversa" asserts tab flip + transcript + composer presence (`bot-historico.test.tsx:421-445`) |

**Status**: BH-04 Complete

### P2: Live history updates without roster churn (BH-05)

| Criterion | Result |
| --------- | ------ |
| WHEN hidden-channel activity arrives THEN History query updates and `channelKeys.list()` is NOT invalidated | PASS — socket branch `if (activity.visivelNoRoster === false) { patchBotConversas(activity); return; }` (`use-channel-events.ts:128-130`); test asserts roster array identity unchanged (`toBe(rosterBefore)`) and History patched (`channel-events.test.tsx:121-155`); unknown-id case invalidates `bots` but never `channels` (`channel-events.test.tsx:157-189`); visible path unchanged and still patches roster (`channel-events.test.tsx:191-221`) |
| Visibility flag read from channel row at emit time, not trusted from reporter | PASS — `recordActivity` re-selects `channels.visivelNoRoster` in the same transaction and comments exactly why (`routes.ts:474-496`); integration test announces with `visivelNoRoster:false` and asserts the payload carries `false` (`channel-events.integration.test.ts:194-249`) |

**Status**: BH-05 Complete. One adjacent observation (P3, outside the criterion, which covers the socket path only): `BotHistoryList`'s Nova-conversa `onSuccess` invalidates `channelKeys.all` (`bot-history-list.tsx:61-64`), which includes the roster list — one wasteful roster refetch per new hidden conversation. Result stays correct (roster still excludes it); waste only.

### P2: Context isolation across conversations (BH-06)

| Criterion | Result |
| --------- | ------ |
| WHEN switching conversations THEN never concatenate histories — only the open thread hydrates | PASS — hydrate reads `channel.threadId` with a generation guard discarding late answers for a previous thread (`channel-chat.tsx:103-149`, read call at `:117-120`, deps include `channel.threadId` at `:146`); pin test plants distinct facts per thread, continues each, asserts only the own fact renders and each fake store holds only its own messages (`bot-historico.test.tsx:474-514`); server side: one bot's list never contains another's (`bot-history.test.ts:170-186`) |
| Mutation check: hydrate a fixed thread id → the pin must fail; restore → green + worktree clean | REPRODUCED — temporarily replaced `channel.threadId` with `"thread-c1"` in `channel-chat.tsx:117-120`: `bun test app/tests/bot-historico.test.tsx` → **10 pass / 1 fail**, the failing test being exactly "trocar de conversa não junta os históricos". Restored via `git checkout --`, `diff` against pre-mutation copy IDENTICAL, re-run **11 pass / 0 fail**. The pin genuinely bites |

**Status**: BH-06 Complete

### Edge: cursor anomaly + error shape (BH-07)

| Criterion | Result |
| --------- | ------ |
| Mutable-recency anomaly admitted, never same-position duplicate without new activity | PASS — both EARS-07 directions tested against a real DB: activity on unlisted row → absent from page 2, zero overlap with page 1 (`bot-history.test.ts:367-391`); activity on listed row → moves out of next page, page 2 is exactly `[oldest]` (`bot-history.test.ts:393-414`) |
| Invalid cursor → 400 with Portuguese message, never 500 | PASS — `BotHistoryCursorError("cursor de paginação inválido")` (`routes.ts:515-520`), caught in route → 400 (`bot-history-routes.ts:74-76`); HTTP test asserts status 400 + exact body (`bot-history.test.ts:416-424`) |
| `limit` clamped to 1..100 | INCONCLUSIVE — clamp code exists at BOTH layers (route `Math.min(Math.max(requestedLimit,1),100)` at `bot-history-routes.ts:55-61`; store `Math.min(Math.max(Math.trunc(...),1),100)` at `routes.ts:305-307`), but the only test is the happy path `limit=1` (`bot-history.test.ts:426-438`). No test sends `0`, `-5`, `101`, `1000`, or `abc` (NaN→50 default) |
| Non-member / unknown bot share same 404 shape, no existence leak | PASS — single branch returns `{ error: "Channel not found." }` 404 for missing/unreadable profile (`bot-history-routes.ts:50-52`); test asserts `denied.body` equals `unknown.body` (`bot-history.test.ts:441-456`) |

**Status**: BH-07 Partial (limit-clamp extremes unexercised)

---

## Edge Cases (spec.md list)

- [x] Message between page 1 and page 2 → top-duplicate/page-2-absence admitted, never same-position duplicate: handled, both directions tested (BH-07 row 1)
- [x] Invalid cursor → 400 dito, not 500: handled (`bot-history-routes.ts:74-76`, `routes.ts:515-520`)
- [ ] `limit` out of range → clamp 1..100: code clamps at both layers, but only `limit=1` is tested — INCONCLUSIVE as tested behavior
- [x] Non-member request → same-shape 404, no leak: handled + tested
- [x] Unknown `?agent=` → dito missing-bot state, not empty chat: handled (`bot.tsx:50-58` renders "Não foi possível carregar este colega.", no tabs) + tested (`bot-historico.test.tsx:406-417`, asserts `queryByRole("textbox")` and `queryByRole("tab")` null)

## Success Criteria (spec.md list)

- [x] Person opens bot page, starts 3 conversations, finds one by search, reopens read-only, continues it — each leg covered by a passing test (server 3-conversation paging; app search-hits-server, read-only detail, Continue-to-Conversa). Compositional, not one end-to-end script — stated plainly
- [x] General roster never shows bot conversations during the whole flow — server-side WHERE (`routes.ts:257`) + HTTP-level test (`bot-history.test.ts:213-235`)
- [ ] Zero errors in the cursor/search/error-shape matrix — cursor + error shapes fully green; search mid-body exclusion and limit-clamp extremes are code-only, untested (see BH-03/BH-07)

---

## Commands (real runs, 2026-09-15)

1. **Full repo gate**: `DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot bun test` (repo root) → **1439 pass / 32 skip / 0 fail, 3536 expects, 1471 tests across 151 files** (~13 s). Skips are pre-existing suite skips (none added by this feature; `grep test.skip` in the three feature test files finds nothing; the 32 are repo-wide pre-existing). Noise (not failures): `act(...)` warnings and a "Maximum update depth exceeded" message from `app/tests/channel-history.test.tsx` — pre-existing, unrelated file, suite still green.
2. **Server channel slice**: `DATABASE_URL=... bun test server/tests/bot-history.test.ts server/tests/channel-routes.test.ts server/tests/channel-activity.integration.test.ts server/tests/channel-events.integration.test.ts` → **71 pass / 0 fail**.
3. **BH-06 mutation probe**: mutated `channel-chat.tsx:117-120` to `readThreadMessages("thread-c1", ...)`: `bun test app/tests/bot-historico.test.tsx` → **10 pass / 1 fail** (failing test exactly the isolation pin). Restored (`git checkout --`, byte-identical to pre-mutation copy) → **11 pass / 0 fail**. `git status --porcelain` for that file: clean.
4. **Typecheck**: `cd app && bunx tsc --noEmit` → clean (rc=0). `cd server && bunx tsc --noEmit` → clean (rc=0).
5. **Compose**: `docker compose config > /dev/null` → **rc=0**.
6. **Biome on feature-touched files**: `bunx biome check` over the 12 prod files + 4 test files → **1 error, introduced by this feature**: `app/tests/channel-events.test.tsx:21:1 assist/source/organizeImports` (missing blank line before the `import type` after a dynamic `await import`). Excluded from the clean verdict: `server/src/app.ts` organizeImports and `server/src/db/schema/core.ts` formatting also fail — but both fail identically on the pre-feature baseline (`git show fcb1611:...`), so they are pre-existing, not this feature's debt. **Consequence: T5's ticked "biome clean on touched files" is not actually satisfied** (1 new violation, trivially fixable; read-only verifier leaves it untouched).
7. **DB ground truth**: `psql ... -c "\d channels"` confirms `visivel_no_roster boolean NOT NULL DEFAULT true` and `channels_bot_history_idx ... WHERE visivel_no_roster = false` live in the database, not just the schema file. `SELECT 'anything' ILIKE '%'` → `t` confirms the LIKE-wildcard caveat above.

---

## Test Quality (plain verdicts)

- **Server `bot-history.test.ts` (16 tests): strong.** Real DB, real store, HTTP-level assertions (status + body). Both EARS-07 directions, per-bot scoping, 404-shape equality are behavioral, not wiring. Gaps: no mid-body-exclusion test, no limit-extreme test (both noted above as INCONCLUSIVE, not fails).
- **`app/tests/channel-events.test.tsx`: good, one padded test.** The three routing tests assert the true observable contract (roster object identity via `toBe`, History content, which top-level key gets invalidated) — that is behavior for a cache-router, not implementation detail. But **"botKeys scope History per bot and search" asserts the literal key array** (`toEqual(["bots","conversas","bot-1","fatura"])`) — a field-copy of an internal key shape. It fails if the key is renamed without any behavior change. Padded/implementation-detail; the per-bot isolation it gestures at is already proven behaviorally by the server test "one bot's conversations stay out of another bot's history".
- **`app/tests/bot-historico.test.tsx` (11 tests): good, one structural risk.** Tests assert rendered text, tab state, request bodies — behavioral. Risk: the `fetch` stub **reimplements** server filtering/sorting/paging with its own id-based cursor (`bot-historico.test.tsx:142-166`), while the real server cursor is an `(activityAt, id)` tuple. The "carregar mais pagina sem pular" test therefore exercises the mock's paging, not the server's. Mock and server agree today (both suites green), but a future cursor regression would not be caught on the client side. Also `useBotThread` is stubbed to `undefined` process-wide via `mock.module` — contained today (only `bot.tsx` consumes it), but any future test file rendering the bot page inherits that stub silently.
- **`app/tests/copilot-fake.ts` shared factory: sound.** Bun applies `mock.module` process-wide and last-registration-wins, so the previous two-fakes arrangement was genuinely hazardous (one file's fake silently replacing the other's). Both files now registering the *same* factory removes the divergence mode: whichever wins is identical. No ordering hazard remains *as long as* the factory stays single — reintroducing a second factory would resurrect the bug. Per-thread stores plus `resetCopilotFake` in `beforeEach` give isolation; the isolation pin itself depends on this (per-thread, not canned, answers).
- **Tautologies/padding**: none found that assert nothing (no bare not-throw, no length-grew checks). The key-shape test is the only padding-adjacent item.

---

## Scope Discipline (design.md:46 "Tabs around existing CopilotChat")

**Confirmed.** `BotChat` (`bot.tsx:63-123`) renders `<BotDirectChat>` — the direct `CopilotChat` on the deployment-minted thread — whenever no conversation is active (`bot.tsx:84-88`); `ativa` starts `null` (`bot.tsx:70`) and is only set by Continue/Nova-conversa (`bot.tsx:78-82`). No fetch of recent conversations, no auto-open effect (no `useEffect` in `BotChat`). Sidebar addition is the expected entry point (a hidden-conversation bot would otherwise be unreachable). No unrequested behavior found.

---

## Findings (defects / ticked-but-unsatisfied)

1. **T5 "biome clean on touched files" ticked but not satisfied** — `app/tests/channel-events.test.tsx:21`, `assist/source/organizeImports` (missing blank line), introduced in `eb3e081`. P3 (lint-only, one blank line). Fix: insert blank line before `import type { ChannelSummary }...`, verify with `bunx biome check` on the file.
2. **Mid-body search exclusion untested** (spec acceptance BH-03.2, T2 Done-when "mid-body-only term returns nothing"). Code path implies it; no test plants thread-body text and queries it. Recommend one server test: store a distinctive token only in thread history for a hidden channel, query it, expect `[]`.
3. **Limit-clamp extremes untested** (spec edge "clamp to 1..100", T2 Done-when silent on extremes). Recommend HTTP tests: `?limit=0` and `?limit=1000` behave as `1` and `100` (or at minimum don't error and respect bounds).
4. **P3 observation — LIKE wildcards unescaped** (`routes.ts:311`): user `%`/`_` act as wildcards. Matches existing repo rigor (no other search escapes); fixing would exceed the approved "ILIKE only" phase-1 design. Noted, not charged.
5. **P3 observation — Nova-conversa invalidates `channelKeys.all`** (`bot-history-list.tsx:61-64`): one wasteful roster refetch per new hidden conversation. Correct result, minor waste. Not charged against BH-05 (socket path is clean).

No requirement is missed by the implementation itself: all seven BH requirements have working code paths; the gaps are test-coverage gaps (items 2–3) and one lint line (item 1).

---

## Requirement Traceability

| Requirement | Previous Status | New Status |
| ----------- | --------------- | ---------- |
| BH-01 | Implementing | Verified |
| BH-02 | Implementing | Verified |
| BH-03 | Implementing | Verified (mid-body gap closed post-validation, mutation-proven) |
| BH-04 | Implementing | Verified |
| BH-05 | Implementing | Verified |
| BH-06 | Implementing | Verified (mutation-proven) |
| BH-07 | Implementing | Verified (clamp gap closed post-validation, mutation-proven) |

(Spec.md statuses intentionally left untouched by the verifier; the author updated them after closing the gaps below.)

---

## Summary

**Overall**: Issues (minor) — feature works, two test-coverage gaps + one lint line keep it from fully verified.

**What works**: Tabs with draft survival; server-side roster exclusion with visible default; name+lastMessage search; stable keyset paging with both anomaly directions; read-only reopen with Continue-to-active; hidden-activity routing that never touches the roster with the flag read from the row at emit time; thread-scoped hydration proven by a biting mutation test; 400-PT cursor errors; same-shape 404s; unknown-agent dito state; no scope creep around CopilotChat. Full suite 1439/0, both typechecks clean, compose rc=0.

**Issues found**: (1) biome violation in `app/tests/channel-events.test.tsx:21` contradicts ticked T5 gate — one blank line; (2) mid-body-exclusion acceptance has no test — needs one server test planting body-only text; (3) limit-clamp extremes (`0`, `1000`, `abc`) have no test — needs two or three HTTP assertions; (4–5) two P3 observations (LIKE wildcards, Nova-conversa roster invalidate) — note, don't block on.

**Next steps**: Author (not verifier) adds the ~4 small tests + blank line, re-runs the four commands in §Commands, then BH-03/BH-07 flip to Verified.

---

## Post-validation (author, after the verifier's report)

Every charged finding closed; the two P3 observations answered explicitly.

| # | Finding | Action |
| - | ------- | ------ |
| 1 | biome `organizeImports` at `app/tests/channel-events.test.tsx:21` | The `import type { ChannelSummary }` moved up beside the other static imports — types are erased, so it never needed to be dynamic. `bunx biome check` over all 13 feature-touched files: clean. T5's ticked box now holds. |
| 2 | mid-body exclusion untested (BH-03.2) | `server/tests/bot-history.test.ts` — "a term said earlier in the conversation is out of reach": a word from the first message, overwritten in the preview by a later one, finds nothing; the later word still finds the row. Bites: replacing `ilike(channels.lastMessage, term)` with a second `name` match fails it (and the preview test) — 2 fail, restored to 19 pass. |
| 3 | limit-clamp extremes untested (BH-07) | Three tests. Store-level (`limit: 0 / -5 / 1000`) because the route clamps as well and would hide a store regression; HTTP-level asserting out-of-range and unparseable answer 200, never 400/500. The first store test only planted 3 rows, so `limit: 1000` could not tell a working ceiling from a missing one — "the ceiling holds with more conversations than the page fits" plants 101 hidden channels and asks for 1000: the page must be exactly 100 with a cursor, and that cursor must reach the 101st. Bites: dropping the store's floor fails it — 0 pass / 1 fail; dropping the ceiling fails it too — 0 pass / 1 fail; restored to 21 pass. |
| 4 | LIKE wildcards unescaped (`routes.ts:311`) | Left as is, deliberately. `%`/`_` are wildcards, not injection — the term is a bound parameter. Escaping them is a search-semantics change outside the approved phase-1 "ILIKE only" design, and no other search in the repo escapes them; changing one in isolation would make the app inconsistent. |
| 5 | Nova conversa invalidated `channelKeys.all` | Fixed in `app/src/components/channels/bot-history-list.tsx`: the invalidation is gone and `channelKeys` with it. The channel is created with `visivelNoRoster: false`, so `GET /api/channels` cannot return it — the refetch asked the server for a list that could not have changed. This was the one place the feature still churned the roster. Pinned by "nova conversa cria canal oculto sem mexer no roster" (`app/tests/bot-historico.test.tsx`), which fails if the roster invalidation comes back. |
| 6 | **Defect the verifier missed** — `limit + 1` counted join rows, not conversations (`routes.ts`, `listBotConversations`) | The query joined `channelAgents` (one row per agent) and applied `.limit(limit + 1)` to those rows, deduping afterwards. A conversation with two agents filled both slots, so `items.length > limit` stayed false, `nextCursor` was dropped, and every older conversation became unreachable — silently, with nothing failing. Reachable through the public API: `POST /api/channels {agentIds:[bot, other], visivelNoRoster:false}`, and the list matches channels where the bot is *among* the agents. Violated BH-03 AC3. Fixed by deciding the page over channels alone, then fetching the agents of the chosen ids with `inArray`. Pinned by "a conversation with two agents does not eat another's page slot", written RED first (`nextCursor` undefined) and green after. |

**Overall after fixes**: all seven requirements Verified; BH-03, BH-06 and BH-07 each pinned by a test proven to fail under a single-point mutation of the code it guards.
