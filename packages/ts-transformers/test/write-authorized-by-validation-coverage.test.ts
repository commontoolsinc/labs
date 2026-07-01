import { assert, assertEquals } from "@std/assert";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

/**
 * Exercises the branches of the WriteAuthorizedBy validation transformer that
 * the existing cfc-authoring tests do not reach: property-access `toSchema`
 * call sites, non-identifier `typeof` bindings, recursion guards while walking
 * local type declarations, index-signature traversal, the generic type-argument
 * substitution over array/union/intersection/operator/parenthesized shapes, and
 * the initializer-unwrapping loop that sees through parentheses and assertions.
 */

async function cfcDiagnostics(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(source, {
    mode: "error",
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === "cfc-write-authorized-by"
  );
}

Deno.test(
  "property-access toSchema call site is validated for WriteAuthorizedBy",
  async () => {
    const source = `/// <cts-enable />
      import { WriteAuthorizedBy } from "commonfabric";

      declare const ns: { toSchema<T>(): unknown };
      const arbitrary = 123;

      const schema = ns.toSchema<
        WriteAuthorizedBy<{ title: string }, typeof arbitrary>
      >();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(
      diagnostics[0]!.message.includes(
        "local handler(), module(), requireEventIntegrity()",
      ),
    );
  },
);

Deno.test(
  "typeof of a qualified name reports the simple-identifier requirement",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const container = { saver() {} };

      const schema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof container.saver>
      >();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(diagnostics[0]!.message.includes("simple identifier binding"));
  },
);

Deno.test(
  "index-signature members of a referenced interface are traversed for bindings",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      interface Bag {
        [key: string]: WriteAuthorizedBy<{ title: string }, typeof arbitrary>;
      }

      const schema = toSchema<Bag>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
    assert(
      diagnostics[0]!.message.includes(
        "local handler(), module(), requireEventIntegrity()",
      ),
    );
  },
);

Deno.test(
  "self-referential type alias terminates and still reports the binding error",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Recursive = {
        self?: Recursive;
        write: WriteAuthorizedBy<{ title: string }, typeof arbitrary>;
      };

      const schema = toSchema<Recursive>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

// The following cases place the generic alias parameter *inside* the schema
// type argument of WriteAuthorizedBy, wrapped in a distinct type shape. When the
// validator substitutes the actual type into the alias parameter, it must
// descend through that shape to rebuild the WriteAuthorizedBy reference. Each
// case pins one branch of the substitution walker (array, union, intersection,
// type operator, parenthesized, index signature) and asserts the binding is
// still validated afterward.

Deno.test(
  "generic alias substitutes schema through array element types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<T[], typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through union and parenthesized types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<(T | undefined), typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through intersection types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<T & { tag: string }, typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through readonly type-operator types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<readonly T[], typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema through index-signature member types",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<{ [key: string]: T }, typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "generic alias substitutes schema literals with non-property members",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      const arbitrary = 123;

      type Wrap<T> = {
        write: WriteAuthorizedBy<{ payload: T; describe(): string }, typeof arbitrary>;
      };

      const schema = toSchema<Wrap<{ title: string }>>();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 1);
  },
);

Deno.test(
  "supported binding wrapped in parentheses and assertions is accepted",
  async () => {
    const source = `/// <cts-enable />
      import { toSchema, WriteAuthorizedBy } from "commonfabric";

      declare function handler<E, S>(fn: (event: E, state: S) => void): () => void;

      const saver = (handler<void, {}>((_e, _s) => {}) as unknown)!;

      const schema = toSchema<
        WriteAuthorizedBy<{ title: string }, typeof saver>
      >();

      export { schema };
    `;
    const diagnostics = await cfcDiagnostics(source);
    assertEquals(diagnostics.length, 0);
  },
);
