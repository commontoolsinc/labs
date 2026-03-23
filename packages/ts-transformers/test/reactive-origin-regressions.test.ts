import { assert } from "@std/assert";

import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";
import { batchTypeCheckFixtures, validateSource } from "./utils.ts";

Deno.test("reactive origin regressions: fetchData results still report opaque-get", async () => {
  const source = `/// <cts-enable />
import { fetchData } from "commontools";

const data = fetchData<string>({ url: "https://example.com", result: "" });
const value = data.get();

export { value };
`;

  const { diagnostics } = await validateSource(source, {
    types: COMMONTOOLS_TYPES,
  });

  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "opaque-get:invalid-call"
    ),
    `expected opaque-get:invalid-call, got ${
      diagnostics.map((diagnostic) => diagnostic.type).join(", ") || "none"
    }`,
  );
});

Deno.test("reactive origin regressions: CellLike still rejects primitive $value bindings", async () => {
  const fixturePath =
    "test/fixtures/jsx-expressions/celllike-bidirectional-literal.input.tsx";
  const source = `/// <cts-enable />
export default <ct-input $value="hello" />;
`;

  const { diagnosticsByFile } = await batchTypeCheckFixtures(
    { [fixturePath]: source },
    { types: COMMONTOOLS_TYPES },
  );
  const diagnostics = diagnosticsByFile.get(fixturePath) ?? [];

  assert(
    diagnostics.some((diagnostic) => diagnostic.code === 2322),
    `expected TS2322 for primitive $value binding, got ${
      diagnostics.map((diagnostic) => diagnostic.code).join(", ") || "none"
    }`,
  );
});
