# Codex Active Session Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex project and session browsing load active sessions newest-first, and make a session detail view poll only its newly appended messages.

**Architecture:** The backend scans only `~/.codex/sessions`, never `archived_sessions`. It caches the file paths discovered by paginated latest-first listings, then reads the target session's tail on first detail request and only the appended byte range on later updates. The frontend uses cursor pagination and performs no status requests on the session list.

**Tech Stack:** Node.js HTTP server, TypeScript, Vue 2 / uni-app.

## Global Constraints

- Do not read or index `archived_sessions`.
- Do not synchronously read directories or session files in HTTP handlers.
- List endpoints are newest-first and paginated; they do not calculate a global total.
- Session activity checks and message polling occur only after the detail page opens.
- No test files are added; perform build and manual API verification after implementation.

---

### Task 1: Active-session discovery and incremental reader

**Files:**
- Modify: `src/codex/codex-sessions.ts`
- Modify: `src/codex/manager.ts`

**Produces:** async newest-first active-session listing, a bounded session-path cache, initial snapshot and byte-cursor update readers.

- [ ] Replace synchronous scans and whole-file reads with `fs.promises` directory/header/tail reads limited to active sessions.
- [ ] Add opaque cursor pagination and cache each discovered session id with its file path.
- [ ] Add snapshot and update functions that emit user/assistant messages plus task lifecycle state from one target file.
- [ ] Handle file replacement or truncation by returning `reset: true` and a fresh tail snapshot.

### Task 2: HTTP API migration

**Files:**
- Modify: `src/codex/http-handlers.ts`
- Modify: `src/http/server.ts`

**Produces:** paginated projects/sessions APIs and session snapshot/update APIs.

- [ ] Return `items`, `has_more`, and `next_cursor` from active-session list endpoints.
- [ ] Replace independent message/status/recent reads with `snapshot` and `updates` handlers.
- [ ] Keep send/new endpoints intact while making their session lookup use active-session discovery.

### Task 3: Frontend progressive lists and detail streaming

**Files:**
- Modify: `services/codex.js`
- Modify: `pages/codex/index.vue`
- Modify: `pages/codex/sessions.vue`
- Modify: `pages/codex/detail.vue`

**Produces:** latest-first load-more UI and a single detail-page update polling loop.

- [ ] Add cursor pagination parameters and normalize list pagination metadata.
- [ ] Load session list pages without status fan-out requests.
- [ ] Replace detail's initial message/status calls and dual timers with snapshot then updates polling.
- [ ] Append only newly returned messages and reset the message list when the server signals replacement/truncation.

### Task 4: Final validation

**Files:**
- Verify only

- [ ] Run backend typecheck/build and frontend static check after all code changes.
- [ ] Verify list routes do not mention `archived_sessions`, use no sync filesystem APIs, and detail update reads are cursor based.
