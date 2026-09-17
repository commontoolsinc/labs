import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callSchemas, parseModule } from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";

// A builder's input schema is shrunk to the paths the capability analysis
// observes the body reading. A value the body hands on whole — returned
// inside a fresh array, projected into an object literal, passed to a callee
// the analysis has no summary for — is read wherever it lands, by members the
// analysis never sees. Such a value keeps its declared shape, and a member the
// body did read on the way must not narrow it to that member. A value the
// analysis keeps following — through a local alias, a local object literal,
// or a runtime call that binds its arguments by reference — narrows as its
// reads say.
//
// The whole pipeline is the harness, because a dropped member is invisible
// before schema injection writes the shrunk schema into the emitted
// `lift(...)` call, and it is that emitted schema the runtime reads by.

/**
 * The input schema emitted for a `lift` reading `{ index }`, where `body` is
 * its whole body expression and `result` its declared result type.
 */
async function liftInputSchema(
  body: string,
  result = "unknown",
): Promise<Record<string, unknown>> {
  const output = await transformSource(
    `import { lift } from "commonfabric";

type Source = { id: string; driver: string };
type Index = { sources: Array<Source | undefined> };

declare function driverOf(s: Source): string;

declare class Box {
  constructor(row: Source | undefined);
  readonly row: Source | undefined;
}

const label = lift((r: { row: Source | undefined }): string => r.row?.id ?? "");

const keep = lift(({ index }: { index: Index }): ${result} => ${body});

export default { keep, label };
`,
    { types: COMMONFABRIC_TYPES },
  );
  const schema = callSchemas(parseModule(output), "lift")[0];
  if (!schema) throw new Error("No emitted `lift(cb, input, result)` schema");
  return schema;
}

/**
 * The state schema emitted for a `handler` whose state is
 * `{ index, out, relay }`, where `body` is the handler's whole block body.
 */
async function handlerStateSchema(
  body: string,
): Promise<Record<string, unknown>> {
  const output = await transformSource(
    `import { handler, type Stream, Writable } from "commonfabric";

type Source = { id: string; driver: string };
type Index = { sources: Array<Source | undefined> };

const keep = handler<
  void,
  {
    index: Index;
    out: Writable<{ row?: Source }>;
    relay: Stream<Source>;
  }
>((_, { index, out, relay }) => ${body});

export default { keep };
`,
    { types: COMMONFABRIC_TYPES },
  );
  const state = callSchemas(parseModule(output), "handler").find((schema) =>
    Object.hasOwn((schema.properties ?? {}) as Record<string, unknown>, "index")
  );
  if (!state) throw new Error("No emitted handler state schema");
  return state;
}

/**
 * The property names of the `Source` element schema under `index.sources`,
 * sorted. A shrunk element is emitted inline; a whole one as a `$ref` into
 * the schema's `$defs`, which this resolves.
 */
function elementPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties as Record<string, unknown>;
  const index = properties.index as { properties: Record<string, unknown> };
  const sources = index.properties.sources as { items: unknown };
  const branches = (sources.items as { anyOf?: unknown[] }).anyOf ??
    [sources.items];
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  for (const branch of branches) {
    const resolved = typeof (branch as { $ref?: string }).$ref === "string"
      ? defs[(branch as { $ref: string }).$ref.replace("#/$defs/", "")]
      : branch;
    const element = resolved as { type?: unknown; properties?: unknown };
    if (element.type === "object" && element.properties !== undefined) {
      return Object.keys(element.properties as Record<string, unknown>).sort();
    }
  }
  throw new Error("No object branch in the element schema");
}

const WHOLE = ["driver", "id"];

