import {
  assertEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  inferLabels,
  generateConstraints,
  type State,
  $label,
  type Node,
  makeLattice,
  join,
  meet,
  TOP,
  BOTTOM,
} from "./ifc.ts";

Deno.test("meet and join", () => {
  const lattice = makeLattice({
    public: ["trusted cloud"],
    "trusted cloud": ["cc", "openai", "anthropic"],
    cc: ["ondevice"],
  });

  assertEquals(meet(["public", "trusted cloud"], lattice), "public");
  assertEquals(meet(["trusted cloud", "cc"], lattice), "trusted cloud");
  assertEquals(meet(["cc", "ondevice"], lattice), "cc");
  assertEquals(meet(["public", "ondevice"], lattice), "public");

  assertEquals(join(["public", "trusted cloud"], lattice), "trusted cloud");
  assertEquals(join(["trusted cloud", "cc"], lattice), "cc");

  assertEquals(meet(["openai", "anthropic"], lattice), "trusted cloud");
  assertEquals(join(["openai", "anthropic"], lattice), TOP);

  // Google is not in the lattice
  assertEquals(meet(["public", "google"], lattice), BOTTOM);
  assertEquals(join(["public", "google"], lattice), TOP);
});

Deno.test("meet and join with type variables", () => {
  const lattice = makeLattice({
    public: ["trusted cloud"],
    "trusted cloud": ["cc", "openai", "anthropic"],
    cc: ["ondevice"],
  });

  assertEquals(meet(["$foo", "trusted cloud"], lattice), [
    "meet",
    ["$foo", "trusted cloud"],
  ]);

  assertEquals(meet(["$foo", "$bar"], lattice), ["meet", ["$foo", "$bar"]]);

  assertEquals(meet(["$foo", "public", "trusted cloud"], lattice), [
    "meet",
    ["$foo", "public"],
  ]);

  assertEquals(join(["$foo", "$foo"], lattice), ["join", ["$foo"]]);
});

Deno.test("generate constraints", () => {
  const initialState: State = {
    bar: {
      baz: {
        [$label]: {
          integrity: "trusted cloud",
          confidentiality: "trusted cloud",
        },
      },
      zab: {
        [$label]: { integrity: "public", confidentiality: "public" },
      },
    },
  };
  const bindings: Node[] = [{ in: ["bar.baz", "bar.zab"], out: ["foo"] }];

  const constraints = generateConstraints(initialState, bindings);

  assertEquals(constraints, [
    ["$bar.baz-integrity", "trusted cloud"],
    ["$bar.baz-confidentiality", "trusted cloud"],
    ["$bar.zab-integrity", "public"],
    ["$bar.zab-confidentiality", "public"],
    [
      "$foo-integrity",
      ["meet", ["$foo-integrity", "$bar.baz-integrity", "$bar.zab-integrity"]],
    ],
    [
      "$foo-confidentiality",
      [
        "join",
        [
          "$foo-confidentiality",
          "$bar.baz-confidentiality",
          "$bar.zab-confidentiality",
        ],
      ],
    ],
    ["$bar.baz-integrity", ["join", ["$bar.baz-integrity", "$foo-integrity"]]],
    [
      "$bar.baz-confidentiality",
      ["meet", ["$bar.baz-confidentiality", "$foo-confidentiality"]],
    ],
    ["$bar.zab-integrity", ["join", ["$bar.zab-integrity", "$foo-integrity"]]],
    [
      "$bar.zab-confidentiality",
      ["meet", ["$bar.zab-confidentiality", "$foo-confidentiality"]],
    ],
  ]);
});

Deno.test("infer labels, simple", () => {
  // Example lattice: Each line is a principal, listing its parents
  const lattice = makeLattice({
    public: ["trusted cloud"],
    "trusted cloud": ["cc", "openai", "anthropic"],
    cc: ["ondevice"],
    "possible prompt injection": ["user authored"],
  });

  // Example inputs to the recipe, with labels at any level in the tree
  const inputs = {
    bar: {
      baz: {
        [$label]: {
          integrity: "user authored",
          confidentiality: "trusted cloud",
        },
      },
      zab: {
        [$label]: {
          integrity: "possible prompt injection",
          confidentiality: "public",
        },
      },
    },
  };

  // The recipe
  const bindings = [{ type: "foo", in: ["bar.baz", "bar.zab"], out: ["foo"] }];

  const inferredLabels = inferLabels(inputs, bindings, lattice);
  console.log(inferredLabels);

  assertObjectMatch(inferredLabels, {
    foo: {
      [$label]: {
        integrity: "possible prompt injection",
        confidentiality: "trusted cloud",
      },
    },
  });
});

Deno.test("infer labels, two nodes", () => {
  // Example state and bindings
  const inputs: State = {
    bar: {
      baz: {
        [$label]: {
          integrity: "trusted cloud",
          confidentiality: "trusted cloud",
        },
      },
      zab: {
        [$label]: { integrity: "public", confidentiality: "public" },
      },
    },
  };
  const bindings: Node[] = [
    { in: ["bar.baz", "bar.zab"], out: ["foo"] },
    { in: ["foo", "bar.zab"], out: ["zab"] },
  ];

  const lattice = makeLattice({
    public: ["trusted cloud"],
    "trusted cloud": ["cc", "openai", "anthropic"],
    cc: ["ondevice"],
  });

  const inferredState = inferLabels(inputs, bindings, lattice);

  console.log(inferredState);
  assertEquals(inferredState, {
    bar: {
      baz: {
        [$label]: {
          integrity: "trusted cloud",
          confidentiality: "trusted cloud",
        },
      },
      zab: {
        [$label]: { integrity: "public", confidentiality: "public" },
      },
    },
    foo: {
      [$label]: { integrity: "public", confidentiality: "trusted cloud" },
    },
  });
});
