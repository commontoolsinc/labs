import { describe, it } from "@std/testing/bdd";
import {
  assert,
  assertNotMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { transformFiles } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

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
  it("adds stable variable causes to fresh reactive initializers", async () => {
    const source = `
import { cell, computed, Writable } from "commonfabric";

export function make() {
  const foo = Writable.of(1);
  const bar = computed(() => foo.get() + 1);
  const baz = cell(["a"]).map((value) => value.toUpperCase());
  const already = Writable.of(2).for("manual");
  return { already, bar, baz, foo };
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    assertStringIncludes(
      main,
      'const foo = Writable.of(1, {\n        type: "number"\n    } as const satisfies __cfHelpers.JSONSchema).for("foo", true);',
    );
    assertStringIncludes(main, '.for("bar", true);');
    assertStringIncludes(main, '.for("baz", true);');
    assert(!main.includes('.for("already", true)'));
  });

  it("adds stable property causes to pattern-owned lowered derives", async () => {
    const source = `
import { pattern } from "commonfabric";

export default pattern<{ count: number }, { doubled: number }>((state) => ({
  doubled: state.count * 2,
}));
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assertStringIncludes(main, "doubled: __cfHelpers.derive(");
    assertStringIncludes(main, '.for(["__patternResult", "doubled"], true)');
    assertNotMatch(main, /state\.key\("count"\)\.for/);
  });

  it("adds stable nested causes to pattern result cells", async () => {
    const source = `
import { pattern, Writable } from "commonfabric";

export default pattern<{ count: number }>((state) => ({
  foo: state.count * 2,
  nested: {
    bar: Writable.of("bar"),
  },
  tuple: [Writable.of("tuple")],
}));
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assertStringIncludes(main, '.for(["__patternResult", "foo"], true)');
    assertStringIncludes(
      main,
      '.for(["__patternResult", "nested", "bar"], true)',
    );
    assertStringIncludes(
      main,
      '.for(["__patternResult", "tuple", 0], true)',
    );
    assertNotMatch(main, /state\.key\("count"\)\.for/);
  });

  it("re-roots reactive identifier members in pattern results", async () => {
    const source = `
import { pattern, Writable } from "commonfabric";

export default pattern(() => {
  const foo = Writable.of(1);
  return {
    foo,
    explicit: foo,
  };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assertStringIncludes(main, '.for("foo", true);');
    assertStringIncludes(
      main,
      'foo: foo.for(["__patternResult", "foo"], true)',
    );
    assertStringIncludes(
      main,
      'explicit: foo.for(["__patternResult", "explicit"], true)',
    );
  });

  it("adds stable nested causes to constructed variable values", async () => {
    const source = `
import { computed, Writable } from "commonfabric";

declare function f(input: unknown): unknown;

export function make() {
  const foo = f({
    param: Writable.of(1),
    nested: {
      result: computed(() => 2),
    },
    tuple: [Writable.of("tuple")],
    already: Writable.of(3).for("manual"),
  });
  return foo;
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    assertStringIncludes(main, '.for(["foo", "param"], true)');
    assertStringIncludes(main, '.for(["foo", "nested", "result"], true)');
    assertStringIncludes(main, '.for(["foo", "tuple", 0], true)');
    assert(!main.includes('.for(["foo", "already"], true)'));
  });

  it("does not add positional cause segments for wrapped single object arguments", async () => {
    const source = `
import { Writable } from "commonfabric";

declare function f<T>(arg: T): T;

export function make() {
  const param = Writable.of(1);
  const foo = f(({ param }) as const);
  return foo;
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    assertStringIncludes(main, '.for(["foo", "param"], true)');
    assert(!main.includes('.for(["foo", 0, "param"], true)'));
  });

  it("does not duplicate stable causes on asserted reactive initializers", async () => {
    const source = `
import { Default, pattern } from "commonfabric";

interface Entry {
  id: string;
}

export default pattern<{ entries: Default<Entry[], []> }>(({ entries }) => {
  const tree = (entries || []) as Entry[];
  return { tree };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const treeCauseCount = main.match(/\.for\("tree", true\)/g)?.length ?? 0;
    assert(
      treeCauseCount === 1,
      `expected one tree cause, found ${treeCauseCount}`,
    );
  });

  it("does not add causes to plain array methods in lift callbacks", async () => {
    const source = `
import { lift } from "commonfabric";

interface Summary {
  label: string;
  count: number;
}

export const summarize = lift((summaries: Summary[]) => {
  const labels = summaries.map((summary) => summary.label);
  const active = summaries.filter((summary) => summary.count > 0);
  return {
    labels: summaries.map((summary) => summary.label),
    active,
    label: labels.join(", "),
  };
});
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    assert(!main.includes('.for("labels", true)'));
    assert(!main.includes('.for("active", true)'));
    assert(!main.includes('.for(["labels"], true)'));
  });

  it("does not add causes to plain array methods in lowered handler callbacks", async () => {
    const source = `
import { action, pattern, Stream } from "commonfabric";

const Child = pattern<{}, { deleteHandlers: Stream<void>[] }>(() => {
  return { deleteHandlers: [] as Stream<void>[] };
});

export default pattern(() => {
  const subject = Child({});
  const remove = action(() => {
    const handlers = subject.deleteHandlers.filter(() => true);
    handlers[0]?.send();
  });
  return { remove };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assert(!main.includes('.filter(() => true).for("handlers", true)'));
  });

  it("does not add causes to receiver calls in property access chains", async () => {
    const source = `
import { Default, pattern, wish, Writable } from "commonfabric";

type MentionablePiece = { name: string };
declare function make(input: unknown): { result: unknown };

export default pattern(() => {
  const mentionable =
    wish<Default<MentionablePiece[], []>>({ query: "#mentionable" }).result;
  const picked = make({ param: Writable.of(1) }).result;
  return { mentionable, picked };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assert(!main.includes('.for("mentionable", true).result'));
    assertStringIncludes(main, '.for(["picked", "param"], true)');
  });

  it("does not add root causes to pattern factory outputs", async () => {
    const source = `
import { pattern, Writable } from "commonfabric";

const Child = pattern<{ value: number }>(() => {
  return { value: Writable.of(1) };
});

export default pattern(() => {
  const child = Child({ value: Writable.of(2) });
  return { child };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assert(!main.includes('.for("child", true)'));
    assertStringIncludes(main, '.for(["child", "value"], true)');
  });

  it("does not re-root pattern factory identifiers in tool descriptors", async () => {
    const source = `
import { BuiltInLLMTool, pattern, patternTool } from "commonfabric";

export const searchWeb = pattern<{ query: string }, { results: string[] }>(
  ({ query }) => ({ results: [query] }),
);

export default pattern(() => {
  const tools: Record<string, BuiltInLLMTool> = {
    searchWeb: {
      pattern: searchWeb,
    },
    wrappedSearch: patternTool(searchWeb),
  };
  return { tools };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    assertStringIncludes(main, "pattern: searchWeb");
    assertStringIncludes(main, "wrappedSearch: patternTool(searchWeb)");
    assert(!main.includes("searchWeb.for("));
  });

  it("does not add shared property causes inside dynamic array callbacks", async () => {
    const source = `
import { lift, Writable } from "commonfabric";

export const build = lift((values: number[]) =>
  values.map((_value, index) => ({
    token: Writable.of(index),
  }))
);
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    assert(!main.includes('.for("token", true)'));
  });

  it("transforms by default and supports cf-disable-transform opt-out", async () => {
    const source = `
import { computed } from "commonfabric";

const value = computed(() => 1);
export { value };
`;

    const enabledByDefault = await transformFiles({
      "/main.ts": source,
    });
    assertStringIncludes(
      enabledByDefault["/main.ts"]!,
      "__cfHelpers.derive(",
    );

    const disabled = await transformFiles({
      "/main.ts": `/// <cf-disable-transform />\n${source}`,
    });

    assertStringIncludes(disabled["/main.ts"]!, "computed(() => 1)");
    assertNotMatch(disabled["/main.ts"]!, /__cfHelpers\.derive/);
  });

  it("wraps top-level data candidates with __cfHelpers.__cf_data", async () => {
    const source = `
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
      'const model = __cfHelpers.__cf_data(schema({ type: "string" } as const));',
    );
    assertStringIncludes(
      main,
      'const lookup = __cfHelpers.__cf_data((() => ({ open: "Open" }))());',
    );
    assertStringIncludes(
      main,
      "const days = __cfHelpers.__cf_data(Array.from({ length: 3 }, (_, index) => String(index + 1)));",
    );
    assertStringIncludes(
      main,
      "const matcher = __cfHelpers.__cf_data(/^[a-z]+$/);",
    );
    assertStringIncludes(
      main,
      "const scopes = __cfHelpers.__cf_data(Object.fromEntries(",
    );
    assertStringIncludes(
      main,
      "const years = __cfHelpers.__cf_data(buildYears());",
    );
    assertStringIncludes(
      main,
      'const tags = __cfHelpers.__cf_data(new Set(["a", "b"]));',
    );
    assert(
      !main.includes('__cfHelpers.__cf_data(new Proxy({ open: "Open" }, {}));'),
      "Proxy snapshots stay unsupported until Proxy is re-enabled in SES compartments",
    );
    assert(
      !main.includes("__cfHelpers.__cf_data(lift("),
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

  it("wraps explicit snapshot helpers with __cfHelpers.__cf_data", async () => {
    const source = `
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
      "const startedAt = __cfHelpers.__cf_data(safeDateNow());",
    );
    assertStringIncludes(
      main,
      "const seed = __cfHelpers.__cf_data(nonPrivateRandom());",
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

  it("skips snapshot wrapping when cf-disable-transform is present", async () => {
    const output = await transformFiles({
      "/main.ts": `/// <cf-disable-transform />
function pow(x: number): number {
  return x * x;
}

export default pow(5);
`,
    });

    const main = output["/main.ts"]!;

    assertStringIncludes(
      main,
      "export default pow(5);",
    );
    assertNotMatch(main, /__cfHelpers\.__ct_data/);
    assertNotMatch(main, /__cfDataHelper/);
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
