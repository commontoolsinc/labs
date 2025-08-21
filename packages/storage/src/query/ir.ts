export type IRNode =
  | { kind: "True" }
  | { kind: "False" }
  | {
    kind: "TypeCheck";
    t: "object" | "array" | "string" | "number" | "boolean" | "null";
  }
  | { kind: "Const"; value: unknown }
  | { kind: "Enum"; values: unknown[] }
  | {
    kind: "Range";
    min?: number;
    max?: number;
    exclMin?: boolean;
    exclMax?: boolean;
  }
  | { kind: "Pattern"; re: RegExp }
  | {
    kind: "Props";
    required: Set<string>;
    props: Map<string, IRId>;
    additional: AP;
  }
  | { kind: "Items"; tuple?: IRId[]; item?: IRId }
  | { kind: "AllOf"; nodes: IRId[] }
  | { kind: "AnyOf"; nodes: IRId[] };

export type AP = { mode: "omit" } | { mode: "true" } | {
  mode: "schema";
  ir: IRId;
};
export type IRId = string;
export class IRPool {
  private map = new Map<IRId, IRNode>();
  private aliases = new Map<IRId, IRId>();
  private resolve(id: IRId): IRId {
    let cur = id;
    const seen = new Set<IRId>();
    while (this.aliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.aliases.get(cur)!;
    }
    return cur;
  }
  get(id: IRId): IRNode {
    const real = this.resolve(id);
    const n = this.map.get(real);
    if (!n) throw new Error(`Unknown IR ${id}`);
    return n;
  }
  set(id: IRId, node: IRNode) {
    this.map.set(id, node);
  }
  has(id: IRId) {
    return this.map.has(this.resolve(id));
  }
  alias(from: IRId, to: IRId) {
    this.aliases.set(from, to);
  }
}

