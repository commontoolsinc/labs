import type { DID, StorageClientOptions } from "./types.ts";
import { decodeBase64, encodeBase64 } from "../codec/bytes.ts";
import { refer } from "merkle-reference/json";
import * as AM from "@automerge/automerge";

export class SpaceConnection {
  readonly spaceId: DID | string;
  readonly baseUrl: string;
  #socket: WebSocket | null = null;
  #helloSinceEpoch = 0;
  #amDocs = new Map<string, unknown>();
  #awaitingComplete: Array<
    { resolve: () => void; reject: (e: unknown) => void }
  > = [];
  #pendingInitialSubs = new Set<Promise<void>>();
  #awaitingTask = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  #consumers = new Set<string>();
  // Hook for applying server docs (to be set by StorageClient)
  onServerDoc?: (
    doc: { docId: string; epoch: number; heads?: string[]; json: unknown },
  ) => void;
  // Optional hook to clear all client pending overlays for a doc when server confirms
  onServerDocConfirm?: (docId: string) => void;

  constructor(spaceId: DID | string, opts: StorageClientOptions) {
    this.spaceId = spaceId;
    const loc = (globalThis as { location?: { origin?: string } }).location;
    this.baseUrl = opts.baseUrl ?? (loc?.origin ?? "http://localhost:8002");
  }

