import { dirname, join, resolve } from "@std/path";
import type {
  HarnessCredential,
  HarnessCredentialProviderId,
} from "./types.ts";

export interface HarnessCredentialStore {
  get(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<HarnessCredential | undefined>;
  set(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    credential: HarnessCredential,
  ): Promise<void>;
  update(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredential | undefined,
    ) => Promise<HarnessCredential | undefined> | HarnessCredential | undefined,
  ): Promise<HarnessCredential | undefined>;
  delete(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<void>;
}

/**
 * Host-side Loom adapter contract. Implementations keep token material in
 * Loom's encrypted secret backend and resolve only opaque authenticated owner
 * keys; cf-harness never serializes this adapter or its values into run data.
 */
export interface LoomHarnessCredentialStore extends HarnessCredentialStore {
  readonly backend: "loom-encrypted-secret-store";
}

const credentialKey = (ownerKey: string, providerId: string): string =>
  `${ownerKey}\u0000${providerId}`;

class KeyedMutationQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

const processMutationQueue = new KeyedMutationQueue();

export class InMemoryHarnessCredentialStore implements HarnessCredentialStore {
  readonly #credentials = new Map<string, HarnessCredential>();
  readonly #queue = new KeyedMutationQueue();

  get(ownerKey: string, providerId: HarnessCredentialProviderId) {
    const credential = this.#credentials.get(
      credentialKey(ownerKey, providerId),
    );
    return Promise.resolve(
      credential === undefined ? undefined : structuredClone(credential),
    );
  }

  async set(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    credential: HarnessCredential,
  ): Promise<void> {
    await this.update(ownerKey, providerId, () => credential);
  }

  update(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredential | undefined,
    ) => Promise<HarnessCredential | undefined> | HarnessCredential | undefined,
  ): Promise<HarnessCredential | undefined> {
    const key = credentialKey(ownerKey, providerId);
    return this.#queue.run(key, async () => {
      const current = this.#credentials.get(key);
      const next = await updater(
        current === undefined ? undefined : structuredClone(current),
      );
      if (next === undefined) this.#credentials.delete(key);
      else this.#credentials.set(key, structuredClone(next));
      return next === undefined ? undefined : structuredClone(next);
    });
  }

  async delete(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<void> {
    await this.update(ownerKey, providerId, () => undefined);
  }
}

interface CredentialDocument {
  version: 1;
  owners: Record<
    string,
    Partial<Record<HarnessCredentialProviderId, HarnessCredential>>
  >;
}

const emptyDocument = (): CredentialDocument => ({ version: 1, owners: {} });

const isCredential = (value: unknown): value is HarnessCredential => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return input.type === "oauth" && input.providerId === "openai-codex" &&
    typeof input.accessToken === "string" &&
    typeof input.refreshToken === "string" &&
    typeof input.expiresAt === "number" &&
    typeof input.accountId === "string";
};

const parseDocument = (text: string): CredentialDocument => {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("credential store must contain a JSON object");
  }
  const input = parsed as Record<string, unknown>;
  if (
    input.version !== 1 || typeof input.owners !== "object" ||
    input.owners === null
  ) {
    throw new Error("unsupported credential store format");
  }
  const owners: CredentialDocument["owners"] = {};
  for (const [owner, rawProviders] of Object.entries(input.owners)) {
    if (
      typeof rawProviders !== "object" || rawProviders === null ||
      Array.isArray(rawProviders)
    ) {
      throw new Error("invalid credential owner entry");
    }
    const raw = rawProviders as Record<string, unknown>;
    const credential = raw["openai-codex"];
    if (credential !== undefined && !isCredential(credential)) {
      throw new Error("invalid openai-codex credential entry");
    }
    owners[owner] = credential === undefined
      ? {}
      : { "openai-codex": credential };
  }
  return { version: 1, owners };
};

export interface FileHarnessCredentialStoreOptions {
  path: string;
}

export class FileHarnessCredentialStore implements HarnessCredentialStore {
  readonly path: string;
  #lastValid: CredentialDocument = emptyDocument();

  constructor(options: FileHarnessCredentialStoreOptions) {
    this.path = resolve(options.path);
  }

  async #read(): Promise<CredentialDocument> {
    try {
      const document = parseDocument(await Deno.readTextFile(this.path));
      this.#lastValid = document;
      return structuredClone(document);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return emptyDocument();
      throw new Error(
        `failed to read credential store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async #write(document: CredentialDocument): Promise<void> {
    await Deno.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      dirname(this.path),
      `.auth-${crypto.randomUUID()}.tmp`,
    );
    let operationFailed = false;
    let operationError: unknown;
    try {
      await Deno.writeTextFile(
        temporaryPath,
        `${JSON.stringify(document, null, 2)}\n`,
        { createNew: true, mode: 0o600 },
      );
      await Deno.chmod(temporaryPath, 0o600);
      await Deno.rename(temporaryPath, this.path);
      this.#lastValid = structuredClone(document);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      await Deno.remove(temporaryPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && !operationFailed) {
        throw error;
      }
    }
    if (operationFailed) {
      throw operationError;
    }
  }

  async get(ownerKey: string, providerId: HarnessCredentialProviderId) {
    const document = await this.#read();
    return document.owners[ownerKey]?.[providerId];
  }

  async set(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    credential: HarnessCredential,
  ): Promise<void> {
    await this.update(ownerKey, providerId, () => credential);
  }

  update(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredential | undefined,
    ) => Promise<HarnessCredential | undefined> | HarnessCredential | undefined,
  ): Promise<HarnessCredential | undefined> {
    // Every mutation rewrites the whole document. Serialize by file path, not
    // owner, so concurrent owners cannot overwrite each other's updates.
    const queueKey = this.path;
    return processMutationQueue.run(queueKey, async () => {
      const document = await this.#read();
      const current = document.owners[ownerKey]?.[providerId];
      const next = await updater(current);
      const providers = { ...(document.owners[ownerKey] ?? {}) };
      if (next === undefined) delete providers[providerId];
      else providers[providerId] = next;
      if (Object.keys(providers).length === 0) delete document.owners[ownerKey];
      else document.owners[ownerKey] = providers;
      await this.#write(document);
      return next;
    });
  }

  async delete(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<void> {
    await this.update(ownerKey, providerId, () => undefined);
  }

  lastValidSnapshot(): unknown {
    return structuredClone(this.#lastValid);
  }
}

export const defaultHarnessCredentialStorePath = (
  harnessHome: string,
): string => join(resolve(harnessHome), "auth.json");
