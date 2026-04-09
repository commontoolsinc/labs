import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createSchemaTransformerV2 } from "../../schema-generator/src/plugin.ts";
import {
  asObjectSchema,
  getTypeFromCode,
} from "../../schema-generator/test/utils.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-authoring-observe-tests",
);

describe("CFC authoring surface trust-sensitive claims", () => {
  const createRuntime = () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
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

    expect((schema.properties?.value as any)?.ifc?.writeAuthorizedBy).toEqual({
      __ctWriterIdentityOf: "localFunction",
    });

    const { runtime, storageManager } = createRuntime();
    try {
      const observeTx = runtime.edit();
      observeTx.setCfcEnforcementMode("observe");

      const observeCell = runtime.getCell(
        signer.did(),
        "cfc-authoring-observe-write-authorized-by",
        schema as any,
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
        "unsupported trust-sensitive claim writeAuthorizedBy at /value",
      );

      const enforceTx = runtime.edit();
      enforceTx.setCfcEnforcementMode("enforce-explicit");

      const enforceCell = runtime.getCell(
        signer.did(),
        "cfc-authoring-enforce-write-authorized-by",
        schema as any,
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
        "unsupported trust-sensitive claim writeAuthorizedBy at /value",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
