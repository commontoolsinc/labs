import type { MemorySpace, SchemaContext } from "@commontools/memory/interface";
import { getLogger } from "@commontools/utils/logger";
import { type Cancel, useCancelGroup } from "./cancel.ts";
import { type Cell, isCell } from "./cell.ts";
import type {
  IExtendedStorageTransaction,
  IStorageManager,
  IStorageProvider,
  IStorageSubscription,
  Labels,
} from "./storage/interface.ts";
import type { IRuntime, IStorage } from "./runtime.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
export type { Labels, MemorySpace };

const logger = getLogger("storage", { enabled: false, level: "debug" });

/**
 * Storage implementation.
 *
 * Life-cycle of a doc: (1) not known to storage – a doc might just be a
 *  temporary doc, e.g. holding input bindings or so (2) known to storage, but
 *  not yet loaded – we know about the doc, but don't have the data yet. (3)
 *  Once loaded, if there was data in storage, we overwrite the current value of
 *  the doc, and if there was no data in storage, we use the current value of
 *  the doc and write it to storage. (4) The doc is subscribed to updates from
 *  storage and docs, and each time the doc changes, the new value is written
 *  to storage, and vice versa.
 *
 * But reading and writing don't happen in one step: We follow all doc
 * references and make sure all docs are loaded before we start writing. This
 * is recursive, so if doc A references doc B, and doc B references doc C,
 * then doc C will also be loaded when we process doc A. We might receive
 * updates for docs (either locally or from storage), while we wait for the
 * docs to load, and this might introduce more dependencies, and we'll pick
 * those up as well. For now, we wait until we reach a stable point, i.e. no
 * loading docs pending, but we might instead want to eventually queue up
 * changes instead.
 *
 * Following references depends on the direction of the write: When writing from
 * a doc to storage, we turn doc references into ids. When writing from
 * storage to a doc, we turn ids into doc references.
 *
 * In the future we should be smarter about whether the local state or remote
 * state is more up to date. For now we assume that the remote state is always
 * more current. The idea is that the local state is optimistically executing
 * on possibly stale state, while if there is something in storage, another node
 * is probably already further ahead.
 */
export class Storage implements IStorage {
  // Map from space to storage provider. TODO(seefeld): Push spaces to storage
  // providers.
  private storageProviders = new Map<string, IStorageProvider>();
  private cancel: Cancel;

  constructor(
    readonly runtime: IRuntime,
    private readonly storageManager: IStorageManager,
  ) {
    const [cancel, _addCancel] = useCancelGroup();
    this.cancel = cancel;
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IExtendedStorageTransaction {
    return new ExtendedStorageTransaction(this.storageManager.edit());
  }

  /**
   * Subscribe to storage notifications.
   *
   * @param subscription - The subscription to subscribe to.
   */
  subscribe(subscription: IStorageSubscription) {
    this.storageManager.subscribe(subscription);
  }

  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * TODO(seefeld): Should this return a `Cell` instead? Or just an empty promise?
   */
  async syncCell<T = any>(
    cell: Cell<any>,
    expectedInStorage?: boolean,
    schemaContext?: SchemaContext,
  ): Promise<Cell<T>> {
    // If we aren't overriding the schema context, and we have a schema in the cell, use that
    if (
      schemaContext === undefined && isCell(cell) &&
      cell.schema !== undefined
    ) {
      schemaContext = {
        schema: cell.schema,
        rootSchema: (cell.rootSchema !== undefined)
          ? cell.rootSchema
          : cell.schema,
      };
    }
    const selector = schemaContext === undefined ? undefined : {
      path: cell.path.map((p) => p.toString()),
      schemaContext,
    };

    const { space, id } = cell.getAsNormalizedFullLink();
    if (!space) throw new Error("No space set");
    let storageProvider = this.storageProviders.get(space);

    if (!storageProvider) {
      storageProvider = this.storageManager.open(space);
      this.storageProviders.set(space, storageProvider);
    }
    await storageProvider.sync(id, selector);
    return cell;
  }

  async synced(): Promise<void> {
    return await this.storageManager.synced();
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      Array.from(this.storageProviders.values()).map((provider) =>
        provider.destroy()
      ),
    );
    this.cancel();
  }
}
