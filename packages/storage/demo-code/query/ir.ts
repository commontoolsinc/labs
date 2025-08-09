export type IRNode =
  | { kind: "True" }
  | { kind: "False" }
  | {
    kind: "TypeCheck";
    t: "object" | "array" | "string" | "number" | "boolean" | "null";
  }
  | { kind: "Const"; value: any }
  | { kind: "Enum"; values: any[] }
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
  get(id: IRId): IRNode {
    const n = this.map.get(id);
    if (!n) throw new Error(`Unknown IR ${id}`);
    return n;
  }
  set(id: IRId, node: IRNode) {
    this.map.set(id, node);
  }
  has(id: IRId) {
    return this.map.has(id);
  }
}

function isObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function stableHash(obj: any): string {
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

export function compileSchema(pool: IRPool, schema: JsonSchema): IRId {
  if (schema === true) return intern(pool, { kind: "True" });
  if (schema === false) return intern(pool, { kind: "False" });
  if (!isObject(schema)) return intern(pool, { kind: "True" });

  if (schema.const !== undefined) {
    return intern(pool, { kind: "Const", value: schema.const });
  }
  if (schema.enum) return intern(pool, { kind: "Enum", values: schema.enum });

  const nodes: IRId[] = [];
  if (schema.type && typeof schema.type === "string") {
    nodes.push(intern(pool, { kind: "TypeCheck", t: schema.type } as any));
  }
  if (schema.pattern) {
    nodes.push(
      intern(pool, { kind: "Pattern", re: new RegExp(schema.pattern) }),
    );
  }
  if (
    schema.minimum !== undefined || schema.maximum !== undefined ||
    schema.exclusiveMinimum || schema.exclusiveMaximum
  ) {
    nodes.push(
      intern(pool, {
        kind: "Range",
        min: schema.minimum,
        max: schema.maximum,
        exclMin: !!schema.exclusiveMinimum,
        exclMax: !!schema.exclusiveMaximum,
      }),
    );
  }

  if (
    schema.properties || schema.required ||
    schema.additionalProperties !== undefined
  ) {
    const required = new Set<string>(
      Array.isArray(schema.required) ? schema.required : [],
    );
    const props = new Map<string, IRId>();
    if (schema.properties) {
      for (const [k, v] of Object.entries(schema.properties)) {
        props.set(k, compileSchema(pool, v));
      }
    }
    let additional: AP = { mode: "omit" };
    if (Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
      if (schema.additionalProperties === true) additional = { mode: "true" };
      else if (schema.additionalProperties === false) {
        additional = { mode: "omit" };
      } else {additional = {
          mode: "schema",
          ir: compileSchema(pool, schema.additionalProperties),
        };}
    }
    nodes.push(intern(pool, { kind: "Props", required, props, additional }));
  }

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      nodes.push(
        intern(pool, {
          kind: "Items",
          tuple: schema.items.map((s: any) => compileSchema(pool, s)),
        }),
      );
    } else {nodes.push(
        intern(pool, {
          kind: "Items",
          item: compileSchema(pool, schema.items),
        }),
      );}
  }

  if (Array.isArray(schema.allOf)) {
    nodes.push(intern(pool, {
      kind: "AllOf",
      nodes: schema.allOf.map((s: any) => compileSchema(pool, s)),
    }));
  }
  if (Array.isArray(schema.anyOf)) {
    nodes.push(intern(pool, {
      kind: "AnyOf",
      nodes: schema.anyOf.map((s: any) => compileSchema(pool, s)),
    }));
  }

  if (nodes.length === 0) return intern(pool, { kind: "True" });
  if (nodes.length === 1) return nodes[0];
  return intern(pool, { kind: "AllOf", nodes });
}