  get isOpen(): boolean {
    return this.#socket != null && this.#socket.readyState === WebSocket.OPEN;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    const url = new URL(
      `/api/storage/new/v2/${encodeURIComponent(String(this.spaceId))}/ws`,
      this.baseUrl,
    );
    this.#socket = new WebSocket(url.toString());
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
      this.#socket!.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.#socket!.onerror = (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error("ws error"));
      };
    });
    this.#socket!.onmessage = (e) => {
      // fire-and-forget async handler
      this.#onMessage(e);
    };
    // Always send hello on open to register client and request backfill from sinceEpoch
    try {
      const hello = {
        invocation: {
          iss: "did:key:client", // placeholder
          cmd: "/storage/hello",
          sub: String(this.spaceId),
          args: {
            clientId: crypto.randomUUID(),
            sinceEpoch: this.#helloSinceEpoch,
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      } as const;
      this.#socket.send(JSON.stringify(hello));
    } catch {
      // ignore send failures
    }
  }

  close(): Promise<void> {
    if (!this.#socket) return Promise.resolve();
    try {
      this.#socket.close();
    } catch {
      // ignore
    }
    this.#socket = null;
    return Promise.resolve();
  }

  async subscribe(
    opts: {
      consumerId: string;
      query: { docId: string; path?: string[]; schema?: unknown };
    },
  ): Promise<() => void> {
    await this.open();
    const msg = {
      invocation: {
        iss: "did:key:client",
        cmd: "/storage/subscribe",
        sub: String(this.spaceId),
        args: { consumerId: opts.consumerId, query: opts.query },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    } as const;
    const p = new Promise<void>((resolve, reject) => {
      this.#awaitingComplete.push({ resolve, reject });
    });
    this.#pendingInitialSubs.add(p);
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(msg));
    } else {
      await new Promise<void>((resolve, reject) => {
        if (!this.#socket) return reject(new Error("ws not initialized"));
        const s = this.#socket;
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onErr = (e: Event | ErrorEvent) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          s.removeEventListener("open", onOpen as any);
          s.removeEventListener("error", onErr as any);
        };
        s.addEventListener("open", onOpen as any, { once: true });
        s.addEventListener("error", onErr as any, { once: true });
      });
      this.#socket!.send(JSON.stringify(msg));
    }
    await p.catch((e) => {
      throw e;
    }).finally(() => this.#pendingInitialSubs.delete(p));
    // Track consumer locally; return unsubscribe that removes local tracking.
    this.#consumers.add(opts.consumerId);
    return () => {
      this.#consumers.delete(opts.consumerId);
    };
  }

  synced(): Promise<void> {
    // Snapshot the set at call time
    const arr = Array.from(this.#pendingInitialSubs);
    if (arr.length === 0) return Promise.resolve();
    return Promise.all(arr).then(() => undefined);
  }

  #onMessage(ev: MessageEvent): void {
    try {
      const m = JSON.parse(String(ev.data));
      if (m && m.type === "deliver" && typeof m.epoch === "number") {
        // Immediate ack per protocol
        this.#helloSinceEpoch = Math.max(
          this.#helloSinceEpoch,
          Number(m.epoch),
        );
        const ack = {
          type: "ack",
          streamId: String(this.spaceId),
          epoch: m.epoch,
        } as const;
        this.#socket?.send(JSON.stringify(ack));
        // Populate store with snapshots, and apply deltas when we have a baseline
        try {
          if (Array.isArray(m.docs)) {
            for (const d of m.docs) {
              if (d && d.kind === "snapshot") {
                const bytesB64 = d.body as string;
                const bytes = (() => {
                  try {
                    return decodeBase64(bytesB64);
                  } catch {
                    return new Uint8Array();
                  }
                })();
                // Try Automerge load first; fallback to JSON.parse
                let json: unknown;
                try {
                  const doc = AM.load(bytes);
                  this.#amDocs.set(d.docId, doc);
                  json = AM.toJS(doc);
                } catch {
                  try {
                    const jsonStr = new TextDecoder().decode(bytes);
                    json = JSON.parse(jsonStr);
                  } catch {
                    json = undefined;
                  }
                }
                if (json !== undefined) {
                  // Clear any optimistic overlays now that server confirmed this epoch
                  this.onServerDocConfirm?.(d.docId);
                  this.onServerDoc?.({
                    docId: d.docId,
                    epoch: Number(m.epoch),
                    heads: d.version?.heads ?? [],
                    json,
                  });
                }
              } else if (d && d.kind === "delta") {
                // Apply delta changes when baseline doc exists
                const baseline = this.#amDocs.get(d.docId);
                if (baseline) {
                  try {
                    const changes = (Array.isArray(d.body) ? d.body : [])
                      .map((b64: string) => {
                        try {
                          return decodeBase64(b64);
                        } catch {
                          return new Uint8Array();
                        }
                      });
                    const applied = AM.applyChanges(
                      baseline as any,
                      changes as any,
                    );
                    const doc = Array.isArray(applied) ? applied[0] : applied;
                    this.#amDocs.set(d.docId, doc);
                    const json = AM.toJS(doc);
                    // Clear any optimistic overlays for this doc on server confirm
                    this.onServerDocConfirm?.(d.docId);
                    this.onServerDoc?.({
                      docId: d.docId,
                      epoch: Number(m.epoch),
                      heads: d.version?.heads ?? [],
                      json,
                    });
                  } catch {
                    // ignore delta failures in scaffold
                  }
                }
              }
            }
          }
        } catch {
          // ignore decode errors in scaffold
        }
      }
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        const next = this.#awaitingComplete.shift();
        if (next) next.resolve();
        // Also attempt to resolve awaitingTask by job id if present
        const jobId = typeof m.of === "string" ? (m.of as string) : undefined;
        if (jobId && this.#awaitingTask.has(jobId)) {
          const wait = this.#awaitingTask.get(jobId)!;
          this.#awaitingTask.delete(jobId);
          wait.resolve(m.is);
        }
        return;
      }
      if (m && m.the === "task/return" && m.of) {
        const jobId = String(m.of);
        const wait = this.#awaitingTask.get(jobId);
        if (wait) {
          this.#awaitingTask.delete(jobId);
          wait.resolve(m.is);
        }
        return;
      }
    } catch {
      // ignore malformed frames in this scaffold
    }
  }

  async get(
    opts: {
      consumerId: string;
      query: { docId: string; path?: string[]; schema?: unknown };
    },
  ): Promise<void> {
    await this.open();
    const msg = {
      invocation: {
        iss: "did:key:client",
        cmd: "/storage/get",
        sub: String(this.spaceId),
        args: { consumerId: opts.consumerId, query: opts.query },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    } as const;
    const p = new Promise<void>((resolve, reject) => {
      this.#awaitingComplete.push({ resolve, reject });
    });
    this.#socket!.send(JSON.stringify(msg));
    await p;
  }

  async submitTx(req: {
    clientTxId?: string;
    reads: ReadonlyArray<
      { ref: { docId: string; branch: string }; heads: readonly string[] }
    >;
    writes: ReadonlyArray<{
      ref: { docId: string; branch: string };
      baseHeads: readonly string[];
      changes: ReadonlyArray<{ bytes: Uint8Array }>;
      allowServerMerge?: boolean;
    }>;
  }): Promise<import("../types.ts").TxReceipt> {
    await this.open();
    const invocation = {
      iss: "did:key:client",
      cmd: "/storage/tx",
      sub: String(this.spaceId),
      args: {
        ...(req.clientTxId !== undefined ? { clientTxId: req.clientTxId } : {}),
        reads: (req.reads ?? []).map((r) => ({ ref: r.ref, heads: r.heads })),
        writes: req.writes.map((w) => ({
          ref: w.ref,
          baseHeads: w.baseHeads,
          changes: w.changes.map((c) => ({ bytes: encodeBase64(c.bytes) })),
          ...(w.allowServerMerge !== undefined
            ? { allowServerMerge: w.allowServerMerge }
            : {}),
        })),
      },
      prf: [],
    } as const;
    const jobId = `job:${refer(invocation)}` as const;
    const msg = {
      invocation,
      authorization: { signature: [], access: {} },
    } as const;
    const p: Promise<import("../types.ts").TxReceipt> = new Promise(
      (resolve, reject) => {
        this.#awaitingTask.set(jobId, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
      },
    ) as Promise<import("../types.ts").TxReceipt>;
    this.#socket!.send(JSON.stringify(msg));
    const res = await p;
    return res;
  }

  getAutomergeDoc(docId: string): unknown | null {
    const cur = this.#amDocs.get(docId);
    if (!cur) return null;
    try {
      // Clone to avoid mutating internal baseline
      return AM.clone(cur as any);
    } catch {
      return cur;
    }
  }
}
