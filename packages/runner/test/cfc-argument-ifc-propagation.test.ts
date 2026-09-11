/**
 * Which of the two builders puts a confidential argument's label on the schema
 * it produces. A module joins it onto its own result schema, because its
 * implementation is handed the argument and reads it. A pattern stores the
 * schema its author declared, and what its result carries is per field:
 * `pattern.test.ts` measures that, where the alias into a node's output holds
 * the label its module joined on.
 *
 * The last block here holds the property the rest of that rests on. A pattern
 * body is handed reactive references rather than values, so its build carries
 * no observation of an argument to join — the structural exclusion of CFC
 * §8.9.2, rather than a claim about the code under §8.9.1. A build that could
 * read an argument would be a decision point, and safety invariant 9 would
 * reach the result again.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createNodeFactory } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const HEALTH_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SensitiveHealthRecord",
  subject: "did:example:patient",
} as const;

// One confidential field, the shape a `Confidential<...>` argument compiles to.
const ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", ifc: { confidentiality: [HEALTH_ATOM] } },
    revealSensitive: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    $NAME: { type: "string" },
    $UI: { $ref: "https://commonfabric.org/schemas/vnode.json" },
  },
} as const satisfies JSONSchema;

const confidentialityOf = (schema: JSONSchema | undefined) =>
  (schema as JSONSchemaObj | undefined)?.ifc?.confidentiality;

describe("cfc-argument-ifc-propagation", () => {
  describe("pattern()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
      pushFrame({
        cause: "cfc-argument-ifc-propagation",
        space,
        runtime,
        tx,
        generatedIdCounter: 0,
      });
    });

    afterEach(async () => {
      popFrame();
      await tx.commit();
      await runtime?.dispose();
      await storageManager?.close();
    });

    const surface = () =>
      pattern(
        (input: { content: string; revealSensitive: boolean }) => ({
          $NAME: "surface",
          $UI: null,
          revealSensitive: input.revealSensitive,
        }),
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );

    it("returns a factory whose result schema is the declared one", () => {
      expect(confidentialityOf(surface().resultSchema)).toBeUndefined();
    });

    it("returns a factory whose argument schema keeps the field's label", () => {
      const properties = (surface().argumentSchema as JSONSchemaObj | undefined)
        ?.properties;

      expect(confidentialityOf(properties?.content)).toEqual([HEALTH_ATOM]);
      expect(confidentialityOf(properties?.revealSensitive)).toBeUndefined();
    });

    // `build` runs the body for its effect on the reference it is handed and
    // returns what that reference did, so each case below states one thing a
    // pattern body can learn about a confidential argument.
    const build = <T>(body: (content: unknown) => T): T => {
      let observed!: T;
      pattern(
        (input: { content: string }) => {
          observed = body(input.content);
          return { $NAME: "surface", $UI: null };
        },
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );
      return observed;
    };

    it("hands the body a reference rather than the argument's value", () => {
      expect(build((content) => typeof content)).toBe("object");
      expect(build((content) => JSON.stringify(content))).toBe("null");
    });

    it("throws when the body coerces an argument field to a primitive", () => {
      expect(() => build((content) => `${content}`)).toThrow(
        /reactive reference outside a reactive context/,
      );
    });

    it("takes the same branch for an argument field either way", () => {
      // The reference is an object, so it is truthy whatever the cell holds:
      // a build-time branch on it cannot depend on the value, which is what
      // keeps the assembled graph independent of every argument.
      expect(build((content) => (content ? "then" : "else"))).toBe("then");
    });
  });

  describe("createNodeFactory()", () => {
    it("returns a factory whose result schema carries the argument's label", () => {
      const factory = createNodeFactory({
        type: "javascript",
        implementation: (input: { content: string }) => input.content.length,
        argumentSchema: ARGUMENT_SCHEMA,
        resultSchema: { type: "number" },
      });

      expect(confidentialityOf(factory.resultSchema)).toEqual([HEALTH_ATOM]);
    });
  });
});
