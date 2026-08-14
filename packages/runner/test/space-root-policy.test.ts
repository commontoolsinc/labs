import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { spaceRootConfidentiality } from "../src/cfc/space-root-policy.ts";

const space = (await Identity.fromPassphrase("space-root-policy")).did();

Deno.test("space root confidentiality follows flow-label persistence", () => {
  assertEquals(
    spaceRootConfidentiality("enforce-strict", "persist", space),
    [cfcAtom.space(space)],
  );
  assertEquals(
    spaceRootConfidentiality("enforce-strict", "observe", space),
    undefined,
  );
  assertEquals(
    spaceRootConfidentiality("enforce-strict", "off", space),
    undefined,
  );
  assertEquals(
    spaceRootConfidentiality("disabled", "persist", space),
    undefined,
  );
});
