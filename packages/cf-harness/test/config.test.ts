import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_GATEWAY_BASE_URL,
  parseCfcEnforcementMode,
  resolveCfcEnforcementMode,
  resolveHarnessConfig,
} from "../src/config.ts";

Deno.test("parseCfcEnforcementMode accepts runner-aligned values", () => {
  assertEquals(parseCfcEnforcementMode("observe"), "observe");
  assertEquals(
    parseCfcEnforcementMode("enforce-explicit"),
    "enforce-explicit",
  );
  assertEquals(parseCfcEnforcementMode("bogus"), undefined);
});

Deno.test("resolveCfcEnforcementMode prefers explicit override", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      cfcEnforcementModeOverride: "observe",
      cfcEnforcementMode: "disabled",
      inheritedCfcEnforcementMode: "enforce-strict",
    }),
    "observe",
  );
});

Deno.test("resolveCfcEnforcementMode falls back through config and inherited values", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      cfcEnforcementMode: "enforce-explicit",
      inheritedCfcEnforcementMode: "observe",
    }),
    "enforce-explicit",
  );
  assertEquals(
    resolveCfcEnforcementMode({
      inheritedCfcEnforcementMode: "observe",
    }),
    "observe",
  );
  assertEquals(resolveCfcEnforcementMode({}), "disabled");
});

Deno.test("resolveHarnessConfig normalizes the gateway base URL", () => {
  const config = resolveHarnessConfig({
    gatewayBaseUrl: "https://llm.stage.commontools.dev",
  });
  assertEquals(config.gatewayBaseUrl, DEFAULT_GATEWAY_BASE_URL);
  assertEquals(config.cfcEnforcementMode, "disabled");
});

Deno.test("resolveHarnessConfig accepts an explicit mode override string", () => {
  const config = resolveHarnessConfig({
    inheritedCfcEnforcementMode: "disabled",
    cfcEnforcementModeOverride: "enforce-strict",
  });
  assertEquals(config.cfcEnforcementMode, "enforce-strict");
});
