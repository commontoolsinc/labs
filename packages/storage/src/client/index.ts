export type DID = `did:${string}:${string}`;

export interface StorageClientOptions {
  baseUrl?: string;
  token?: string | (() => Promise<string>);
  logLevel?: "off" | "error" | "warn" | "info" | "debug";
}

export class StorageClient {
  #baseUrl: string;
  #token?: string | (() => Promise<string>);
  constructor(opts: StorageClientOptions = {}) {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    this.#baseUrl = opts.baseUrl ?? (loc?.origin ?? "http://localhost:8002");
    this.#token = opts.token;
  }

  connect(_space: DID | string): Promise<void> {
    // Placeholder: connection handled in SpaceConnection in a follow-up edit
    return Promise.resolve();
  }

  disconnect(_space: DID | string): Promise<void> {
    return Promise.resolve();
  }
}

// Intentionally minimal public surface for initial scaffold; detailed exports
// will be added as implementation lands.
