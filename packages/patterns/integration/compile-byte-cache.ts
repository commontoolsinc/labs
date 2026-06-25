import type {
  CompiledModuleArtifact,
  ModuleByteCache,
} from "@commonfabric/runner";
import { dirname } from "@std/path";

// The compiled-module-byte cache, in full. The runtime defines only the
// `ModuleByteCache` interface it consults during a compile; this test-side
// module owns the implementation and its disk persistence, and is the only
// place an instance is created. So the cache is, by construction, a single
// feature that exists only when tests install it — never in production.
//
// `createCompileByteCache` returns the instance to inject into the runtimes a
// test builds. The in-memory cache is always created (cross-runtime reuse within
// the process). Disk persistence is added only when `CF_COMPILE_CACHE_FILE` is
// set — which only the CI workflow sets — so a run reuses bytes it compiled on a
// previous run. Cross-run correctness rests on the CI cache key (see the
// workflow): the persisted bytes are a function of the compiler / transformer
// build, which a module's content identity does not cover, so the key folds in a
// hash of the compiler sources + lockfile and invalidates the whole file when
// the code that emits the bytes changes.

/** A serialized {@link ProcessModuleByteCache} entry (for disk persistence). */
export interface SerializedModuleBytes {
  key: string;
  js: string;
  sourceMap?: unknown;
}

/**
 * Process-level, content-addressed cache of compiled module bytes. An entry is
 * the emitted JavaScript for one module (plus its optional source map), keyed by
 * the module's content identity scoped by the compiled-set `runtimeVersion`. The
 * emitted bytes are a deterministic function of that key, so a hit always returns
 * the bytes the identity addresses. Holds emitted JS only, never live pattern
 * instances. A byte cap bounds the total retained JS and evicts oldest-first.
 */
export class ProcessModuleByteCache implements ModuleByteCache {
  // Keyed by `${runtimeVersion}\0${identity}`. Map insertion order gives FIFO
  // eviction (recency-refreshed on read, so eviction is ~LRU).
  private readonly entries = new Map<
    string,
    { artifact: CompiledModuleArtifact; size: number }
  >();
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 256 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  private static key(runtimeVersion: string, identity: string): string {
    return `${runtimeVersion}\0${identity}`;
  }

  private static sizeOf(artifact: CompiledModuleArtifact): number {
    let size = artifact.js.length;
    if (typeof artifact.sourceMap === "string") {
      size += artifact.sourceMap.length;
    }
    return size;
  }

  get(
    runtimeVersion: string,
    identity: string,
  ): CompiledModuleArtifact | undefined {
    const key = ProcessModuleByteCache.key(runtimeVersion, identity);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.artifact;
  }

  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    const bodies = new Map<string, CompiledModuleArtifact>();
    for (const identity of identities) {
      const artifact = this.get(runtimeVersion, identity);
      if (artifact === undefined) return undefined;
      bodies.set(identity, artifact);
    }
    return bodies;
  }

  put(
    runtimeVersion: string,
    identity: string,
    artifact: CompiledModuleArtifact,
  ): void {
    this.insert(ProcessModuleByteCache.key(runtimeVersion, identity), artifact);
  }

  private insert(key: string, artifact: CompiledModuleArtifact): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return;
    }
    const size = ProcessModuleByteCache.sizeOf(artifact);
    this.entries.set(key, { artifact, size });
    this.totalBytes += size;
    this.evictToCap();
  }

  putAll(
    runtimeVersion: string,
    modules: readonly { identity: string; js: string; sourceMap?: unknown }[],
  ): void {
    for (const module of modules) {
      this.put(
        runtimeVersion,
        module.identity,
        module.sourceMap === undefined
          ? { js: module.js }
          : { js: module.js, sourceMap: module.sourceMap },
      );
    }
  }

  private evictToCap(): void {
    while (this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry !== undefined) this.totalBytes -= entry.size;
    }
  }

  /** A serializable dump of every cached module. Pairs with {@link restore}. */
  snapshot(): SerializedModuleBytes[] {
    const out: SerializedModuleBytes[] = [];
    for (const [key, { artifact }] of this.entries) {
      out.push(
        artifact.sourceMap === undefined
          ? { key, js: artifact.js }
          : { key, js: artifact.js, sourceMap: artifact.sourceMap },
      );
    }
    return out;
  }

  /**
   * Merge a {@link snapshot} back in (idempotent; content-addressed, so a key
   * collision is the same bytes). Malformed entries are skipped.
   */
  restore(entries: readonly unknown[]): void {
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Partial<SerializedModuleBytes>;
      if (typeof e.key !== "string" || typeof e.js !== "string") continue;
      this.insert(
        e.key,
        e.sourceMap === undefined
          ? { js: e.js }
          : { js: e.js, sourceMap: e.sourceMap },
      );
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes };
  }
}

/**
 * Create the compiled-module-byte cache and return it for injection into the
 * runtimes a test builds (via `PiecesController.initialize`'s `moduleByteCache`).
 * When `CF_COMPILE_CACHE_FILE` is set, the cache is also seeded from that file
 * now and written back at process exit. Unset everywhere but CI, so locally the
 * cache is in-memory only.
 */
export function createCompileByteCache(): ModuleByteCache {
  const cache = new ProcessModuleByteCache();
  const cacheFile = Deno.env.get("CF_COMPILE_CACHE_FILE");
  if (!cacheFile) return cache;

  let text: string | undefined;
  try {
    text = Deno.readTextFileSync(cacheFile);
  } catch (error) {
    // A missing file is the expected cold start. Any other read failure
    // (permissions, I/O) is real — let it surface rather than masking it.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (text !== undefined) {
    // A malformed cache file is a real fault, not a cold start: let the parse
    // error surface. `restore` itself tolerates individual malformed entries.
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      cache.restore(parsed);
      console.log(
        `[compile-byte-cache] restored ${parsed.length} modules from ${cacheFile}`,
      );
    }
  }

  globalThis.addEventListener("unload", () => {
    try {
      Deno.mkdirSync(dirname(cacheFile), { recursive: true });
      const snapshot = cache.snapshot();
      Deno.writeTextFileSync(cacheFile, JSON.stringify(snapshot));
      console.log(
        `[compile-byte-cache] wrote ${snapshot.length} modules to ${cacheFile}`,
      );
    } catch (error) {
      console.error(
        `[compile-byte-cache] failed to write ${cacheFile}:`,
        error,
      );
    }
  });

  return cache;
}
