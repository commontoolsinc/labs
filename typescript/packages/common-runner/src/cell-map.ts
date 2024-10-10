import {
  type CellImpl,
  isCellProxyForDereferencing,
  isCellReference,
  isSimpleCell,
  isCell,
  getCellReferenceOrThrow,
} from "./cell.js";

export const getEntityId = (value: any): string | undefined => {
  // TODO: When path is not empty, path to generate unique ID
  if (isCellProxyForDereferencing(value))
    value = getCellReferenceOrThrow(value);
  if (isCellReference(value)) value = value.cell;
  if (isSimpleCell(value)) return value.getAsCell().entityId;
  if (isCell(value)) return value.entityId;
  else return undefined;
};

export function getCellByEntityId<T = any>(
  entityId: string
): CellImpl<T> | undefined {
  return entityIdToCellMap.get(entityId);
}

export const setCellByEntityId = (entityId: string, cell: CellImpl<any>) => {
  entityIdToCellMap.set(entityId, cell);
};

/**
 * A map that holds weak references to its values. Triggers a cleanup of the map
 * when any item was garbage collected, so that the weak references themselves
 * can be garbage collected.
 */
class CleanableMap<T extends object> {
  private map = new Map<string, WeakRef<T>>();
  private cleanupScheduled = false;

  set(key: string, value: T) {
    this.map.set(key, new WeakRef(value));
  }

  get(key: string): T | undefined {
    const ref = this.map.get(key);
    if (ref) {
      const value = ref.deref();
      if (value === undefined) {
        this.scheduleCleanup();
      }
      return value;
    }
    return undefined;
  }

  private scheduleCleanup() {
    if (!this.cleanupScheduled) {
      this.cleanupScheduled = true;
      queueMicrotask(() => {
        this.cleanup();
        this.cleanupScheduled = false;
      });
    }
  }

  private cleanup() {
    for (const [key, ref] of this.map) {
      if (ref.deref() === undefined) {
        this.map.delete(key);
      }
    }
  }
}

const entityIdToCellMap = new CleanableMap<CellImpl<any>>();
