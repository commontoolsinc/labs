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
    signal?: AbortSignal,
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

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    const clearTail = () => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
    void tail.then(clearTail, clearTail);
    try {
      const turn = previous.catch(() => {});
      if (signal === undefined) {
        await turn;
      } else {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          void turn.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        signal.throwIfAborted();
      }
      return await operation();
    } finally {
      release();
    }
  }
}

// File-store instances in one process share this queue so cancellation can
// stop before entering an advisory-lock wait held by another local instance.
const fileMutationQueue = new KeyedMutationQueue();

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
    signal?: AbortSignal,
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
    }, signal);
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

const emptyDocument = (): CredentialDocument => ({
  version: 1,
  owners: Object.create(null),
});

const setOwn = <T extends object>(
  target: T,
  key: PropertyKey,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const isCredential = (value: unknown): value is HarnessCredential => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return input.type === "oauth" && input.providerId === "openai-codex" &&
    typeof input.accessToken === "string" &&
    typeof input.refreshToken === "string" &&
    typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt) &&
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
    input.owners === null || Array.isArray(input.owners)
  ) {
    throw new Error("unsupported credential store format");
  }
  const owners: CredentialDocument["owners"] = Object.create(null);
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
    setOwn(
      owners,
      owner,
      credential === undefined ? {} : { "openai-codex": credential },
    );
  }
  return { version: 1, owners };
};

export interface FileHarnessCredentialStoreOptions {
  path: string;
  /** @internal Observability hook used by lock-contention tests. */
  onLockAcquisitionStarted?: () => void;
}

export class FileHarnessCredentialStore implements HarnessCredentialStore {
  readonly path: string;
  readonly #onLockAcquisitionStarted?: () => void;
  #lastValid: CredentialDocument = emptyDocument();

  constructor(options: FileHarnessCredentialStoreOptions) {
    this.path = resolve(options.path);
    this.#onLockAcquisitionStarted = options.onLockAcquisitionStarted;
  }

  async #ensurePrivateDirectory(): Promise<void> {
    const directory = dirname(this.path);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(directory);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error("credential store directory must not be a symlink");
    }
    if (
      Deno.build.os !== "windows" && info.mode !== null &&
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        "credential store directory must have private permissions",
      );
    }
  }

  async #assertPrivateRegularFile(
    path: string,
    label: "credential store" | "credential store lock",
    allowMissing = true,
  ): Promise<void> {
    try {
      const info = await Deno.lstat(path);
      if (info.isSymlink || !info.isFile) {
        throw new Error(`${label} file must be a regular file`);
      }
      if (
        Deno.build.os !== "windows" && info.mode !== null &&
        (info.mode & 0o077) !== 0
      ) {
        throw new Error(`${label} file must have private permissions`);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound && allowMissing) return;
      throw error;
    }
  }

  async #withFileLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.#ensurePrivateDirectory();
    const lockPath = `${this.path}.lock`;
    let lockFile: Deno.FsFile;
    try {
      lockFile = await Deno.open(lockPath, {
        createNew: true,
        read: true,
        write: true,
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      await this.#assertPrivateRegularFile(
        lockPath,
        "credential store lock",
        false,
      );
      lockFile = await Deno.open(lockPath, { read: true, write: true });
    }
    let locked = false;
    let cleanupDetached = false;
    try {
      await this.#assertPrivateRegularFile(
        lockPath,
        "credential store lock",
        false,
      );
      signal?.throwIfAborted();
      const lockPromise = lockFile.lock(true).then(() => {
        locked = true;
      });
      this.#onLockAcquisitionStarted?.();
      if (signal === undefined) {
        await lockPromise;
      } else {
        let removeAbortListener = () => {};
        const aborted = new Promise<"aborted">((resolve) => {
          const onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener("abort", onAbort);
        });
        let outcome: "locked" | "aborted";
        try {
          outcome = await Promise.race([
            lockPromise.then(() => "locked" as const),
            aborted,
          ]);
        } finally {
          removeAbortListener();
        }
        if (outcome === "aborted") {
          cleanupDetached = true;
          void (async () => {
            try {
              await lockPromise;
              await lockFile.unlock().catch(() => {});
            } catch {
              // The caller has already observed cancellation.
            } finally {
              lockFile.close();
            }
          })();
          signal.throwIfAborted();
        }
      }
      signal?.throwIfAborted();
      return await operation();
    } finally {
      if (!cleanupDetached) {
        if (locked) await lockFile.unlock().catch(() => {});
        lockFile.close();
      }
    }
  }

  async #read(): Promise<CredentialDocument> {
    try {
      await this.#ensurePrivateDirectory();
      await this.#assertPrivateRegularFile(this.path, "credential store");
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
    await this.#ensurePrivateDirectory();
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
    const providers = Object.hasOwn(document.owners, ownerKey)
      ? document.owners[ownerKey]
      : undefined;
    return providers?.[providerId];
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
    signal?: AbortSignal,
  ): Promise<HarnessCredential | undefined> {
    // Every mutation rewrites the whole document. The stable advisory lock
    // serializes read/modify/write transactions across processes as well as
    // across distinct store instances in this process.
    return fileMutationQueue.run(
      this.path,
      () =>
        this.#withFileLock(async () => {
          const document = await this.#read();
          const currentProviders = Object.hasOwn(document.owners, ownerKey)
            ? document.owners[ownerKey]
            : undefined;
          const current = currentProviders?.[providerId];
          const next = await updater(current);
          const providers = { ...(currentProviders ?? {}) };
          if (next === undefined) delete providers[providerId];
          else providers[providerId] = next;
          if (Object.keys(providers).length === 0) {
            delete document.owners[ownerKey];
          } else {
            setOwn(document.owners, ownerKey, providers);
          }
          await this.#write(document);
          return next;
        }, signal),
      signal,
    );
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
