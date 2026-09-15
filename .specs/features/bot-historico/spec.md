# Bot Histórico Specification

**Source**: `.specs/features/bot-historico/design.md` (approved)
**Status**: Draft

---

## Problem Statement

Bots are used through loose channels in the sidebar: every conversation becomes a row in the general roster, with no fixed place per bot, no cross-session search, and no isolation. The ask is a fixed bot with current conversation + searchable History, where each conversation has its own context.

## Goals

- [ ] Person opens a fixed bot page with Conversa + Histórico tabs
- [ ] New conversations stay out of the general roster (server-side, not screen filter)
- [ ] History search finds by title/preview in phase 1
- [ ] Old conversations reopen read-only with a working Continue path

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| ------- | ------ |
| Full-text search inside conversation bodies | Phase 2 (GIN index later), no screen change |
| Per-connection socket filtering | Payload still arrives; only client routing changes |
| Conversation retention/expiry | Chat history is never deleted by code today |
| Model-generated titles | Title = first message / lastMessage |

---

## User Stories

### P1: Bot page with tabs ⭐ MVP

**User Story**: As a person, I want a fixed page per bot with Conversa + Histórico tabs so that my chats with that bot live in one place.

**Why P1**: Without the page there is nowhere to put History; it is the surface everything else hangs on.

**Acceptance Criteria**:

1. WHEN the person opens `/bot?agent=<id>` THEN system SHALL show the bot page with Conversa and Histórico tabs
2. WHEN the person switches tabs THEN system SHALL keep the other tab's state (no lost draft, no remount loop)

**Independent Test**: Open `/bot?agent=X`, see two tabs; type in Conversa, switch to Histórico and back, draft intact.

---

### P1: New conversation stays out of the roster ⭐ MVP

**User Story**: As a person, I want "Nova conversa" to start a fresh chat that does not pollute the general sidebar so that the roster stays clean.

**Why P1**: The core complaint is "a million different chats" dirtying the general context.

**Acceptance Criteria**:

1. WHEN the person presses "Nova conversa" THEN system SHALL create a channel with `visivel_no_roster=false` bound to the bot and open it empty in Conversa; the previous conversation stays listed in History
2. WHEN any client calls `GET /api/channels` THEN system SHALL never include a channel with `visivel_no_roster=false`

**Independent Test**: Create conversation on bot → `GET /api/channels` lacks it → `GET /api/bots/:id/conversas` has it.

---

### P1: History list with search ⭐ MVP

**User Story**: As a person, I want a searchable History tab per bot so that I can find an old chat by what it was about.

**Why P1**: Search is the explicit ask ("modo de busca").

**Acceptance Criteria**:

1. WHEN the person types in History search THEN system SHALL filter by `name` + `lastMessage`
2. WHEN the term exists only mid-conversation THEN system SHALL NOT return it (documented phase-1 limit)
3. WHEN the person scrolls THEN system SHALL page with a keyset cursor over the activity ordering without skipping/duplicating stable rows

**Independent Test**: 3 conversations; title term finds; mid-body-only term finds nothing; scroll pages all 3 exactly once.

---

### P1: Reopen old conversation read-only ⭐ MVP

**User Story**: As a person, I want to click a History item and read the old conversation as it was, with a Continue button, so that I can consult without disturbing current work.

**Why P1**: Read-only reopen is the chosen click behavior.

**Acceptance Criteria**:

1. WHEN the person clicks a History item THEN system SHALL open the conversation locked for reading, with a Continue button
2. WHEN the person presses Continue THEN system SHALL make it the active conversation

**Independent Test**: Open old item → composer absent/disabled → Continue → composer works, messages send into that thread.

---

### P2: Live history updates without roster churn

**User Story**: As a person with the bot page open, I want new activity to update History without refetching the whole sidebar so that nothing jumps.

**Why P2**: Correctness first (P1 works with refetch); this removes waste and staleness.

**Acceptance Criteria**:

1. WHEN hidden-channel activity arrives on the socket THEN system SHALL update the History query and SHALL NOT invalidate `channelKeys.list()`

**Independent Test**: Activity on hidden channel → roster query untouched (no invalidate), History list shows the bump.

---

### P2: Context isolation across conversations

**User Story**: As a person switching conversations, I want the model to receive only the open conversation so that old chats never leak into new answers.

**Why P2**: Architectural guarantee; largely inherited from per-thread hydrate, pinned by test.

**Acceptance Criteria**:

1. WHEN switching conversations THEN system SHALL never concatenate histories — only the open thread hydrates

**Independent Test**: Two conversations with distinct planted facts; ask in B for A's fact → model never receives A's thread (assert hydrate/thread scoping, not model output).

---

## Edge Cases

- WHEN a conversation receives a message between page 1 and page 2 THEN system SHALL admit top-duplicate or page-2 absence (mutable recency anomaly), and SHALL NEVER return an already-listed item at the same position twice without new activity
- WHEN `GET /api/bots/:id/conversas` gets an invalid cursor THEN system SHALL answer 400 with a dito error, not 500
- WHEN `limit` is out of range THEN system SHALL clamp to 1..100 (audit.ts rule)
- WHEN a non-member requests another user's bot conversations THEN system SHALL NOT leak existence (same-shape 404 as unknown channel)
- WHEN the bot page opens with unknown `?agent=` THEN system SHALL show the dito missing-bot state, not an empty chat

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

| Requirement ID | Story | Phase | Status | Tasks |
| -------------- | ----- | ----- | ------ | ----- |
| BH-01 | P1: Bot page with tabs | Implementation | Implementing | T4 |
| BH-02 | P1: New conversation stays out of the roster | Implementation | Implementing | T1, T2, T4 |
| BH-03 | P1: History list with search | Implementation | Implementing | T2, T4 |
| BH-04 | P1: Reopen old conversation read-only | Implementation | Implementing | T4 |
| BH-05 | P2: Live history updates without roster churn | Implementation | Implementing | T3 |
| BH-06 | P2: Context isolation across conversations | Implementation | Implementing | T5 |
| BH-07 | Edge: mutable-cursor anomaly + error shape | Implementation | Implementing | T2 |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`, `NOTIF-02`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 7 total, 7 mapped to tasks, 0 unmapped

---

## Success Criteria

How we know the feature is successful:

- [ ] Person opens bot page, starts 3 conversations, finds one by search, reopens it read-only, continues it
- [ ] General roster never shows bot conversations during the whole flow
- [ ] Zero errors in the cursor/search/error-shape matrix
