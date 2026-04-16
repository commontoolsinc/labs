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
    type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
    type SecretText<T> = Confidential<T, readonly ["secret"]>;

    interface SchemaRoot {
      secret: SecretText<{ value: string }>;
    }

    const schema = toSchema<SchemaRoot>();
    export default schema;
  `;

  const output = normalizeOutput(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );

  assertStringIncludes(output, "confidentiality: [");
  assertStringIncludes(output, '"secret"');
  assertStringIncludes(output, 'value: { type: "string" }');
});

Deno.test("transformer coverage: projection paths lower as canonical pointers", async () => {
  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
    type ProjectionPath<T, From extends string, Path extends readonly unknown[]> = Cfc<T, { projection: { from: From; path: Path } }>;
    type ProjectionOf<Root, PathTuple extends readonly unknown[]> = ProjectionPath<Root, "/", PathTuple>;

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

Deno.test("transformer coverage: imported Cfc metadata survives Writable.of type arguments", async () => {
  const source = `/// <cts-enable />
    import { type Cfc, Writable } from "commonfabric";

    type AuthorshipIntegrity<Author extends string> = {
      readonly kind: "authored-by";
      readonly subject: Author;
    };

    type AuthoredMessageBody<Author extends string> = Cfc<
      string,
      { integrity: readonly [AuthorshipIntegrity<Author>] }
    >;

    const body = Writable.of<AuthoredMessageBody<"alice">>(
      "Verified text" as AuthoredMessageBody<"alice">,
    );

    export default body;
  `;

  const output = normalizeOutput(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );

  assertStringIncludes(output, 'type: "string"');
  assertStringIncludes(
    output,
    'ifc: { integrity: [{ kind: "authored-by", subject: "alice" }] }',
  );
  assertEquals(output.includes("Unsupported intersection pattern"), false);
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
