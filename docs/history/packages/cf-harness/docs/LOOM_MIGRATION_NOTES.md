---
status: historical
created: 2026-04-17
archived: 2026-07-22
reason: "Pre-integration assessment; Loom now has batch and opt-in interactive cf-harness adapters."
superseded-by: packages/cf-harness/docs/CURRENT_STATE.md
---

# Loom Migration Notes

This note captures the current understanding of how Loom uses Codex today and
what that implies for `cf-harness` migration planning.

## Bottom Line

Loom currently uses two materially different Codex integration surfaces:

- background and non-interactive work through `codex exec`
- interactive chat through `codex app-server --listen stdio://`

Those should not be treated as the same migration problem.

The recommended first `cf-harness` migration target is the background
`codex exec` path. The interactive app-server path is a separate, richer
transport problem.

## Current Loom Codex Integration

### Background / batch path

Loom shells out to the Codex CLI for non-interactive work through:

- `loom/.ops/lib/provider_batch.py` in the Loom repo

Key functions:

- `build_batch_command(...)`
- `run_capture(...)`

This path is already semantically close to a `cf-harness` CLI or batch runner:

- one-shot provider invocation
- subprocess-oriented execution
- captured output returned to the caller

### Interactive chat path

Loom does not use one-shot CLI execution for interactive chat. It runs Codex
app-server and talks to it over JSON-RPC through:

- `loom/.ops/lib/codex_app_server.py` in the Loom repo
- `loom/.ops/scripts/fabric-local.py` in the Loom repo

Important functions:

- `build_app_server_command(...)`
- `build_initialize_request(...)`
- `build_thread_start_request(...)`
- `build_turn_start_request(...)`
- `start_stdio_session(...)`
- `send_turn_start(...)`
- `drain_turn_until_completed(...)`
- `_provider_uses_codex_app_server(...)`
- `_send_codex_turn(...)`
- `_chat_stream_thread_codex(...)`

## Why Interactive App-Server Matters

The current Loom interactive path appears to rely on app-server semantics in a
real way, not as a thin implementation detail.

Observed behaviors:

- persistent thread reuse across follow-up turns
- explicit session and turn lifecycle over JSON-RPC
- notification-to-SSE translation for browser streaming
- richer telemetry about tools, files, MCP, and background-agent activity
- reload and reconnect continuity on the `/chat` path

The current judgment is:

- replacing this path with a one-shot `exec` flow would be a major semantic
  change
- it should not be framed as a simple implementation swap

## Recommended Migration Order

### 1. First target: background `codex exec` replacement

This is the cleaner first migration target because it matches the current
`cf-harness` shape much better:

- CLI-oriented
- headless
- bounded run model
- artifact persistence
- resumability
- shell-centric execution

This is where Loom should first stop depending on Codex.

### 2. Later target: interactive app-server replacement

Interactive Loom support should be planned as a separate project or subproject.

The main decision is not only "can `cf-harness` answer prompts?" It is:

- should `cf-harness` grow an app-server or long-lived session transport
- or should Loom adapt its interactive surface to a different harness protocol

That decision should be made explicitly rather than hidden inside batch
migration work.

## Implications For `cf-harness`

Near-term implications:

- prioritize the first Loom background invocation contract
- do not block batch migration on interactive transport design
- keep the current headless CLI path healthy and inspectable

Medium-term implications:

- if Loom interactive migration becomes a priority, define the required session
  semantics explicitly:
  - thread lifecycle
  - turn lifecycle
  - streamed notifications
  - reconnect behavior
  - tool and background-task telemetry

## Open Questions

- What exact input and output contract does Loom expect from the current
  background provider path?
- What cancellation and retry behavior does Loom rely on today for background
  jobs?
- For interactive migration later, does Loom need Codex-app-server compatibility
  specifically, or only the higher-level behaviors listed above?
- Should `cf-harness` eventually offer both:
  - a batch CLI surface
  - and a long-lived interactive transport

## Recommended Next Step

Use the Loom background path as the first concrete product integration target.

That means defining a narrow replacement contract for the current
`provider_batch.py` usage before attempting any interactive `/chat` replacement.
