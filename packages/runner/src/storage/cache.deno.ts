import { type Options, StorageManager as BaseStorageManager } from "./cache.ts";
import * as StorageSubscription from "./subscription.ts";
import type { MemorySpace } from "@commontools/memory/interface";
import type { IStorageSubscription } from "./interface.ts";
import type {
  ClientCommit,
  EntityId,
  JSONValue,
  SpaceId,
} from "@commontools/memory/v2-types";
import { applyCommit } from "@commontools/memory/v2-commit";
import { executeSimpleQuery } from "@commontools/memory/v2-query";
import { EMPTY } from "@commontools/memory/v2-reference";
import type { Reference } from "merkle-reference";
import { V2Provider } from "./v2-provider.ts";
import { V2DirectTransport } from "./v2-direct-transport.ts";
export * from "./cache.ts";

// ---------------------------------------------------------------------------
// V2 test compat: mount() / session() shims
// ---------------------------------------------------------------------------

/**
 * Thin wrapper returned by `mount(space)` and `session().mount(space)`.
 * Provides v1-compatible `query()` and `transact()` methods that operate
 * on the underlying V2Space directly — for test setup and verification only.
 */
class V2EmulatedMemory {
  readonly #transport: V2DirectTransport;

  constructor(transport: V2DirectTransport) {
    this.#transport = transport;
  }

  /**
   * Query the V2Space directly. Returns a thenable with a `.facts` property
   * matching the v1 query result shape that tests expect.
   */
  query(args: { select: Record<string, Record<string, unknown>> }) {
    // Map v1 wildcard key "_" to v2 wildcard key "*"
    const select: Record<string, Record<string, unknown>> = {};
    for (const [key, val] of Object.entries(args.select)) {
      select[key === "_" ? "*" : key] = val;
    }
    const result = executeSimpleQuery(this.#transport.space, { select });
    // Convert v2 FactSet to v1-style facts array
    const facts = Object.entries(result).map(([id, entry]) => ({
      the: "application/json",
      of: id,
      is: entry.value,
      cause: entry.hash,
    }));
    // Return a thenable with a .facts property.
    // IMPORTANT: We must NOT use Promise.resolve(obj) here because obj has
    // a .then() method, which makes it a thenable. Promise.resolve() would
    // recursively call .then() → Promise.resolve(obj) → .then() → OOM.
    // Instead, resolve with a plain result object.
    const resultObj = { facts };
    const obj = {
      facts,
      then: (
        onFulfilled?: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resultObj).then(onFulfilled, onRejected),
    };
    return obj;
  }

  /**
   * Write v1-style facts directly to the V2Space via applyCommit.
   * Used for test setup (e.g. injecting server-side state for conflict tests).
   */
  // deno-lint-ignore no-explicit-any
  transact(args: { changes: any }): Promise<void> {
    const operations = [];
    // Support both Iterable<Fact> and v1 Changes object.
    // v1 Changes structure: { [of]: { [the]: { [cause]: { is } | true } } }
    const changes: Array<{ the: string; of: string; is?: unknown }> =
      Symbol.iterator in args.changes
        ? [...args.changes]
        : Object.entries(args.changes as Record<string, any>).flatMap(
          ([entityId, typeMap]: [string, any]) =>
            Object.entries(typeMap).flatMap(
              ([type, causeEntries]: [string, any]) =>
                Object.values(causeEntries).map((entry: any) => ({
                  the: type,
                  of: entityId,
                  is: entry === true ? undefined : entry.is,
                })),
            ),
        );
    for (const fact of changes) {
      const entityId = fact.of as EntityId;
      const head = this.#transport.space.readHead("", entityId);
      const parent: Reference = head
        ? (head.factHash as unknown as Reference)
        : EMPTY(entityId);

      if (fact.is !== undefined) {
        operations.push({
          op: "set" as const,
          id: entityId,
          value: fact.is as JSONValue,
          parent,
        });
      } else {
        operations.push({
          op: "delete" as const,
          id: entityId,
          parent,
        });
      }
    }

    const clientCommit: ClientCommit = {
      reads: { confirmed: [], pending: [] },
      operations,
    };
    applyCommit(this.#transport.space.store, clientCommit);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// StorageManagerEmulator
// ---------------------------------------------------------------------------

export class StorageManagerEmulator extends BaseStorageManager {
  #subscription = StorageSubscription.create();

  override connect(space: MemorySpace) {
    return V2Provider.create(
      space,
      this.#subscription,
      (callbacks) => new V2DirectTransport(space as SpaceId, callbacks),
    );
  }

  /**
   * Get the V2DirectTransport for a space (creating the provider if needed).
   */
  private getTransport(space: MemorySpace): V2DirectTransport {
    const provider = this.open(space) as V2Provider;
    return provider.transport as V2DirectTransport;
  }

  /**
   * v1 compat: returns a V2EmulatedMemory with `query()` for the given space.
   */
  mount(space: MemorySpace): V2EmulatedMemory {
    return new V2EmulatedMemory(this.getTransport(space));
  }

  /**
   * v1 compat: returns an object with `mount()` for test setup access.
   */
  session(): { mount: (space: MemorySpace) => V2EmulatedMemory } {
    return {
      mount: (space: MemorySpace) => this.mount(space),
    };
  }

  /**
   * Subscribes to changes in the storage.
   */
  override subscribe(subscription: IStorageSubscription): void {
    this.#subscription.subscribe(subscription);
  }

  /**
   * Inject data as if it came from another client.
   * Writes to the space and triggers subscription updates, producing
   * "integrate" notifications in V2Provider. For tests only.
   */
  injectExternal(
    space: MemorySpace,
    entities: Array<{ id: string; value: unknown }>,
  ): void {
    const transport = this.getTransport(space);
    transport.injectExternalCommit(
      entities.map((e) => ({
        id: e.id as EntityId,
        value: e.value as JSONValue,
      })),
    );
  }
}

export class StorageManager extends BaseStorageManager {
  static override open(options: Options) {
    if (options.address.protocol === "memory:") {
      return this.emulate(options);
    } else {
      return new this(options);
    }
  }
  static emulate(
    options: Omit<Options, "address">,
  ) {
    return new StorageManagerEmulator({
      ...options,
      address: new URL("memory://"),
    });
  }
}
