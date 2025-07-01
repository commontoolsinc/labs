import { getTopFrame } from "./builder/recipe.ts";
import { TYPE } from "./builder/types.ts";
import type { DocImpl } from "./doc.ts";
import type { Cancel } from "./cancel.ts";
import { type LegacyDocCellLink, type URI } from "./sigil-types.ts";
import { toURI } from "./uri-utils.ts";
import type { IMemoryAddress } from "./storage/interface.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  IRuntime,
  IScheduler,
  MemorySpace,
  IStorageTransaction,
} from "./runtime.ts";

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };

export type Action = (log: ReactivityLog) => any;
export type TransactionAction = (tx: IStorageTransaction) => any;
export type EventHandler = (event: any) => any;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to memory locations. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 * 
 * Currently supports both legacy LegacyDocCellLink format and new IMemoryAddress format
 * for backward compatibility during migration.
 */
export type ReactivityLog = {
  reads: (LegacyDocCellLink | IMemoryAddress)[];
  writes: (LegacyDocCellLink | IMemoryAddress)[];
};

/**
 * Extract reads and writes from a transaction for dependency tracking.
 * Converts transaction invariants to ReactivityLog format.
 */
function extractDependenciesFromTransaction(
  tx: IStorageTransaction,
  runtime: IRuntime,
): ReactivityLog {
  const reads: IMemoryAddress[] = [];
  const writes: IMemoryAddress[] = [];
  
  const status = tx.status();
  if (status.ok) {
    const log = status.ok.open || status.ok.pending || status.ok.done;
    if (log) {
      // Iterate through transaction invariants
      for (const invariant of log) {
        if (invariant.read) {
          const read = invariant.read;
          // Use the address directly - it's already an IMemoryAddress
          reads.push(read.address);
        } else if (invariant.write) {
          const write = invariant.write;
          // Use the address directly - it's already an IMemoryAddress
          writes.push(write.address);
        }
      }
    }
  }
  
  return { reads, writes };
}

const MAX_ITERATIONS_PER_RUN = 100;

/**
 * Check if a value is an IMemoryAddress (not a LegacyDocCellLink).
 */
function isMemoryAddress(value: any): value is IMemoryAddress {
  return value && typeof value.id === "string" && value.type === "application/json";
}

/**
 * Convert a LegacyDocCellLink to IMemoryAddress.
 */
function toMemoryAddress(link: LegacyDocCellLink | IMemoryAddress): IMemoryAddress {
  if (isMemoryAddress(link)) {
    return link;
  }
  return {
    id: toURI(link.cell.entityId),
    space: link.space || link.cell.space,
    path: link.path.map(p => p.toString()),
    type: "application/json",
  };
}

/**
 * Compare two IMemoryAddress objects for equality.
 */
function isSameAddress(a: IMemoryAddress, b: IMemoryAddress): boolean {
  return (
    a.id === b.id &&
    a.space === b.space &&
    a.type === b.type &&
    a.path.length === b.path.length &&
    a.path.every((p, i) => p === b.path[i])
  );
}

/**
 * Create a string key for an IMemoryAddress for use in Set/Map.
 */
function addressKey(addr: IMemoryAddress): string {
  return JSON.stringify({
    id: addr.id,
    space: addr.space,
    path: addr.path,
    type: addr.type,
  });
}

/**
 * Custom Set implementation for IMemoryAddress objects.
 */
class AddressSet {
  private items = new Map<string, IMemoryAddress>();
  
  add(addr: IMemoryAddress): void {
    this.items.set(addressKey(addr), addr);
  }
  
  has(addr: IMemoryAddress): boolean {
    return this.items.has(addressKey(addr));
  }
  
  delete(addr: IMemoryAddress): boolean {
    return this.items.delete(addressKey(addr));
  }
  
  clear(): void {
    this.items.clear();
  }
  
  get size(): number {
    return this.items.size;
  }
  
  [Symbol.iterator](): Iterator<IMemoryAddress> {
    return this.items.values();
  }
}

export class Scheduler implements IScheduler {
  private pending = new Set<Action>();
  private eventQueue: (() => any)[] = [];
  private eventHandlers: [IMemoryAddress, EventHandler][] = [];
  private dirty = new AddressSet();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel[]>();
  private idlePromises: (() => void)[] = [];
  private loopCounter = new WeakMap<Action, number>();
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;

