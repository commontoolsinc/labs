import { assertEquals, assertThrows } from "@std/assert";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  parseCfcEnforcementMode,
  parseHarnessGatewayAuthMode,
  resolveCfcEnforcementMode,
  resolveCfcEnforcementModeSource,
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
  assertEquals(
    resolveCfcEnforcementMode({}),
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  );
});

Deno.test("resolveCfcEnforcementMode can inherit from a run manifest", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "observe" },
      },
    }),
    "observe",
  );
});

Deno.test("resolveCfcEnforcementMode ignores malformed in-memory run manifest modes", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "bogus" as CfcEnforcementMode },
      },
    }),
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  );
});

Deno.test("resolveCfcEnforcementModeSource identifies the winning mode source", () => {
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementModeOverride: "observe",
      cfcEnforcementMode: "disabled",
    }),
    "override",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementMode: "disabled",
      inheritedCfcEnforcementMode: "observe",
    }),
    "explicit-config",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      inheritedCfcEnforcementMode: "observe",
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "enforce-strict" },
      },
    }),
    "inherited",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "enforce-strict" },
      },
    }),
    "run-manifest",
  );
  assertEquals(resolveCfcEnforcementModeSource({}), "default");
});

Deno.test("resolveCfcEnforcementModeSource treats null like absent mode values", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      cfcEnforcementModeOverride: null as unknown as CfcEnforcementMode,
      cfcEnforcementMode: "observe",
    }),
    "observe",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementModeOverride: null as unknown as CfcEnforcementMode,
      cfcEnforcementMode: "observe",
    }),
    "explicit-config",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementMode: null as unknown as CfcEnforcementMode,
      inheritedCfcEnforcementMode: "enforce-explicit",
    }),
    "inherited",
  );
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
  assertEquals(config.cfcEnforcementMode, DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE);
  assertEquals(config.cfcEnforcementModeSource, "default");
});

Deno.test("resolveHarnessConfig represents openai-codex without gateway fields", () => {
  const config = resolveHarnessConfig({
    modelProvider: "openai-codex",
    credentialOwnerKey: "loom:user-1",
  });
  assertEquals(config, {
    modelProvider: "openai-codex",
    credentialOwnerKey: "loom:user-1",
    skillScriptExecutionTarget: "sandbox",
    cfcEnforcementMode: "enforce-explicit",
    cfcEnforcementModeSource: "default",
  });
  assertThrows(
    () =>
      resolveHarnessConfig({
        modelProvider: "openai-codex",
        gatewayBaseUrl: "https://example.invalid",
      }),
    Error,
    "gateway URL/auth configuration cannot be combined",
  );
});

Deno.test("resolveHarnessConfig accepts an explicit mode override string", () => {
  const config = resolveHarnessConfig({
    inheritedCfcEnforcementMode: "disabled",
    cfcEnforcementModeOverride: "enforce-strict",
  });
  assertEquals(config.cfcEnforcementMode, "enforce-strict");
  assertEquals(config.cfcEnforcementModeSource, "override");
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
