import type { DID, StorageClientOptions } from "./types.ts";

export class SpaceConnection {
  readonly spaceId: DID | string;
  readonly baseUrl: string;
  #socket: WebSocket | null = null;
  #helloSinceEpoch = -1;
  #amDocs = new Map<string, unknown>();
  #awaitingComplete: Array<
    { resolve: () => void; reject: (e: unknown) => void }
  > = [];
  #pendingInitialSubs = new Set<Promise<void>>();
  // Hook for applying server docs (to be set by StorageClient)
  onServerDoc?: (
    doc: { docId: string; epoch: number; heads?: string[]; json: unknown },
  ) => void;

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
      // deno-lint-ignore no-floating-promises
      this.#onMessage(e);
    };
    // Send hello if socket is open; otherwise skip (subscribe/get will still work in MVP)
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
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
    // No server-side unsubscribe command defined; return a no-op for now
    return () => {};
  }

  synced(): Promise<void> {
    // Snapshot the set at call time
    const arr = Array.from(this.#pendingInitialSubs);
    if (arr.length === 0) return Promise.resolve();
    return Promise.all(arr).then(() => undefined);
  }

  async #onMessage(ev: MessageEvent): Promise<void> {
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
                    // Use global atob for base64 decode to Uint8Array
                    const bin = atob(bytesB64);
                    const out = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) {
                      out[i] = bin.charCodeAt(i) & 0xff;
                    }
                    return out;
                  } catch {
                    return new Uint8Array();
                  }
                })();
                // Try Automerge load first; fallback to JSON.parse
                let json: unknown;
                try {
                  const AM = await import("@automerge/automerge");
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
                    const AM = await import("@automerge/automerge");
                    const changes = (Array.isArray(d.body) ? d.body : []).map(
                      (b64: string) => {
                        const bin = atob(b64);
                        const out = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) {
                          out[i] = bin.charCodeAt(i) & 0xff;
                        }
                        return out;
                      },
                    );
                    const applied = AM.applyChanges(
                      baseline as any,
                      changes as any,
                    );
                    const doc = Array.isArray(applied) ? applied[0] : applied;
                    this.#amDocs.set(d.docId, doc);
                    const json = AM.toJS(doc);
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
}
