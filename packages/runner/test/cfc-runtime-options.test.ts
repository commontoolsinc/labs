import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cfc-runtime-options");

describe("CFC runtime options", () => {
  it("defaults every CFC policy dial to its enforcing rung", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    expect(runtime.cfcEnforcementMode).toBe("enforce-strict");
    expect(runtime.cfcFlowLabels).toBe("persist");
    expect(runtime.cfcWriteFloor).toBe("enforce");
    expect(runtime.cfcTriggerReadGating).toBe(true);
    expect(runtime.cfcPolicyEvaluation).toBe("enforce");
    expect(runtime.cfcLabelMetadataProtection).toBe("enforce");
    expect(runtime.cfcDeclaredMonotonicity).toBe("enforce");

    await runtime.dispose();
    await storageManager.close();
  });

  it("respects explicit rollback values for every CFC policy dial", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "off",
      cfcWriteFloor: "off",
      cfcTriggerReadGating: false,
      cfcPolicyEvaluation: "off",
      cfcLabelMetadataProtection: "off",
      cfcDeclaredMonotonicity: "off",
    });

    expect(runtime.cfcEnforcementMode).toBe("observe");
    expect(runtime.cfcFlowLabels).toBe("off");
    expect(runtime.cfcWriteFloor).toBe("off");
    expect(runtime.cfcTriggerReadGating).toBe(false);
    expect(runtime.cfcPolicyEvaluation).toBe("off");
    expect(runtime.cfcLabelMetadataProtection).toBe("off");
    expect(runtime.cfcDeclaredMonotonicity).toBe("off");

    await runtime.dispose();
    await storageManager.close();
  });
});
