import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { CfcEnforcementMode } from "../src/cfc/mod.ts";
import { createSchemaTransformerV2 } from "../../schema-generator/src/plugin.ts";
import {
  asObjectSchema,
  getTypeFromCode,
} from "../../schema-generator/test/utils.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-authoring-observe-tests",
);

function expectObjectSchema(
  schema: JSONSchema | undefined,
  name: string,
): JSONSchemaObj {
  if (typeof schema !== "object" || schema === null) {
    throw new Error(`${name} schema should be an object`);
  }
  return schema;
}

describe("CFC authoring surface trust-sensitive claims", () => {
  const createRuntime = (cfcEnforcementMode?: CfcEnforcementMode) => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      ...(cfcEnforcementMode ? { cfcEnforcementMode } : {}),
    });
    return { runtime, storageManager };
  };

  it("observes and then fails closed for writeAuthorizedBy claims emitted from authored types", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      function localFunction() {}

      interface SchemaRoot {
        value: WriteAuthorizedBy<{ title: string }, typeof localFunction>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const valueSchema = expectObjectSchema(
      schema.properties?.value,
      "value",
    );
    expect(valueSchema.ifc?.writeAuthorizedBy).toEqual({
      __ctWriterIdentityOf: {
        file: "test.ts",
        path: ["localFunction"],
      },
    });

    const { runtime, storageManager } = createRuntime("observe");
    try {
      const observeTx = runtime.edit();

      const observeCell = runtime.getCell(
        signer.did(),
        "cfc-authoring-observe-write-authorized-by",
        schema,
        observeTx,
      );
      observeCell.set({
        value: {
          title: "observed",
        },
      });

      const observeResult = await observeTx.commit();
      expect(observeResult.ok).toBeDefined();
      expect(observeTx.getCfcState().diagnostics).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /value",
      );

      const enforceTx = runtime.edit();
      enforceTx.setCfcEnforcementMode("enforce-explicit");

      const enforceCell = runtime.getCell(
        signer.did(),
        "cfc-authoring-enforce-write-authorized-by",
        schema,
        enforceTx,
      );
      enforceCell.set({
        value: {
          title: "blocked",
        },
      });
      enforceTx.prepareCfc();

      const enforceResult = await enforceTx.commit();
      expect(enforceResult.error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /value",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows verified compiled writeAuthorizedBy claims when the binding identity matches", async () => {
    const { runtime, storageManager } = (() => {
      const storageManager = StorageManager.emulate({
        as: signer,
      });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshotProvider: () => ({
          id: "trust-snapshot-1",
          actingPrincipal: signer.did(),
        }),
      });
      return { runtime, storageManager };
    })();

    try {
      const program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `/// <cts-enable />
            import { lift, pattern } from "commonfabric";
            type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
            type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;

            function localFunction(value: string) {
              return value.toUpperCase();
            }

            const toAuthorized = lift(localFunction);

            interface Input {
              title: string;
            }

            interface Output {
              value: WriteAuthorizedBy<string, typeof localFunction>;
            }

            export default pattern<Input, Output>(({ title }) => ({
              value: toAuthorized(title),
            }));
          `,
        }],
      };

      const { main } = await runtime.harness.compileAndEvaluateModules(
        program,
      );
      const pattern = main?.default;
      const resultCell = runtime.getCell<{ value: string }>(
        signer.did(),
        "cfc-authoring-verified-write-authorized-by",
      );

      const result = await runtime.runSynced(resultCell, pattern, {
        title: "verified",
      });
      await expect(result.pull()).resolves.toEqual({ value: "VERIFIED" });
      await runtime.scheduler.idle();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
