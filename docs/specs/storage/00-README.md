# Automerge Backend (Deno 2 + Hono + SQLite) — Verifiable, Multi-Space

This is a production-ready spec for a Deno 2 + Hono Automerge backend that:

- Stores **tens of thousands** of docs
- Supports **multi-doc atomic transactions**
- Uses **SQLite** (npm:better-sqlite3), WAL mode
- Provides **WebSocket subscriptions**
- Offers **point-in-time reads** (epochs/timestamps)
- Supports **branching/merging**
- Implements **cryptographically verifiable tx chain** (BLAKE3 + Ed25519)
- Auth via **UCAN invocations** that **bind** to the exact change set
- Uses a **CAS-backed change log** with **snapshots** and **incremental chunks**
- Is **multi-space** (each space is a DID and a separate DB)
- Introduces **URI docs**: `doc:<hash>` (Automerge) and `cid:<hash>` (immutable)

> The crypto layer is an **add-on** to the original architecture. Core
> data/flows are preserved.

## Contents

- `01-overview.md` — Core ideas, spaces, URIs, hash choices
- `02-api.md` — HTTP + WS API surface
- `03-schema.md` — SQLite schema per space
- `04-tx-processing.md` — Transaction lifecycle, validation, crypto
- `05-storage-and-replay.md` — CAS changes, snapshots, chunks, PIT
  reconstruction
- `06-branching-merging.md` — Branch semantics
- `07-ucan.md` — UCAN invocation binding
- `08-background.md` — Background tasks (chunks/snapshots)
- `09-ops.md` — Pragmas, perf, observability
