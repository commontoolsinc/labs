/**
 * Adapts a `cf-iframe` cell context into explicit bridge capabilities. Scoped
 * children resolve before guest load, fixing each grant to its concrete cell.
 */

import {
  type BridgeResource,
  createFabricBridge,
  type FabricBridge,
} from "@commonfabric/iframe-sandbox";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  CellHandle,
  type ClientCellValue,
  isCellHandle,
} from "@commonfabric/runtime-client";
import type { JSONSchema } from "@commonfabric/runner/shared";

/** Capability kind assigned to a named context child. */
export type CellContextResourceKind =
  | "cell"
  | "readonly"
  | "stream"
  | "sqlite";

function cellKind(schema: JSONSchema | undefined): string | undefined {
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.asCell)) {
    return undefined;
  }
  const entry = schema.asCell[0];
  return typeof entry === "string"
    ? entry
    : entry && typeof entry === "object" && "kind" in entry &&
        typeof entry.kind === "string"
    ? entry.kind
    : undefined;
}

function bridgeValue(value: unknown): FabricValue {
  if (isCellHandle(value)) return value.toJSON();
  if (Array.isArray(value)) return value.map(bridgeValue);
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return value as FabricValue;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, bridgeValue(member)]),
    );
  }
  return value as FabricValue;
}

function sqliteInput(value: FabricValue | undefined): {
  sql: string;
  params?: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SQLite operations require an object input.");
  }
  const input = value as Record<string, FabricValue>;
  if (typeof input.sql !== "string") {
    throw new TypeError("SQLite operations require a string `sql` field.");
  }
  const params = input.params;
  if (
    params !== undefined && !Array.isArray(params) &&
    (!params || typeof params !== "object")
  ) {
    throw new TypeError("SQLite `params` must be an array or object.");
  }
  return {
    sql: input.sql,
    ...(params !== undefined && {
      params: params as
        | ReadonlyArray<ClientCellValue>
        | Record<string, ClientCellValue>,
    }),
  };
}

function cellResource(
  cell: CellHandle<unknown>,
  schema: JSONSchema | undefined,
  kindHint?: CellContextResourceKind,
): BridgeResource {
  const kind = kindHint ?? cellKind(schema);
  const description = schema && typeof schema === "object" &&
      typeof schema.description === "string"
    ? schema.description
    : undefined;
  const metadata = {
    ...(schema !== undefined && { schema: schema as FabricValue }),
    ...(description !== undefined && { description }),
  };

  if (kind === "sqlite") {
    const revisionCell = cell.asSchema<Record<string, unknown>>({
      type: "object",
      additionalProperties: true,
    });
    return {
      kind: "sqlite",
      ...metadata,
      subscribe: (listener) => {
        let initial = true;
        return revisionCell.subscribe(() => {
          if (initial) {
            initial = false;
            return;
          }
          listener(undefined);
        });
      },
      methods: {
        query: async (value) => {
          const { sql, params } = sqliteInput(value);
          return {
            rows: bridgeValue(
              await cell.querySqlite(sql, params),
            ) as FabricValue[],
          };
        },
        exec: async (value) => {
          const { sql, params } = sqliteInput(value);
          await cell.execSqlite(sql, params);
        },
      },
    };
  }

  if (kind === "stream") {
    return {
      kind: "stream",
      ...metadata,
      methods: {
        send: async (value) => {
          await cell.sendStrict(value as ClientCellValue);
        },
      },
    };
  }

  return {
    kind: "cell",
    ...metadata,
    read: async () => bridgeValue(await cell.sync()),
    ...(kind !== "readonly" && {
      write: async (value: FabricValue) => await cell.setStrict(value),
    }),
    subscribe: (listener) => {
      let initial = true;
      return cell.subscribe((value) => {
        if (initial) {
          initial = false;
          return;
        }
        listener(bridgeValue(value));
      });
    },
  };
}

function localResource(
  context: Record<string, unknown>,
  name: string,
): BridgeResource {
  return {
    kind: "cell",
    read: () => bridgeValue(context[name]),
    write: (value) => {
      context[name] = value;
    },
  };
}

function schemaProperties(
  schema: JSONSchema | undefined,
): Record<string, JSONSchema> {
  return schema && typeof schema === "object" && schema.properties &&
      typeof schema.properties === "object"
    ? schema.properties as Record<string, JSONSchema>
    : {};
}

function cellContextResources(
  root: CellHandle<Record<string, unknown>>,
): Record<string, BridgeResource> {
  const names = (): Set<string> => {
    const current = root.get();
    return new Set([
      ...Object.keys(schemaProperties(root.ref().schema)),
      ...(current && typeof current === "object" ? Object.keys(current) : []),
    ]);
  };
  const resource = (name: string): BridgeResource | undefined => {
    const properties = schemaProperties(root.ref().schema);
    const current = root.get();
    if (
      !Object.hasOwn(properties, name) &&
      !(current && Object.hasOwn(current, name))
    ) {
      return undefined;
    }
    const propertySchema = properties[name];
    const value = current?.[name];
    const cell = isCellHandle(value)
      ? value
      : propertySchema === undefined
      ? root.key(name)
      : root.key(name).asSchema(propertySchema);
    return cellResource(cell, propertySchema ?? cell.ref().schema);
  };

  return new Proxy<Record<string, BridgeResource>>({}, {
    get: (_target, key) => typeof key === "string" ? resource(key) : undefined,
    ownKeys: () => [...names()],
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === "string" && names().has(key)
        ? { configurable: true, enumerable: true }
        : undefined,
  });
}

/** Builds the convenience bridge used by `cf-iframe`'s `context` property. */
export function createCellContextBridge(context: object): FabricBridge {
  if (isCellHandle(context)) {
    return createFabricBridge(
      cellContextResources(
        context as CellHandle<Record<string, unknown>>,
      ),
    );
  }

  const current = context as Record<string, unknown>;
  const resources: Record<string, BridgeResource> = {};
  for (const name of Object.keys(current)) {
    resources[name] = localResource(current, name);
  }
  return createFabricBridge(resources);
}

/** Resolves every named child of a bound context into one concrete resource. */
export async function resolveCellContextBridge(
  context: CellHandle<Record<string, unknown>>,
  resourceKinds: Readonly<Record<string, CellContextResourceKind>> = {},
): Promise<FabricBridge> {
  await context.sync();
  const sourceCurrent = context.get();
  const root = await context.resolveAsCell();
  await root.sync();
  const resolvedCurrent = root.get();
  const properties = schemaProperties(root.ref().schema);
  const names = new Set([
    ...Object.keys(properties),
    ...(sourceCurrent && typeof sourceCurrent === "object"
      ? Object.keys(sourceCurrent)
      : []),
    ...(resolvedCurrent && typeof resolvedCurrent === "object"
      ? Object.keys(resolvedCurrent)
      : []),
  ]);
  const entries = await Promise.all([...names].map(async (name) => {
    const source = context.key(name);
    const declaredKind = resourceKinds[name] ?? cellKind(properties[name]);
    if (declaredKind === "sqlite") {
      // Pull the source path, not only its resolved target. A scoped SQLite
      // factory can be lazy for this browser session; the source path retains
      // the producer edge that materializes its concrete handle. The resolved
      // target remains the capability authority exposed below.
      await source.pull();
    }
    const cell = await source.resolveAsCell();
    const resolvedSchema = cell.ref().schema;
    return [
      name,
      cellResource(cell, resolvedSchema, resourceKinds[name]),
    ] as const;
  }));
  return createFabricBridge(Object.fromEntries(entries));
}
