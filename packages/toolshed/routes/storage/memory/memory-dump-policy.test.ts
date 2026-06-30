// Pure unit tests for the dump access policy — the security matrix this proposal
// rests on (opt-in, production defense-in-depth, allowlist union).

import { assertEquals } from "@std/assert";
import { dumpAllowSet, isDumpEnabled } from "./memory-dump-policy.ts";

Deno.test("isDumpEnabled: off unless explicitly enabled", () => {
  assertEquals(
    isDumpEnabled({
      enabled: undefined,
      env: "development",
      allowInProduction: undefined,
    }),
    false,
  );
  assertEquals(
    isDumpEnabled({
      enabled: false,
      env: "development",
      allowInProduction: undefined,
    }),
    false,
  );
  assertEquals(
    isDumpEnabled({
      enabled: true,
      env: "development",
      allowInProduction: undefined,
    }),
    true,
  );
  assertEquals(
    isDumpEnabled({ enabled: true, env: "test", allowInProduction: undefined }),
    true,
  );
});

Deno.test("isDumpEnabled: production is hard-off unless separately allowed", () => {
  // Enabled but production, no override → refuses.
  assertEquals(
    isDumpEnabled({
      enabled: true,
      env: "production",
      allowInProduction: undefined,
    }),
    false,
  );
  assertEquals(
    isDumpEnabled({
      enabled: true,
      env: "production",
      allowInProduction: false,
    }),
    false,
  );
  // Both switches on → allowed (deliberate, explicit).
  assertEquals(
    isDumpEnabled({
      enabled: true,
      env: "production",
      allowInProduction: true,
    }),
    true,
  );
  // The override alone (without enable) does nothing.
  assertEquals(
    isDumpEnabled({
      enabled: undefined,
      env: "production",
      allowInProduction: true,
    }),
    false,
  );
});

Deno.test("dumpAllowSet: union of MEMORY_DUMP_DIDS and MEMORY_SERVICE_DIDS", () => {
  const set = dumpAllowSet({
    dumpDids: "did:key:zDump1, did:key:zDump2",
    serviceDids: "did:key:zService",
  });
  assertEquals(set.has("did:key:zDump1"), true);
  assertEquals(set.has("did:key:zDump2"), true);
  // A service DID alone is sufficient — the allowlist is a union.
  assertEquals(set.has("did:key:zService"), true);
  assertEquals(set.has("did:key:zStranger"), false);
});

Deno.test("dumpAllowSet: empty config trusts nobody", () => {
  const set = dumpAllowSet({ dumpDids: "", serviceDids: "" });
  assertEquals(set.size, 0);
});
