import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  type Cancel,
  type Cell,
  type MemorySpace,
  type Runtime,
} from "@commonfabric/runner";
import { stableFabricValue } from "./stable-fabric-value.ts";

export interface AgentFabricConnection {
  runtime: Runtime;
  spaceDid: MemorySpace;
}

export type StableCellMaterializer = (
  cause: unknown,
  value: unknown,
) => Cell<unknown>;

export interface StableCellGraphEntry {
  cell: Cell<unknown>;
  value: (
    materializeCell: StableCellMaterializer,
  ) => Record<string, unknown>;
}

const HYDRATION_BATCH_SIZE = 50;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function commitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Fabric transaction commit failed";
}

export function stableCellId(cell: Cell<unknown>): string {
  const id = cell.getAsNormalizedFullLink().id!;
  return id.startsWith("of:") ? id.slice(3) : id;
}

export async function pushStableCellGraph(
  connection: AgentFabricConnection,
  entries: ReadonlyArray<StableCellGraphEntry>,
): Promise<void> {
  if (entries.length === 0) return;
  const tx = connection.runtime.edit();
  try {
    const writeCellValue = (cell: Cell<unknown>, value: unknown) => {
      const link = cell.getAsNormalizedFullLink();
      if (!isPlainRecord(value)) {
        tx.writeValueOrThrow(link, stableFabricValue(value));
        return cell;
      }
      const priorValue = tx.readValueOrThrow(link);
      if (!isPlainRecord(priorValue)) {
        tx.writeValueOrThrow(link, stableFabricValue(value));
        return cell;
      }
      for (const key of Object.keys(priorValue)) {
        if (!Object.hasOwn(value, key)) {
          tx.writeOrThrow(
            {
              space: link.space!,
              scope: link.scope,
              id: link.id!,
              path: ["value", ...link.path, key],
            },
            undefined,
            { delete: true },
          );
        }
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        tx.writeOrThrow(
          {
            space: link.space!,
            scope: link.scope,
            id: link.id!,
            path: ["value", ...link.path, key],
          },
          stableFabricValue(fieldValue),
        );
      }
      return cell;
    };
    const materializeCell: StableCellMaterializer = (cause, value) =>
      writeCellValue(
        connection.runtime.getCell(
          connection.spaceDid,
          cause,
          undefined,
          tx,
        ),
        value,
      );
    for (const entry of entries) {
      writeCellValue(entry.cell, entry.value(materializeCell));
    }
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  const result = await tx.commit();
  if (result.error) {
    throw new Error(commitErrorMessage(result.error), { cause: result.error });
  }
}

async function resolveStableGraphLinks(
  connection: AgentFabricConnection,
  value: unknown,
  cache: Map<string, Promise<unknown>>,
  preserveLinkFields: ReadonlySet<string>,
  field?: string,
): Promise<unknown> {
  if (isLinkRef(value)) {
    if (field && preserveLinkFields.has(field)) return value;
    const link = linkRefPayload(value);
    if (typeof link.id !== "string" || typeof link.space !== "string") {
      throw new Error(
        `Stable graph contains an incomplete link: ${JSON.stringify(link)}`,
      );
    }
    const key = JSON.stringify({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path ?? [],
      preserveLinkFields: [...preserveLinkFields].sort(),
    });
    const cached = cache.get(key);
    if (cached) return await cached;
    const pending = (async () => {
      const child = connection.runtime.getCellFromLink(
        link as Parameters<Runtime["getCellFromLink"]>[0],
      );
      await child.sync();
      await connection.runtime.storageManager.synced();
      return await resolveStableGraphLinks(
        connection,
        child.getRaw(),
        cache,
        preserveLinkFields,
      );
    })();
    cache.set(key, pending);
    return await pending;
  }
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (
      let offset = 0;
      offset < value.length;
      offset += HYDRATION_BATCH_SIZE
    ) {
      resolved.push(
        ...await Promise.all(
          value.slice(offset, offset + HYDRATION_BATCH_SIZE).map((child) =>
            resolveStableGraphLinks(
              connection,
              child,
              cache,
              preserveLinkFields,
            )
          ),
        ),
      );
    }
    return resolved;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value as Record<string, unknown>).map(
          async ([key, child]) => [
            key,
            await resolveStableGraphLinks(
              connection,
              child,
              cache,
              preserveLinkFields,
              key,
            ),
          ],
        ),
      ),
    );
  }
  return value;
}

export async function readStableCellGraphValue(
  connection: AgentFabricConnection,
  cell: Cell<unknown>,
  cache: Map<string, Promise<unknown>> = new Map(),
  options: { preserveLinkFields?: ReadonlySet<string> } = {},
): Promise<unknown> {
  await cell.sync();
  await connection.runtime.storageManager.synced();
  return await resolveStableGraphLinks(
    connection,
    cell.getRaw(),
    cache,
    options.preserveLinkFields ?? new Set(),
  );
}

export async function subscribeStableActions(
  connection: AgentFabricConnection,
  cell: Cell<unknown>,
  callback: (actions: unknown[]) => void,
): Promise<Cancel> {
  await cell.sync();
  await connection.runtime.storageManager.synced();
  return cell.sink((value) => {
    callback(Array.isArray(value) ? [...value] : []);
  });
}

export async function readStableActions(
  cell: Cell<unknown>,
): Promise<unknown[]> {
  const value = await cell.pull();
  return Array.isArray(value) ? [...value] : [];
}