describe("capability-analysis-whole-value-escapes", () => {
  describe("an element kept whole after a member read inside the callback", () => {
    it("keeps every element property when `flatMap` returns the element in an array", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => s?.id ? [s] : [])`,
        "Source[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when `flatMap` returns the element bare through a conditional", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => s?.id ? s : [])`,
        "Source[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when the kept elements are read after the callback", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => s?.id ? [s] : []).map((s) => s.driver)`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when `map` projects a member beside the element", async () => {
      const schema = await liftInputSchema(
        `index.sources.map((s) => ({ raw: s, label: s?.id ?? "" }))`,
        "Array<{ raw: Source | undefined; label: string }>",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when a local built from the element is returned", async () => {
      const schema = await liftInputSchema(
        `index.sources.map((s) => {
          const k = { raw: s, label: s?.id ?? "" };
          return k;
        })`,
        "Array<{ raw: Source | undefined; label: string }>",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when `&&` forwards the element out of the callback", async () => {
      const schema = await liftInputSchema(
        `index.sources.map((s) => s?.id && s).map((s) => s ? s.driver : "")`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when the element sits in a literal alias resolution cannot model", async () => {
      const schema = await liftInputSchema(
        `index.sources.map((s) => {
          const k = { ...{ note: "n" }, row: s };
          return s?.id ? k.row?.driver ?? "" : "";
        })`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when the element is assigned to something other than a local", async () => {
      const schema = await liftInputSchema(
        `index.sources.map((s) => {
          const holder: { row?: Source } = {};
          holder.row = s;
          return s?.id ? holder.row?.driver ?? "" : "";
        })`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when the element is a constructor argument", async () => {
      const schema = await liftInputSchema(
        `index.sources.map((s) => s?.id ? new Box(s).row?.driver ?? "" : "")`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when a local array the body filled leaves whole", async () => {
      const schema = await liftInputSchema(
        `{
          const kept: Source[] = [];
          for (const s of index.sources) if (s?.id) kept.push(s);
          return [kept].flat().map((s) => s.driver);
        }`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });

    it("keeps every element property when the element reaches a function with no body to analyze", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => s?.id ? [driverOf(s)] : [])`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(WHOLE);
    });
  });

  describe("a value the analysis keeps following", () => {
    it("narrows to the member read through a local alias", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => {
          const x = s;
          return x?.id ? [x.id] : [];
        })`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read through a local the element is assigned to", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => {
          let x: Source | undefined;
          x = s;
          return x?.id ? [x.id] : [];
        })`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read through a local object literal", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) => {
          const k = { row: s };
          return k.row?.id ? [k.row.id] : [];
        })`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read when the builder itself returns the value whole", async () => {
      // A proxy in a builder's result is written as a link, so what the
      // consumer reads through it is decided by the consumer's own schema.
      const schema = await liftInputSchema(
        `{
          const { sources } = index;
          return sources.some((s) => !!s?.id) ? sources : [];
        }`,
        "Array<Source | undefined>",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read when the value is only asked its shape", async () => {
      const schema = await liftInputSchema(
        `{
          const { sources } = index;
          if (!Array.isArray(sources)) return [];
          return sources.flatMap((s) => s?.id ? [s.id] : []);
        }`,
        "string[]",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read when the element is written through a cell", async () => {
      // A write stores a proxy in its payload as a link, the way a result
      // does, whether the payload is the element or a literal holding it.
      const schema = await handlerStateSchema(
        `{
          const first = index.sources.find((s) => !!s?.id);
          if (first?.id) out.set({ row: first });
        }`,
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read when the element is sent on a stream", async () => {
      const schema = await handlerStateSchema(
        `{
          const first = index.sources.find((s) => !!s?.id);
          if (first?.id) relay.send(first);
        }`,
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read when the element is a prop of a returned node", async () => {
      const schema = await liftInputSchema(
        `index.sources.flatMap((s) =>
          s?.id ? [<cf-cfc-authorship author={s}>{s.id}</cf-cfc-authorship>] : []
        )`,
        "unknown[]",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });

    it("narrows to the member read when the element is handed to an applied lift", async () => {
      // A lift applied inside the body binds its inputs by reference, and
      // reads through that link under a schema of its own.
      const schema = await liftInputSchema(
        `index.sources.map((s) => s?.id ? label({ row: s }) : "")`,
        "unknown[]",
      );
      expect(elementPropertyNames(schema)).toEqual(["id"]);
    });
  });
});
