import { assertEquals } from "@std/assert";
import { createHarnessCfcPolicySnapshot } from "../src/contracts/cfc-policy-snapshot.ts";

const base = {
  runId: "run-ceiling",
  generatedAt: "2026-09-04T20:00:00.000Z",
  cfcEnforcementMode: "enforce-explicit" as const,
  cfcEnforcementModeSource: "run-manifest" as const,
  promptSlotBindingSource: "absent" as const,
  parentToolAllowance: "restricted" as const,
  allowedToolIds: ["read_file" as const],
  allowedSubagentProfiles: [],
  subagentProfileConfigs: [],
};

Deno.test("createHarnessCfcPolicySnapshot projects the run manifest's read ceiling", () => {
  const snapshot = createHarnessCfcPolicySnapshot({
    ...base,
    runManifest: {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      wishId: "W-2201",
      cfc: {
        enforcementMode: "enforce-explicit",
        maxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
        onExceed: "skip",
      },
    },
  });
  assertEquals(snapshot.runManifest, {
    present: true,
    type: "cf-harness.loom-run-manifest",
    source: "loom",
    wishId: "W-2201",
    cfcEnforcementMode: "enforce-explicit",
    cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
    cfcReadOnExceed: "skip",
    promptSlotPresent: false,
  });
});

Deno.test("createHarnessCfcPolicySnapshot projects no ceiling from a manifest that declares none", () => {
  const snapshot = createHarnessCfcPolicySnapshot({
    ...base,
    runManifest: {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
    },
  });
  assertEquals("cfcReadMaxConfidentiality" in snapshot.runManifest, false);
  assertEquals("cfcReadOnExceed" in snapshot.runManifest, false);
});
