import { checkoutDocsCorpusRoots } from "../src/docs-corpus/corpus.ts";
import { resolveHarnessSkillsRoot } from "../src/skills/root.ts";
import { assertEquals, assertThrows } from "@std/assert";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  DEFAULT_LOOM_HARNESS_CFC_ENFORCEMENT_MODE,
  type HarnessConfig,
  parseCfcEnforcementMode,
  parseHarnessGatewayAuthMode,
  resolveCfcEnforcementMode,
  resolveCfcEnforcementModeSource,
  resolveGatewayAuthMode,
  resolveHarnessConfig,
} from "../src/config.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";

Deno.test("HarnessConfig preserves legacy gateway object literals", () => {
  const legacy: HarnessConfig = {
    gatewayBaseUrl: "https://gateway.example/",
    gatewayAuthMode: "bearer",
    skillScriptExecutionTarget: "sandbox",
    cfcEnforcementMode: "observe",
    cfcEnforcementModeSource: "default",
  };
  assertEquals(legacy.modelProvider, undefined);
});

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
    DEFAULT_LOOM_HARNESS_CFC_ENFORCEMENT_MODE,
  );
});

Deno.test("resolveCfcEnforcementMode defaults a Loom run without a named mode to observe", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
      },
    }),
    DEFAULT_LOOM_HARNESS_CFC_ENFORCEMENT_MODE,
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
      },
    }),
    "loom-default",
  );
  assertEquals(DEFAULT_LOOM_HARNESS_CFC_ENFORCEMENT_MODE, "observe");
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

Deno.test("resolveCfcEnforcementMode follows a fabric session raised to strict", () => {
  const strictSession = {
    apiUrl: "https://fabric.test",
    identityKeyPath: "/keys/identity.pkcs8",
    space: "demo",
    cfcEnforcementMode: "enforce-strict" as const,
  };

  // Nobody set the harness dial, and its own default sits at the same rung,
  // so there is nothing for the session to raise and the source names the
  // default that got there first.
  assertEquals(
    resolveCfcEnforcementMode({ fabricSession: strictSession }),
    "enforce-strict",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({ fabricSession: strictSession }),
    "default",
  );

  // A run the manifest puts below the session is where the raise still
  // decides: the harness dial would be `observe`, and the session is above it.
  const loomManifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    cfc: { enforcementMode: "observe" as const },
  };
  assertEquals(
    resolveCfcEnforcementMode({
      fabricSession: strictSession,
      runManifest: loomManifest,
    }),
    "enforce-strict",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      fabricSession: strictSession,
      runManifest: loomManifest,
    }),
    "fabric-session",
  );

  // A dial already at least as strict stands, and keeps its own source.
  assertEquals(
    resolveCfcEnforcementModeSource({
      fabricSession: strictSession,
      cfcEnforcementModeOverride: "enforce-strict",
    }),
    "override",
  );

  // Only strict raises: the session's preset pins enforce-explicit whether
  // asked for or not, and a weaker loop under it is an ordinary configuration.
  assertEquals(
    resolveCfcEnforcementMode({
      fabricSession: { ...strictSession, cfcEnforcementMode: undefined },
      cfcEnforcementModeOverride: "observe",
    }),
    "observe",
  );
});

Deno.test("resolveCfcEnforcementMode refuses a harness dial weaker than a strict session", () => {
  assertThrows(
    () =>
      resolveCfcEnforcementMode({
        fabricSession: {
          apiUrl: "https://fabric.test",
          identityKeyPath: "/keys/identity.pkcs8",
          space: "demo",
          cfcEnforcementMode: "enforce-strict",
        },
        cfcEnforcementModeOverride: "enforce-explicit",
      }),
    Error,
    "--cfc-enforcement-mode enforce-explicit is weaker than the enforce-strict",
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

Deno.test("resolveHarnessConfig preserves legacy gateway fields for openai-codex callers", () => {
  const config = resolveHarnessConfig({
    modelProvider: "openai-codex",
    credentialOwnerKey: "loom:user-1",
  });
  assertEquals(config, {
    modelProvider: "openai-codex",
    credentialOwnerKey: "loom:user-1",
    gatewayBaseUrl: DEFAULT_GATEWAY_BASE_URL,
    gatewayAuthMode: "bearer",
    skillScriptExecutionTarget: "sandbox",
    cfcEnforcementMode: "enforce-strict",
    cfcEnforcementModeSource: "default",
    docsCorpus: {
      type: "cf-harness.docs-corpus-record",
      source: "checkout-default",
      roots: checkoutDocsCorpusRoots(),
    },
    // The skills tree resolves the same way and in the same place, so a
    // caller that names neither gets both from the checkout it runs out of.
    skillsRoot: resolveHarnessSkillsRoot()?.hostPath,
    skillsRootRecord: resolveHarnessSkillsRoot(),
  });
  assertEquals(config.skillsRootRecord?.source, "checkout-default");
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

Deno.test("resolveHarnessConfig requires exact explicit and manifest credential owners", () => {
  const runManifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    credentialOwner: {
      type: "cf-harness.credential-owner-ref" as const,
      version: 1 as const,
      ownerKey: "local",
      tenantKey: "tenant-a",
    },
  };
  assertThrows(
    () =>
      resolveHarnessConfig({
        credentialOwner: {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "local",
          tenantKey: "tenant-b",
        },
        runManifest,
      }),
    Error,
    "does not match run manifest",
  );
  assertEquals(
    resolveHarnessConfig({
      credentialOwner: runManifest.credentialOwner,
      runManifest,
    }).credentialOwner,
    runManifest.credentialOwner,
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

Deno.test("resolveHarnessConfig carries a pattern index alongside a fabric session", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    patternIndex: { baseUrl: "https://index.example/" },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.patternIndex, { baseUrl: "https://index.example/" });
});

Deno.test("resolveHarnessConfig carries deliberate discoverable publishing", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    patternIndex: {
      baseUrl: "https://index.example/",
      publishDiscoverable: true,
    },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.patternIndex, {
    baseUrl: "https://index.example/",
    publishDiscoverable: true,
  });
});

Deno.test("resolveHarnessConfig rejects a pattern index with no fabric session", () => {
  assertThrows(
    () =>
      resolveHarnessConfig({
        patternIndex: { baseUrl: "https://index.example/" },
        skillScriptExecutionTarget: "sandbox",
      }),
    Error,
    "pattern index configuration requires a fabric session",
  );
});

Deno.test("resolveHarnessConfig carries a pattern index the run does not publish to", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    patternIndex: { baseUrl: "https://index.example/", publish: false },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.patternIndex, {
    baseUrl: "https://index.example/",
    publish: false,
  });
});

Deno.test("resolveHarnessConfig carries a skills.sh discovery registry", () => {
  const config = resolveHarnessConfig({
    skillsSh: { baseUrl: "https://registry.example/" },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.skillsSh, { baseUrl: "https://registry.example/" });
});
