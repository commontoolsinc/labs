import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_GATEWAY_BASE_URL,
  parseCfcEnforcementMode,
  parseHarnessGatewayAuthMode,
  resolveCfcEnforcementMode,
  resolveGatewayAuthMode,
  resolveHarnessConfig,
} from "../src/config.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";

Deno.test("parseCfcEnforcementMode accepts runner-aligned values", () => {
  assertEquals(parseCfcEnforcementMode("observe"), "observe");
  assertEquals(
    parseCfcEnforcementMode("enforce-explicit"),
    "enforce-explicit",
  );
  assertEquals(parseCfcEnforcementMode("bogus"), undefined);
});

Deno.test("parseHarnessGatewayAuthMode accepts supported values", () => {
  assertEquals(parseHarnessGatewayAuthMode("bearer"), "bearer");
  assertEquals(parseHarnessGatewayAuthMode("none"), "none");
  assertEquals(parseHarnessGatewayAuthMode("bogus"), undefined);
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

Deno.test("resolveGatewayAuthMode prefers explicit override", () => {
  assertEquals(
    resolveGatewayAuthMode({
      gatewayAuthModeOverride: "none",
      gatewayAuthMode: "bearer",
    }),
    "none",
  );
});

Deno.test("resolveGatewayAuthMode defaults to bearer", () => {
  assertEquals(resolveGatewayAuthMode({}), "bearer");
});

Deno.test("resolveHarnessConfig normalizes the gateway base URL", () => {
  const config = resolveHarnessConfig({
    gatewayBaseUrl: "https://llm.stage.commontools.dev",
  });
  assertEquals(config.gatewayBaseUrl, DEFAULT_GATEWAY_BASE_URL);
  assertEquals(config.gatewayAuthMode, "bearer");
  assertEquals(config.cfcEnforcementMode, "disabled");
});

Deno.test("resolveHarnessConfig accepts an explicit mode override string", () => {
  const config = resolveHarnessConfig({
    inheritedCfcEnforcementMode: "disabled",
    cfcEnforcementModeOverride: "enforce-strict",
  });
  assertEquals(config.cfcEnforcementMode, "enforce-strict");
});

Deno.test("resolveHarnessConfig preserves explicit sandbox config", () => {
  const sandbox = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/workspace",
  });
  const config = resolveHarnessConfig({
    sandbox,
  });
  assertEquals(config.sandbox, sandbox);
});

Deno.test("resolveHarnessConfig preserves explicit artifact root config", () => {
  const config = resolveHarnessConfig({
    artifactRoot: "/tmp/cf-harness-artifacts",
  });
  assertEquals(config.artifactRoot, "/tmp/cf-harness-artifacts");
});
