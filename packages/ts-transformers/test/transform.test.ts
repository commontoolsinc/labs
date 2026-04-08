import { describe, it } from "@std/testing/bdd";
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { transformFiles } from "./utils.ts";

const fixture = `
import { toSchema } from "commonfabric";

interface Config {
  value: number;
}

const configSchema = toSchema<Config>({
  default: { value: 42 },
  description: "Configuration schema"
});
export { configSchema };
`;

describe("CommonFabricTransformerPipeline", () => {
  it("Filters transformations if <cts-enabled /> not provided", async () => {
    const disabled = await transformFiles({
      "/main.ts": fixture,
    });
    assert(
      !/import \{\s*__ctHelpers\s+as\s+__cfHelpers\s*\} from "commonfabric";/
        .test(disabled["/main.ts"]!),
      "no replacements without <cts-enable />",
    );
    const enabled = await transformFiles({
      "/main.ts": `/// <cts-enable />\n` + fixture,
    });
    assert(
      /import \{\s*__ctHelpers\s+as\s+__cfHelpers\s*\} from "commonfabric";/
        .test(enabled["/main.ts"]!),
      "no replacements without <cts-enable />",
    );
  });

  it("wraps top-level data candidates with __cfHelpers.__ct_data", async () => {
    const source = `/// <cts-enable />
import { lift, schema } from "commonfabric";

function buildYears() {
  return Array.from({ length: 3 }, (_, index) => String(index + 1));
}

const model = schema({ type: "string" } as const);
const lookup = (() => ({ open: "Open" }))();
const days = Array.from({ length: 3 }, (_, index) => String(index + 1));
const matcher = /^[a-z]+$/;
const scopeMap = { gmail: "gmail.readonly" } as const;
const scopes = Object.fromEntries(
  Object.entries(scopeMap).map(([key, value]) => [key, { value }]),
);
const years = buildYears();
const tags = new Set(["a", "b"]);
const proxied = new Proxy({ open: "Open" }, {});
const passthrough = lift((value: string) => value);

export { model, lookup, days, matcher, scopes, years, tags, proxied, passthrough };
`;

    const output = await transformFiles({
      "/main.ts": source,
    });
    const main = output["/main.ts"]!;

    assertStringIncludes(
      main,
      'const model = __cfHelpers.__ct_data(schema({ type: "string" } as const));',
    );
    assertStringIncludes(
      main,
      'const lookup = __cfHelpers.__ct_data((() => ({ open: "Open" }))());',
    );
    assertStringIncludes(
      main,
      "const days = __cfHelpers.__ct_data(Array.from({ length: 3 }, (_, index) => String(index + 1)));",
    );
    assertStringIncludes(
      main,
      "const matcher = __cfHelpers.__ct_data(/^[a-z]+$/);",
    );
    assertStringIncludes(
      main,
      "const scopes = __cfHelpers.__ct_data(Object.fromEntries(",
    );
    assertStringIncludes(
      main,
      "const years = __cfHelpers.__ct_data(buildYears());",
    );
    assertStringIncludes(
      main,
      'const tags = __cfHelpers.__ct_data(new Set(["a", "b"]));',
    );
    assert(
      !main.includes('__cfHelpers.__ct_data(new Proxy({ open: "Open" }, {}));'),
      "Proxy snapshots stay unsupported until Proxy is re-enabled in SES compartments",
    );
    assert(
      !main.includes("__cfHelpers.__ct_data(lift("),
      "top-level builder calls should not be wrapped",
    );
  });

  it("hardens direct top-level functions with a canonical helper", async () => {
    const source = `
const step = (value: number) => value + 1;
export default function next(value: number) {
  return step(value);
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    });
    const main = output["/main.ts"]!;

    assertStringIncludes(main, "function __cfHardenFn");
    assertStringIncludes(
      main,
      "const step = __cfHardenFn((value: number) => value + 1);",
    );
    assertStringIncludes(main, "__cfHardenFn(next);");
  });

  it("wraps explicit snapshot helpers with __cfHelpers.__ct_data", async () => {
    const source = `/// <cts-enable />
import { nonPrivateRandom, safeDateNow } from "commonfabric";

const startedAt = safeDateNow();
const seed = nonPrivateRandom();

export default function probe() {
  return [safeDateNow(), nonPrivateRandom(), startedAt, seed];
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    });
    const main = output["/main.ts"]!;

    assertStringIncludes(
      main,
      "const startedAt = __cfHelpers.__ct_data(safeDateNow());",
    );
    assertStringIncludes(
      main,
      "const seed = __cfHelpers.__ct_data(nonPrivateRandom());",
    );
    assert(
      !main.includes("__cfHelpers.safeDateNow"),
      "explicit helper calls should not be rewritten",
    );
    assert(
      !main.includes("__cfHelpers.nonPrivateRandom"),
      "explicit helper calls should not be rewritten",
    );
  });

  it("injects __cfDataHelper on demand for non-CTS top-level snapshots", async () => {
    const output = await transformFiles({
      "/main.ts": `
function pow(x: number): number {
  return x * x;
}

export default pow(5);
`,
    });

    const main = output["/main.ts"]!;

    assertStringIncludes(
      main,
      'import { __ct_data as __cfDataHelper } from "commonfabric";',
    );
    assertStringIncludes(
      main,
      "export default __cfDataHelper(pow(5));",
    );
  });
});

describe("CFHelpers handling", () => {
  it("Throws if __cfHelpers variable is used in source", async () => {
    const statements = [
      "function __cfHelpers() {}",
      "function foo(): number { var __cfHelpers = 5; return __cfHelpers; }",
      "var __cfHelpers: number = 5;",
      "declare global { var __cfHelpers: any; }\nglobalThis.__cfHelpers = 5;",
    ];

    for (const statement of statements) {
      await assertRejects(() =>
        transformFiles({
          "/main.ts": fixture + `\n${statement}`,
        })
      );
    }
  });

  it("Allows '__cfHelpers' in comments and in other forms", async () => {
    const statements = [
      "var x = 5; // __cfHelpers",
      "// __cfHelpers",
      "/* __cfHelpers */",
      "var __cfHelpers123: number = 5;",
      "declare global {\nvar __cfHelpers1: any;\n}\nglobalThis.__cfHelpers1 = 5;",
    ];
    for (const statement of statements) {
      await transformFiles({
        "/main.ts": fixture + `\n${statement}`,
      });
    }
  });
});