let __ir_local_id = 0;
function newLocalId(): IRId {
  __ir_local_id += 1;
  return `ir_local_${__ir_local_id}`;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function stableHash(obj: unknown): string {
  const s = JSON.stringify(obj, (_k, v) => {
    if (v instanceof RegExp) return { $re: v.source, $flags: v.flags };
    if (v instanceof Set) return { $set: [...v].sort() };
    if (v instanceof Map) {
      return {
        $map: [...v.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      };
    }
    return v;
  });
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `ir_${(h >>> 0).toString(16)}`;
}

export function intern(pool: IRPool, node: IRNode): IRId {
  const id = stableHash(node);
  if (!pool.has(id)) pool.set(id, node);
  return id;
}

export type JsonSchema = unknown;

import { toTokens } from "./path.ts";

type CompileCtx = { root: JsonSchema; memo: Map<unknown, IRId> };

export function compileSchema(
  pool: IRPool,
  schema: JsonSchema,
  ctx?: Partial<CompileCtx>,
): IRId {
  const root = ctx?.root ?? schema;
  const memo = ctx?.memo ?? new Map<unknown, IRId>();
  if (memo.has(schema)) return memo.get(schema)!;
  if (schema === true) {
    const id = intern(pool, { kind: "True" });
    memo.set(schema, id);
    return id;
  }
  if (schema === false) {
    const id = intern(pool, { kind: "False" });
    memo.set(schema, id);
    return id;
  }
  if (!isObject(schema)) {
    const id = intern(pool, { kind: "True" });
    memo.set(schema, id);
    return id;
  }
  const sch = schema as Record<string, unknown>;

  // $ref support (local-only): "#/definitions/Name" or "#/$defs/Name" etc.
  if (typeof sch.$ref === "string") {
    const ref = sch.$ref;
    if (!ref.startsWith("#")) {
      throw new Error(`Only local $ref supported: ${ref}`);
    }
    const ptr = ref.slice(1); // drop leading '#'
    const tokens = ptr === "" ? [] : toTokens(ptr);
    let target: unknown = root;
    for (const t of tokens) {
      if (t === "") continue;
      if (!isObject(target)) {
        target = undefined;
        break;
      }
      target = (target as Record<string, unknown>)[t];
    }
    if (target === undefined) throw new Error(`$ref not found: ${ref}`);
    const id = compileSchema(pool, target, { root, memo });
    memo.set(schema, id);
    return id;
  }

  // For object-like schemas we reserve a local id first to break self/mutual recursion cycles.
  const localId = newLocalId();
  memo.set(schema, localId);

  const usedIds: IRId[] = [];
  const pushId = (id: IRId) => {
    usedIds.push(id);
    return id;
  };

  const nodes: IRId[] = [];
  const typeVal = sch.type;
  const allowed = [
    "object",
    "array",
    "string",
    "number",
    "boolean",
    "null",
  ] as const;
  type Allowed = typeof allowed[number];
  if (
    typeof typeVal === "string" &&
    (allowed as readonly string[]).includes(typeVal)
  ) {
    nodes.push(
      pushId(intern(pool, { kind: "TypeCheck", t: typeVal as Allowed })),
    );
  }
  if (typeof sch.pattern === "string") {
    nodes.push(
      pushId(
        intern(pool, {
          kind: "Pattern",
          re: new RegExp(sch.pattern),
        }),
      ),
    );
  }
  if (Object.prototype.hasOwnProperty.call(sch, "const")) {
    nodes.push(pushId(intern(pool, { kind: "Const", value: sch["const"] })));
  }
  if (Array.isArray(sch.enum)) {
    nodes.push(
      pushId(intern(pool, { kind: "Enum", values: sch.enum as unknown[] })),
    );
  }
  if (
    sch.minimum !== undefined ||
    sch.maximum !== undefined ||
    sch.exclusiveMinimum || sch.exclusiveMaximum
  ) {
    const range: {
      kind: "Range";
      min?: number;
      max?: number;
      exclMin?: boolean;
      exclMax?: boolean;
    } = {
      kind: "Range",
      ...(typeof sch.minimum === "number" ? { min: sch.minimum } : {}),
      ...(typeof sch.maximum === "number" ? { max: sch.maximum } : {}),
      ...(sch.exclusiveMinimum ? { exclMin: true } : {}),
      ...(sch.exclusiveMaximum ? { exclMax: true } : {}),
    };
    nodes.push(pushId(intern(pool, range)));
  }

  if (
    sch.properties || sch.required || sch.additionalProperties !== undefined
  ) {
    const required = new Set<string>(
      Array.isArray(sch.required)
        ? (sch.required as unknown[]).filter((x): x is string =>
          typeof x === "string"
        )
        : [],
    );
    const props = new Map<string, IRId>();
    if (isObject(sch.properties)) {
      for (
        const [k, v] of Object.entries(
          sch.properties as Record<string, unknown>,
        )
      ) {
        props.set(k, pushId(compileSchema(pool, v, { root, memo })));
      }
    }
    let additional: AP = { mode: "omit" };
    if (Object.prototype.hasOwnProperty.call(sch, "additionalProperties")) {
      const ap = sch.additionalProperties as unknown;
      if (ap === true) {
        additional = { mode: "true" };
      } else if (ap === false) {
        additional = { mode: "omit" };
      } else {
        additional = {
          mode: "schema",
          ir: pushId(
            compileSchema(pool, ap as JsonSchema, {
              root,
              memo,
            }),
          ),
        };
      }
    }
    nodes.push(
      pushId(intern(pool, { kind: "Props", required, props, additional })),
    );
  }

  if (sch.items !== undefined) {
    if (Array.isArray(sch.items)) {
      nodes.push(
        pushId(intern(pool, {
          kind: "Items",
          tuple: (sch.items as unknown[]).map((s) =>
            compileSchema(pool, s, { root, memo })
          ),
        })),
      );
    } else {
      nodes.push(
        pushId(intern(pool, {
          kind: "Items",
          item: compileSchema(pool, sch.items as JsonSchema, { root, memo }),
        })),
      );
    }
  }

  if (Array.isArray(sch.allOf)) {
    nodes.push(pushId(intern(pool, {
      kind: "AllOf",
      nodes: (sch.allOf as unknown[]).map((s) =>
        compileSchema(pool, s, { root, memo })
      ),
    })));
  }
  if (Array.isArray(sch.anyOf)) {
    nodes.push(pushId(intern(pool, {
      kind: "AnyOf",
      nodes: (sch.anyOf as unknown[]).map((s) =>
        compileSchema(pool, s, { root, memo })
      ),
    })));
  }

  let resultId: IRId;
  if (nodes.length === 0) {
    resultId = intern(pool, { kind: "True" });
  } else if (nodes.length === 1) {
    resultId = nodes[0]!;
  } else {
    resultId = intern(pool, { kind: "AllOf", nodes });
  }

  // Always alias the provisional local id to the final node id so any early refs resolve.
  pool.alias(localId, resultId);
  memo.set(schema, resultId);
  return resultId;
}