  get runningPromise(): Promise<unknown> | undefined {
    return this._running;
  }

  set runningPromise(promise: Promise<unknown> | undefined) {
    if (this._running !== undefined) {
      throw new Error(
        "Cannot set running while another promise is in progress",
      );
    }
    if (promise !== undefined) {
      this._running = promise.finally(() => {
        this._running = undefined;
      });
    }
  }

  constructor(
    readonly runtime: IRuntime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    this.consoleHandler = consoleHandler ||
      function (_metadata, _method, args) {
        // Default console handler returns arguments unaffected.
        return args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.errorHandlers.add(handler));
    }

    // Set up harness event listeners
    this.runtime.harness.addEventListener("console", (e: Event) => {
      // Called synchronously when `console` methods are
      // called within the runtime.
      const { method, args } = e as ConsoleEvent;
      const metadata = getCharmMetadataFromFrame();
      const result = this.consoleHandler(metadata, method, args);
      console[method].apply(console, result);
    });
  }

  schedule(action: Action, log: ReactivityLog): Cancel {
    const reads = this.setDependencies(action, log);
    reads.forEach((addr) => this.dirty.add(addr));

    this.queueExecution();
    this.pending.add(action);

    return () => this.unschedule(action);
  }

  unschedule(action: Action): void {
    this.cancels.get(action)?.forEach((cancel) => cancel());
    this.cancels.delete(action);
    this.dependencies.delete(action);
    this.pending.delete(action);
  }

  subscribe(action: Action, log: ReactivityLog): Cancel {
    const reads = this.setDependencies(action, log);

    // For now, we need to convert back to docs for subscription
    // TODO: Implement proper subscription mechanism for memory addresses
    const cancels: Cancel[] = [];
    for (const addr of reads) {
      const entityId = { "/": addr.id.slice(3) }; // Remove "of:" prefix
      const doc = this.runtime.documentMap.getDocByEntityId(
        addr.space,
        entityId,
        false,
      );
      if (doc) {
        cancels.push(
          doc.updates((_newValue: any, changedPath: PropertyKey[]) => {
            // Check if the changed path affects our watched address
            // Need to handle both cases: paths with and without "value" prefix
            let pathToCheck = addr.path;
            
            // If the address path starts with "value", compare with value-prefixed changed path
            if (addr.path.length > 0 && addr.path[0] === "value") {
              const fullChangedPath = ["value", ...changedPath];
              if (pathAffected(fullChangedPath, addr.path)) {
                this.dirty.add(addr);
                this.queueExecution();
                this.pending.add(action);
              }
            } else {
              // Otherwise, compare directly
              if (pathAffected(changedPath, addr.path)) {
                this.dirty.add(addr);
                this.queueExecution();
                this.pending.add(action);
              }
            }
          })
        );
      }
    }
    
    this.cancels.set(action, cancels);

    return () => this.unschedule(action);
  }

  async run(action: Action): Promise<any> {
    const log: ReactivityLog = { reads: [], writes: [] };

    if (this.runningPromise) await this.runningPromise;

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const finalizeAction = (error?: unknown) => {
        try {
          if (error) this.handleError(error as Error, action);
        } finally {
          // Set up reactive subscriptions after the action runs
          // This matches the original scheduler behavior
          this.subscribe(action, log);
          resolve(result);
        }
      };

      try {
        Promise.resolve(action(log))
          .then((actionResult) => {
            result = actionResult;
            finalizeAction();
          })
          .catch((error) => finalizeAction(error));
      } catch (error) {
        finalizeAction(error);
      }
    });

    return this.runningPromise;
  }

  /**
   * Run a transaction-based action. Creates a transaction, runs the action,
   * extracts dependencies, and commits the transaction.
   */
  async runWithTransaction(action: TransactionAction): Promise<any> {
    if (this.runningPromise) await this.runningPromise;

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const tx = this.runtime.edit();
      
      const finalizeAction = (error?: unknown) => {
        try {
          if (error) {
            tx.abort();
            this.handleError(error as Error, action);
          } else {
            // Extract dependencies before committing
            const log = extractDependenciesFromTransaction(tx, this.runtime);
            
            // Commit the transaction
            tx.commit().then((commitResult) => {
              if (commitResult.error) {
                this.handleError(
                  new Error(`Transaction commit failed: ${commitResult.error}`),
                  action,
                );
              } else {
                // Set up reactive subscriptions after successful commit
                // Create a wrapper action that creates a new transaction
                const wrappedAction = (log: ReactivityLog) => {
                  const newTx = this.runtime.edit();
                  const result = action(newTx);
                  // Extract dependencies to update the log
                  const txLog = extractDependenciesFromTransaction(newTx, this.runtime);
                  log.reads.push(...txLog.reads);
                  log.writes.push(...txLog.writes);
                  newTx.commit();
                  return result;
                };
                this.subscribe(wrappedAction, log);
              }
            });
          }
        } finally {
          resolve(result);
        }
      };

      try {
        Promise.resolve(action(tx))
          .then((actionResult) => {
            result = actionResult;
            finalizeAction();
          })
          .catch((error) => finalizeAction(error));
      } catch (error) {
        finalizeAction(error);
      }
    });

    return this.runningPromise;
  }

  idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      // NOTE: This relies on the finally clause to set runningPromise to
      // undefined to prevent infinite loops.
      if (this.runningPromise) {
        this.runningPromise.then(() => this.idle().then(resolve));
      } // Once nothing is running, see if more work is queued up. If not, then
      // resolve the idle promise, otherwise add it to the idle promises list
      // that will be resolved once all the work is done.
      else if (this.pending.size === 0 && this.eventQueue.length === 0) {
        resolve();
      } else {
        this.idlePromises.push(resolve);
      }
    });
  }

  queueEvent(eventRef: LegacyDocCellLink, event: any): void {
    // Convert LegacyDocCellLink to IMemoryAddress
    const eventAddr: IMemoryAddress = {
      id: toURI(eventRef.cell.entityId),
      space: eventRef.space || eventRef.cell.space,
      path: eventRef.path.map(p => p.toString()),
      type: "application/json",
    };
    
    for (const [ref, handler] of this.eventHandlers) {
      if (isSameAddress(ref, eventAddr)) {
        this.queueExecution();
        this.eventQueue.push(() => handler(event));
      }
    }
  }

  addEventHandler(handler: EventHandler, ref: LegacyDocCellLink): Cancel {
    // Convert LegacyDocCellLink to IMemoryAddress
    const addr: IMemoryAddress = {
      id: toURI(ref.cell.entityId),
      space: ref.space || ref.cell.space,
      path: ref.path.map(p => p.toString()),
      type: "application/json",
    };
    
    this.eventHandlers.push([addr, handler]);
    return () => {
      const index = this.eventHandlers.findIndex(([r, h]) =>
        isSameAddress(r, addr) && h === handler
      );
      if (index !== -1) this.eventHandlers.splice(index, 1);
    };
  }

  onConsole(fn: ConsoleHandler): void {
    this.consoleHandler = fn;
  }

  onError(fn: ErrorHandler): void {
    this.errorHandlers.add(fn);
  }

  private queueExecution(): void {
    if (this.scheduled) return;
    queueMicrotask(() => this.execute());
    this.scheduled = true;
  }

  private setDependencies(
    action: Action,
    log: ReactivityLog,
  ): IMemoryAddress[] {
    // Convert all entries to IMemoryAddress format
    const readAddresses = log.reads.map(toMemoryAddress);
    const writeAddresses = log.writes.map(toMemoryAddress);
    
    const reads = compactifyAddresses(readAddresses);
    const writes = compactifyAddresses(writeAddresses);
    this.dependencies.set(action, { reads, writes });
    return reads;
  }

  private handleError(error: Error, action: any) {
    const { charmId, recipeId, space } = getCharmMetadataFromFrame() ?? {};

    const errorWithContext = error as ErrorWithContext;
    errorWithContext.action = action;
    if (charmId) errorWithContext.charmId = charmId;
    if (recipeId) errorWithContext.recipeId = recipeId;
    if (space) errorWithContext.space = space as MemorySpace;

    for (const handler of this.errorHandlers) {
      try {
        handler(errorWithContext);
      } catch (handlerError) {
        console.error("Error in error handler:", handlerError);
      }
    }

    if (this.errorHandlers.size === 0) {
      console.error("Uncaught error in action:", errorWithContext);
    }
  }

  private async execute(): Promise<void> {
    // In case a directly invoked `run` is still running, wait for it to finish.
    if (this.runningPromise) await this.runningPromise;

    // Process next event from the event queue. Will mark more docs as dirty.
    const handler = this.eventQueue.shift();
    if (handler) {
      try {
        this.runningPromise = Promise.resolve(
          this.runtime.harness.invoke(handler),
        ).catch((error) => {
          this.handleError(error as Error, handler);
        });
        await this.runningPromise;
      } catch (error) {
        this.handleError(error as Error, handler);
      }
    }

    const order = topologicalSort(
      this.pending,
      this.dependencies,
      this.dirty,
    );

    // Clear pending and dirty sets, and cancel all listeners for docs on already
    // scheduled actions.
    this.pending.clear();
    this.dirty.clear();
    for (const fn of order) {
      this.cancels.get(fn)?.forEach((cancel) => cancel());
    }

    // Now run all functions. This will create new listeners to mark docs dirty
    // and schedule the next run.
    for (const fn of order) {
      this.loopCounter.set(fn, (this.loopCounter.get(fn) || 0) + 1);
      if (this.loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
        this.handleError(
          new Error(
            `Too many iterations: ${this.loopCounter.get(fn)} ${fn.name ?? ""}`,
          ),
          fn,
        );
      } else {
        await this.run(fn);
      }
    }

    if (this.pending.size === 0 && this.eventQueue.length === 0) {
      const promises = this.idlePromises;
      for (const resolve of promises) resolve();
      this.idlePromises.length = 0;
      this.loopCounter = new WeakMap();
      this.scheduled = false;
    } else {
      queueMicrotask(() => this.execute());
    }
  }
}

