import type { DID, StorageClientOptions } from "./types.ts";

export class SpaceConnection {
  readonly spaceId: DID | string;
  readonly baseUrl: string;
  #socket: WebSocket | null = null;
  #helloSinceEpoch = -1;
  #awaitingComplete: Array<
    { resolve: () => void; reject: (e: unknown) => void }
  > = [];
  #pendingInitialSubs = new Set<Promise<void>>();
  // Hook for applying server docs (to be set by StorageClient)
  onServerDoc?: (doc: { docId: string; epoch: number; heads?: string[]; json: unknown }) => void;

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
    this.#socket!.onmessage = (e) => this.#onMessage(e);
    // Send hello; actual payload wiring added in follow-up edits
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
    this.#socket!.send(JSON.stringify(hello));
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
    this.#socket!.send(JSON.stringify(msg));
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
        // Populate store with snapshots only in this scaffold: if kind === snapshot
        try {
          if (Array.isArray(m.docs)) {
            for (const d of m.docs) {
              if (d && d.kind === "snapshot") {
                const bytesB64 = d.body as string;
                // For scaffold: assume body is JSON string in base64 of utf8 JSON; real impl decodes AM
                const jsonStr = atob(bytesB64);
                const json = JSON.parse(jsonStr);
                this.onServerDoc?.({ docId: d.docId, epoch: Number(m.epoch), heads: d.version?.heads ?? [], json });
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
}
