import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { labelResultSchema } from "../src/builtins/sqlite-builtins.ts";

type SqliteLabelTables = NonNullable<
  Parameters<typeof labelResultSchema>[1]
>;

type ResultColumnIfc = {
  readonly confidentiality?: readonly unknown[];
  readonly integrity?: readonly unknown[];
};

type ResultColumnSchema = {
  readonly ifc?: ResultColumnIfc;
};

type LabeledResultSchema = {
  readonly properties?: {
    readonly result?: {
      readonly items?: {
        readonly properties?: Readonly<Record<string, ResultColumnSchema>>;
      };
    };
  };
};

const resultColumnIfc = (
  schema: Record<string, unknown> | undefined,
  column: string,
): ResultColumnIfc | undefined => {
  const labeled = schema as LabeledResultSchema | undefined;
  return labeled?.properties?.result?.items?.properties?.[column]?.ifc;
};

// Regression guard for aggregate/null-origin column integrity (CT-1668 / W2.17).
//
// A null-origin result column (aggregate, expression, literal) inherited the
// runtime's mergeLabel union over every labeled db column — for confidentiality
// that is a sound over-approximation, but for INTEGRITY it over-claims: a
// COUNT(*) would claim an integrity atom held by a single column. §8.17.1
// requires a class-aware meet (never union) for integrity; with propagation
// classes still pending, the conservative result is empty integrity (an
// aggregate is a new computed value with no inherited evidence).
describe("CFC sqlite aggregate column integrity", () => {
  it("gives a null-origin column the confidentiality union but no integrity", () => {
    const tables = {
      notes: {
        properties: {
          body: {
            ifc: {
              confidentiality: ["secret-body"],
              integrity: ["trusted-body"],
            },
          },
        },
      },
    } satisfies SqliteLabelTables;
    const columns = [
      { output: "cnt", table: null, column: null },
    ] satisfies Parameters<typeof labelResultSchema>[0];

    const { schema } = labelResultSchema(columns, tables);
    const ifc = resultColumnIfc(schema, "cnt");

    expect(ifc).toBeDefined();
    expect(ifc?.confidentiality).toEqual(["secret-body"]);
    expect(ifc?.integrity ?? []).toEqual([]);
  });
});