function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  dirty: AddressSet,
): Action[] {
  const relevantActions = new Set<Action>();
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // First pass: identify relevant actions
  for (const action of actions) {
    const { reads } = dependencies.get(action)!;
    // TODO(seefeld): Keep track of affected paths
    if (reads.length === 0) {
      // Actions with no dependencies are always relevant. Note that they must
      // be manually added to `pending`, which happens only once on `schedule`.
      relevantActions.add(action);
    } else if (reads.some((addr) => {
      // Check if any dirty address matches this read
      const memAddr = toMemoryAddress(addr);
      for (const dirtyAddr of dirty) {
        if (isSameAddress(memAddr, dirtyAddr)) {
          return true;
        }
      }
      return false;
    })) {
      relevantActions.add(action);
    }
  }

  // Second pass: add downstream actions
  let size;
  do {
    size = relevantActions.size;
    for (const action of actions) {
      if (!relevantActions.has(action)) {
        const { writes } = dependencies.get(action)!;
        for (const write of writes) {
          if (
            Array.from(relevantActions).some((relevantAction) =>
              dependencies
                .get(relevantAction)!
                .reads.some(
                  (read) => {
                    const readAddr = toMemoryAddress(read);
                    const writeAddr = toMemoryAddress(write);
                    return isSameAddress({ ...readAddr, path: [] }, { ...writeAddr, path: [] }) && 
                           pathAffected(writeAddr.path, readAddr.path);
                  }
                )
            )
          ) {
            relevantActions.add(action);
            break;
          }
        }
      }
    }
  } while (relevantActions.size > size);

  // Initialize graph and inDegree for relevant actions
  for (const action of relevantActions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }

  // Build the graph
  for (const actionA of relevantActions) {
    const { writes } = dependencies.get(actionA)!;
    const graphA = graph.get(actionA)!;
    for (const write of writes) {
      for (const actionB of relevantActions) {
        if (actionA !== actionB && !graphA.has(actionB)) {
          const { reads } = dependencies.get(actionB)!;
          if (
            reads.some((read) => {
              const readAddr = toMemoryAddress(read);
              const writeAddr = toMemoryAddress(write);
              return isSameAddress({ ...readAddr, path: [] }, { ...writeAddr, path: [] }) && 
                     pathAffected(writeAddr.path, readAddr.path);
            })
          ) {
            graphA.add(actionB);
            inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
          }
        }
      }
    }
  }

  // Perform topological sort with cycle handling
  const queue: Action[] = [];
  const result: Action[] = [];
  const visited = new Set<Action>();

  // Add all actions with no dependencies (in-degree 0) to the queue
  for (const [action, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(action);
    }
  }

  while (queue.length > 0 || visited.size < relevantActions.size) {
    if (queue.length === 0) {
      // Handle cycle: choose an unvisited node with the lowest in-degree
      const unvisitedAction = Array.from(relevantActions)
        .filter((action) => !visited.has(action))
        .reduce((a, b) => (inDegree.get(a)! < inDegree.get(b)! ? a : b));
      queue.push(unvisitedAction);
    }

    const current = queue.shift()!;
    if (visited.has(current)) continue;

    result.push(current);
    visited.add(current);

    for (const neighbor of graph.get(current) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }

  return result;
}

// Remove longer paths already covered by shorter paths
export function compactifyPaths(
  entries: LegacyDocCellLink[],
): LegacyDocCellLink[] {
  // Convert to addresses, compactify, then convert back
  const addresses: IMemoryAddress[] = entries.map((entry) => ({
    id: toURI(entry.cell.entityId),
    space: entry.space || entry.cell.space,
    path: entry.path.map(p => p.toString()),
    type: "application/json",
  }));
  
  const compacted = compactifyAddresses(addresses);
  
  // Convert back to LegacyDocCellLink format
  return compacted.map((addr) => {
    const entityId = { "/": addr.id.slice(3) };
    const doc = entries.find(e => toURI(e.cell.entityId) === addr.id)?.cell;
    if (!doc) {
      throw new Error(`Could not find doc for ${addr.id}`);
    }
    return {
      cell: doc,
      path: addr.path.map(p => p.toString()),
      space: addr.space,
    };
  });
}

// Remove longer paths already covered by shorter paths
function compactifyAddresses(
  entries: IMemoryAddress[],
): IMemoryAddress[] {
  // First group by id and space via a Map
  const addressGroups = new Map<string, { addr: IMemoryAddress; paths: PropertyKey[][] }>();
  
  for (const addr of entries) {
    const key = `${addr.id}:${addr.space}`;
    const existing = addressGroups.get(key);
    if (existing) {
      existing.paths.push(addr.path);
    } else {
      addressGroups.set(key, {
        addr: addr,
        paths: [addr.path]
      });
    }
  }

  // For each address group, sort the paths by length, then only return those that don't
  // have a prefix earlier in the list
  const result: IMemoryAddress[] = [];
  for (const { addr, paths } of addressGroups.values()) {
    paths.sort((a, b) => a.length - b.length);
    for (let i = 0; i < paths.length; i++) {
      const earlier = paths.slice(0, i);
      if (
        earlier.some((path) =>
          path.every((key, index) => key === paths[i][index])
        )
      ) {
        continue;
      }
      result.push({
        id: addr.id,
        space: addr.space,
        path: paths[i].map(p => p.toString()),
        type: addr.type,
      });
    }
  }
  return result;
}

function pathAffected(changedPath: PropertyKey[], path: PropertyKey[]) {
  // Normalize both paths to strings for comparison
  changedPath = changedPath.map((key) => key.toString());
  const normalizedPath = path.map((key) => key.toString());
  
  return (
    (changedPath.length <= normalizedPath.length &&
      changedPath.every((key, index) => key === normalizedPath[index])) ||
    normalizedPath.every((key, index) => key === changedPath[index])
  );
}

function getCharmMetadataFromFrame(): {
  recipeId?: string;
  space?: string;
  charmId?: string;
} | undefined {
  // TODO(seefeld): This is a rather hacky way to get the context, based on the
  // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
  // abstractions for context here as well.
  const frame = getTopFrame();

  const sourceAsProxy = frame?.unsafe_binding?.materialize([]);

  if (!isQueryResultForDereferencing(sourceAsProxy)) {
    return;
  }
  const result: ReturnType<typeof getCharmMetadataFromFrame> = {};
  const { cell: source } = getCellLinkOrThrow(sourceAsProxy);
  result.recipeId = source?.get()?.[TYPE];
  const resultDoc = source?.get()?.resultRef?.cell;
  result.space = resultDoc?.space;
  result.charmId = JSON.parse(
    JSON.stringify(resultDoc?.entityId ?? {}),
  )["/"];
  return result;
}
