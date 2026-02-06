import { assert } from "@std/assert";
import { transformSource } from "./utils.ts";

const COMMON_TOOLS_D_TS = `
export declare const CELL_BRAND: unique symbol;
export interface Cell<T> {
  [CELL_BRAND]: "cell";
}
export interface CellTypeConstructor<T> {
  of<U>(value: U): any;
  for<U>(cause: unknown): any;
}
export declare const Cell: CellTypeConstructor<any>;
export declare const OpaqueCell: CellTypeConstructor<any>;
export declare const Stream: CellTypeConstructor<any>;

export declare function wish<T>(query: string): T;
export declare function generateObject<T>(opts: any): T;
`;

const options = {
  types: { "commontools.d.ts": COMMON_TOOLS_D_TS },
};

Deno.test("Schema Injection - Cell.of", async () => {
  const code = `
    /// <cts-enable />
    import { Cell } from "commontools";
    const c1 = Cell.of<string>("hello");
    const c2 = Cell.of(123);
  `.trim();

  const result = await transformSource(code, options);
  const normalize = (s: string) => s.replace(/\s+/g, " ");

  assert(
    normalize(result).includes(
      'Cell.of<string>("hello", { type: "string" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
  assert(
    normalize(result).includes(
      'Cell.of(123, { type: "number" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
});

Deno.test("Schema Injection - Cell.for", async () => {
  const code = `
    /// <cts-enable />
    import { Cell } from "commontools";
    const c1 = Cell.for<string>("cause");
    const c2: Cell<number> = Cell.for("cause");
  `.trim();

  const result = await transformSource(code, options);
  const normalize = (s: string) => s.replace(/\s+/g, " ");

  assert(
    normalize(result).includes(
      'Cell.for<string>("cause").asSchema({ type: "string" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
  assert(
    normalize(result).includes(
      'Cell.for("cause").asSchema({ type: "number" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
});

Deno.test("Schema Injection - wish", async () => {
  const code = `
    /// <cts-enable />
    import { wish } from "commontools";
    const w1 = wish<string>({ query: "query" });
    const w2: string = wish({ query: "query" });
  `.trim();

  const result = await transformSource(code, options);
  const normalize = (s: string) => s.replace(/\s+/g, " ");

  assert(
    normalize(result).includes(
      'wish<string>({ query: "query" }, { type: "string" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
  assert(
    normalize(result).includes(
      'wish({ query: "query" }, { type: "string" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
});

Deno.test("Schema Injection - generateObject", async () => {
  const code = `
    /// <cts-enable />
    import { generateObject } from "commontools";
    const g1 = generateObject<string>({ model: "gpt-4" });
    const g2: { object: number } = generateObject({ model: "gpt-4" });
    const g3 = generateObject<string>({ model: "gpt-4", schema: { type: "string" } });
  `.trim();

  const result = await transformSource(code, options);
  const normalize = (s: string) => s.replace(/\s+/g, " ");

  assert(
    normalize(result).includes(
      'generateObject<string>({ model: "gpt-4", schema: { type: "string" } as const satisfies __ctHelpers.JSONSchema })',
    ),
  );
  assert(
    normalize(result).includes(
      'generateObject({ model: "gpt-4", schema: { type: "number" } as const satisfies __ctHelpers.JSONSchema })',
    ),
  );
  // Should not double inject
  assert(
    normalize(result).includes(
      'generateObject<string>({ model: "gpt-4", schema: { type: "string" } })',
    ),
  );
  assert(
    !normalize(result).includes(
      'schema: { type: "string" }, schema: { type: "string" }',
    ),
  );
});

Deno.test("Schema Injection - Cell-like classes", async () => {
  const code = `
    /// <cts-enable />
    import { OpaqueCell, Stream } from "commontools";
    const o1 = OpaqueCell.of<boolean>(true);
    const s1 = Stream.of<number>(1);
  `.trim();

  const result = await transformSource(code, options);
  const normalize = (s: string) => s.replace(/\s+/g, " ");

  assert(
    normalize(result).includes(
      'OpaqueCell.of<boolean>(true, { type: "boolean" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
  assert(
    normalize(result).includes(
      'Stream.of<number>(1, { type: "number" } as const satisfies __ctHelpers.JSONSchema)',
    ),
  );
});
