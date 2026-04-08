import { assertEquals } from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { CFC_CANONICAL_ALIAS_NAMES } from "../src/cfc-authoring.ts";

Deno.test("ts-transformers re-exports the canonical CFC alias set", () => {
  assertEquals(CFC_CANONICAL_ALIAS_NAMES, [
    "Cfc",
    "Classified",
    "Integrity",
    "AddIntegrity",
    "RequiresIntegrity",
    "MaxConfidentiality",
    "OpaqueInput",
    "WriteAuthorizedBy",
    "ExactCopy",
    "ProjectionPath",
    "ProjectionOf",
    "Projection",
    "LengthPreservedFrom",
    "FilteredFrom",
    "SubsetOf",
    "PermutationOf",
  ]);
});

Deno.test("WriteAuthorizedBy accepts a local function binding", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    function localFunction() {}

    const functionSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof localFunction>
    >();

    export { functionSchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ),
    false,
  );
});

Deno.test(
  "WriteAuthorizedBy preserves the local binding identity through schema emission",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      function localFunction() {}

      const functionSchema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof localFunction>
      >();

      export { functionSchema };
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    assertEquals(
      output.includes("writeAuthorizedBy: localFunction as any"),
      true,
    );
  },
);

Deno.test("WriteAuthorizedBy rejects unsupported binding declarations", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    declare const missingInitializer: () => void;
    const invalidSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof missingInitializer>
    >();

    const invalidQuerySchema = toSchema<
      WriteAuthorizedBy<{ title: string }, string>
    >();

    export { invalidSchema, invalidQuerySchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ),
    true,
  );
});
