import type { DID, StorageClientOptions } from "./index.ts";

export class SpaceConnection {
  readonly spaceId: DID | string;
  readonly baseUrl: string;
  #socket: WebSocket | null = null;
  #helloSinceEpoch = -1;

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
    const url = new URL(`/api/storage/new/v2/${encodeURIComponent(String(this.spaceId))}/ws`, this.baseUrl);
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
    // Send hello; actual payload wiring added in follow-up edits
    const hello = {
      invocation: {
        iss: "did:key:client", // placeholder
        cmd: "/storage/hello",
        sub: String(this.spaceId),
        args: { clientId: crypto.randomUUID(), sinceEpoch: this.#helloSinceEpoch },
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
}


