import { assertEquals, assertStringIncludes } from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function normalizeOutput(output: string): string {
  return output.replace(/\s+/g, " ");
}

Deno.test("transformer coverage: nested aliases expand to canonical metadata", async () => {
  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
    type Classified<T, X extends readonly string[]> = Cfc<T, { classification: X }>;
    type SecretText<T> = Classified<T, readonly ["secret"]>;

    interface SchemaRoot {
      secret: SecretText<{ value: string }>;
    }

    const schema = toSchema<SchemaRoot>();
    export default schema;
  `;

  const output = normalizeOutput(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );

  assertStringIncludes(output, "classification: [");
  assertStringIncludes(output, '"secret"');
  assertStringIncludes(output, 'value: { type: "string" }');
});

Deno.test("transformer coverage: projection paths lower as canonical pointers", async () => {
  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
    type ProjectionPath<T, From extends string, Path extends readonly string[]> = Cfc<T, { projection: { from: From; path: Path } }>;
    type ProjectionOf<Root, PathTuple extends readonly string[]> = ProjectionPath<Root, "/", PathTuple>;

    interface SchemaRoot {
      projection: ProjectionOf<{ title: string }, readonly ["nested", "path"]>;
    }

    const schema = toSchema<SchemaRoot>();
    export default schema;
  `;

  const output = normalizeOutput(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );

  assertStringIncludes(
    output,
    'projection: { from: "/", path: "/nested/path" }',
  );
  assertStringIncludes(output, 'title: { type: "string" }');
});

Deno.test("transformer coverage: opaque inputs lower to ifc.opaque", async () => {
  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
    type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = Cfc<T, { opaque: Spec }>;

    interface SecretPayload {
      token: OpaqueInput<string>;
    }

    const schema = toSchema<SecretPayload>();
    export default schema;
  `;

  const output = normalizeOutput(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );

  assertStringIncludes(output, "ifc: { opaque: true }");
  assertStringIncludes(output, 'token: { type: "string"');
});

Deno.test("transformer coverage: UI helpers rewrite to intrinsic tags and data-ui markers", async () => {
  const source = `/// <cts-enable />
    import { UiAction } from "commonfabric";

    export default () => (
      <UiAction action="SubmitDirectCommand">Go</UiAction>
    );
  `;

  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertStringIncludes(
    output,
    '<ct-button data-ui-action="SubmitDirectCommand">Go</ct-button>',
  );
  assertEquals(output.includes("<UiAction"), false);
});

Deno.test("transformer coverage: WriteAuthorizedBy emits diagnostics for invalid forms", async () => {
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
