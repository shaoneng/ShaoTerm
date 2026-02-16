# Stability Hardening Design (Track 1, Tier B, Path 3)

Date: 2026-02-16  
Project: ShaoTerm  
Status: Validated with stakeholder

## 1) Final Decisions

This design captures the confirmed choices:

- Optimization track: `1` (stability first)
- Delivery tier: `B` (balanced hardening)
- Implementation path: `3` (moderate refactor with forward-compatible storage interface)

Primary intent: keep user-facing behavior stable while making runtime safety, cross-platform compatibility, and query scalability materially better.

## 2) Scope

### In Scope

- Cross-platform shell launch resolution and deterministic fallback.
- Browser security hardening and centralized navigation guard policy.
- Archive query path refactor behind a storage interface.
- Incremental in-memory index for JSONL archive reads.
- Regression tests for shell resolution, security policy, and archive store behavior.
- Backward-compatible rollout with rollback switch.

### Out of Scope

- Large UI redesign.
- Database migration to SQLite in this iteration.
- Workflow changes for release operations.

## 3) Current Pain Points

- Shell startup logic is effectively macOS-centric and can fail on Windows runtime.
- Security flags are too permissive for a local app with file input surfaces.
- Archive queries can degrade with data growth due to broad file scanning.
- Query and summarize logic is coupled to main-process orchestration, making behavior harder to test safely.

## 4) Proposed Architecture

Keep `main.js` as orchestration only. Move platform, security, and archive concerns to focused modules:

- `main/platform-shell.js`
- `main/security-policy.js`
- `main/archive-store/index.js`
- `main/archive-store/jsonl-store.js`
- `main/archive-store/memory-index.js`

Renderer IPC contracts remain unchanged to minimize UI risk.

## 5) Module Responsibilities

### `platform-shell`

Exports `resolveShellLaunch(platform, env, options)`:

- Selects shell binary and args by platform.
- Applies safe fallback order when requested shell is unavailable.
- Returns structured metadata (`resolvedFrom`, `fallbackReason`) for telemetry and debugging.

### `security-policy`

Exports:

- `buildBrowserSecurityOptions()` for `BrowserWindow.webPreferences`.
- `attachNavigationGuards(win)` for navigation and webview blocking policy.

Policy target:

- Default to strict (`webSecurity: true`, no untrusted navigation).
- Keep required local-file workflows functional through explicit allow paths.

### `archive-store`

Interface:

- `append(record)`
- `query(filters)`
- `summarizeInput(sessionId, limit)`

Implementation:

- Source of truth stays JSONL in this release.
- `memory-index` stores low-cost lookup structures by session/day/type and selective text keys.
- Query flow uses index to reduce candidate scan set before file reads.

## 6) Data Flow (No UI Contract Changes)

1. `terminal:create`
   - `main.js` calls `platform-shell` to build launch config.
   - PTY starts with normalized shell and args.

2. Terminal events
   - Existing heartbeat/session events still emitted.
   - Archiving writes via `archiveStore.append(...)`.

3. `heartbeat:query`
   - `main.js` delegates to `archiveStore.query(filters)`.
   - Index narrows candidate records, then JSONL read performs final filtering.

4. `heartbeat:summarize`
   - Input text built from `archiveStore.summarizeInput(...)`.
   - Existing analyzer path remains compatible.

## 7) Rollout and Migration Plan

### Phase 1: Introduce modules (no behavior switch)

- Add new modules and tests.
- Keep existing legacy query path active.

### Phase 2: Switch query/summarize to `archive-store`

- Route IPC handlers to the new interface.
- Keep rollback switch: `ARCHIVE_QUERY_LEGACY=1`.

### Phase 3: Stabilize and clean up

- Remove dead branches after confidence window.
- Keep driver abstraction to allow future SQLite backend with no IPC changes.

## 8) Error Handling and Reliability Rules

- Shell resolution failures never crash process; return fallback and structured reason.
- Archive append failures must not block terminal I/O path.
- Query failures return controlled error payloads, never uncaught exceptions to renderer.
- Index corruption or miss should trigger safe fallback to direct JSONL read for correctness.

## 9) Test Strategy

### Unit Tests

- `tests/platform-shell.test.js`
  - platform matrix (darwin/linux/win32), missing env vars, invalid preferred shell.
- `tests/security-policy.test.js`
  - secure defaults, navigation guard behavior, local file handling constraints.
- `tests/archive-store.test.js`
  - append/query correctness, index rebuild, malformed JSONL tolerance, fallback correctness.

### Performance Guardrails

- Representative dataset benchmarks for query path.
- Track P95 latency and ensure no regression from baseline.

## 10) Risk Matrix

- High: cross-platform shell mismatch -> mitigated by platform matrix tests and fallback telemetry.
- High: index/source divergence -> mitigated by write ordering, startup reindex, safe read fallback.
- Medium: strict security policy breaks edge behavior -> mitigated by explicit allowlist and targeted smoke checks.
- Medium: memory growth from index -> mitigated by bounded caches and compaction hooks.

## 11) Timeline (4 Days)

- Day 1: module scaffolding, no-behavior-change integration.
- Day 2: archive-store query cutover + rollback switch.
- Day 3: unit tests + performance checks.
- Day 4: regression fixes and release candidate verification.

## 12) Acceptance Criteria

- Windows startup path is functional for AI session creation.
- Heartbeat and topic features show no functional regression.
- Query latency target achieved on representative archive volume.
- Rollback switch can restore legacy query behavior without code changes.

## 13) Implementation Checklist

- [ ] Add `platform-shell` module and integrate in `terminal:create`.
- [ ] Add `security-policy` module and integrate in `createWindow`.
- [ ] Add archive-store interface and JSONL + memory-index drivers.
- [ ] Route `heartbeat:query` and `heartbeat:summarize` through archive-store.
- [ ] Add rollback switch `ARCHIVE_QUERY_LEGACY=1`.
- [ ] Add unit tests and benchmark guardrails.
- [ ] Run regression smoke for core flows.
