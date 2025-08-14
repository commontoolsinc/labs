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

export type JsonSchema = any;

import { toTokens } from "./path.ts";

type CompileCtx = { root: JsonSchema; memo: Map<any, IRId> };

export function compileSchema(
  pool: IRPool,
  schema: JsonSchema,
  ctx?: Partial<CompileCtx>,
): IRId {
  const root = ctx?.root ?? schema;
  const memo = ctx?.memo ?? new Map<any, IRId>();
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

  // $ref support (local-only): "#/definitions/Name" or "#/$defs/Name" etc.
  if (typeof (schema as any).$ref === "string") {
    const ref = (schema as any).$ref as string;
    if (!ref.startsWith("#")) {
      throw new Error(`Only local $ref supported: ${ref}`);
    }
    const ptr = ref.slice(1); // drop leading '#'
    const tokens = ptr === "" ? [] : toTokens(ptr);
    let target: any = root;
    for (const t of tokens) {
      if (t === "") continue;
      target = target?.[t];
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
  if ((schema as any).type && typeof (schema as any).type === "string") {
    nodes.push(
      pushId(
        intern(pool, { kind: "TypeCheck", t: (schema as any).type } as any),
      ),
    );
  }
  if ((schema as any).pattern) {
    nodes.push(
      pushId(
        intern(pool, {
          kind: "Pattern",
          re: new RegExp((schema as any).pattern),
        }),
      ),
    );
  }
  if ((schema as any).const !== undefined) {
    nodes.push(
      pushId(intern(pool, { kind: "Const", value: (schema as any).const })),
    );
  }
  if (Array.isArray((schema as any).enum)) {
    nodes.push(
      pushId(intern(pool, { kind: "Enum", values: (schema as any).enum })),
    );
  }
  if (
    (schema as any).minimum !== undefined ||
    (schema as any).maximum !== undefined ||
    (schema as any).exclusiveMinimum || (schema as any).exclusiveMaximum
  ) {
    nodes.push(
      pushId(intern(pool, {
        kind: "Range",
        min: (schema as any).minimum,
        max: (schema as any).maximum,
        exclMin: !!(schema as any).exclusiveMinimum,
        exclMax: !!(schema as any).exclusiveMaximum,
      })),
    );
  }

  if (
    (schema as any).properties || (schema as any).required ||
    (schema as any).additionalProperties !== undefined
  ) {
    const required = new Set<string>(
      Array.isArray((schema as any).required) ? (schema as any).required : [],
    );
    const props = new Map<string, IRId>();
    if ((schema as any).properties) {
      for (const [k, v] of Object.entries((schema as any).properties)) {
        props.set(k, pushId(compileSchema(pool, v, { root, memo })));
      }
    }
    let additional: AP = { mode: "omit" };
    if (Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
      if ((schema as any).additionalProperties === true) {
        additional = { mode: "true" };
      } else if ((schema as any).additionalProperties === false) {
        additional = { mode: "omit" };
      } else {
        additional = {
          mode: "schema",
          ir: pushId(
            compileSchema(pool, (schema as any).additionalProperties, {
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

  if ((schema as any).items !== undefined) {
    if (Array.isArray((schema as any).items)) {
      nodes.push(
        pushId(intern(pool, {
          kind: "Items",
          tuple: (schema as any).items.map((s: any) =>
            compileSchema(pool, s, { root, memo })
          ),
        })),
      );
    } else {
      nodes.push(
        pushId(intern(pool, {
          kind: "Items",
          item: compileSchema(pool, (schema as any).items, { root, memo }),
        })),
      );
    }
  }

  if (Array.isArray((schema as any).allOf)) {
    nodes.push(pushId(intern(pool, {
      kind: "AllOf",
      nodes: (schema as any).allOf.map((s: any) =>
        compileSchema(pool, s, { root, memo })
      ),
    })));
  }
  if (Array.isArray((schema as any).anyOf)) {
    nodes.push(pushId(intern(pool, {
      kind: "AnyOf",
      nodes: (schema as any).anyOf.map((s: any) =>
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
