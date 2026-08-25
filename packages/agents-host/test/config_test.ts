import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  AGENTS_HOST_CONFIG_SCHEMA,
  DEFAULT_COLLECTION_INTERVAL_MS,
  loadAgentsHostConfig,
  MAX_COLLECTION_INTERVAL_MS,
  parseAgentsHostConfig,
} from "../src/config.ts";
import { parseAgentsHostCliOptions } from "../src/cli-options.ts";
import { basename, join } from "@std/path";

Deno.test("parseAgentsHostConfig validates and preserves provider options", () => {
  const config = parseAgentsHostConfig({
    schema: AGENTS_HOST_CONFIG_SCHEMA,
    collectionIntervalMs: 1_234,
    checkoutRoots: ["/workspace/checkouts"],
    sources: [
      {
        id: "codex-work",
        driver: "codex-app-server",
        enabled: true,
        codexTransport: "proxy",
        codexSocket: " /tmp/codex.sock ",
        cwd: " /work ",
        command: ["codex", " --profile ", "work"],
        env: { PROFILE: "work" },
        allowDangerFullAccess: false,
      },
      {
        id: "acp-local",
        driver: "acp",
        enabled: false,
      },
    ],
  });

  assertEquals(config.collectionIntervalMs, 1_234);
  assertEquals(config.checkoutRoots, ["/workspace/checkouts"]);
  assertEquals(config.sources, [
    {
      id: "codex-work",
      driver: "codex-app-server",
      enabled: true,
      codexTransport: "proxy",
      codexSocket: " /tmp/codex.sock ",
      cwd: " /work ",
      command: ["codex", " --profile ", "work"],
      env: { PROFILE: "work" },
      allowDangerFullAccess: false,
    },
    {
      id: "acp-local",
      driver: "acp",
      enabled: false,
    },
  ]);
});

Deno.test("parseAgentsHostConfig validates checkout search roots", () => {
  for (
    const checkoutRoots of [
      "/workspace/checkouts",
      ["relative"],
      ["/workspace/checkouts", "/workspace/checkouts"],
    ]
  ) {
    assertThrows(
      () =>
        parseAgentsHostConfig({
          schema: AGENTS_HOST_CONFIG_SCHEMA,
          checkoutRoots,
          sources: [{
            id: "codex",
            driver: "codex-app-server",
            enabled: true,
          }],
        }),
      Error,
    );
  }
});

Deno.test("parseAgentsHostConfig rejects ambiguous source identities", () => {
  assertThrows(
    () =>
      parseAgentsHostConfig({
        schema: AGENTS_HOST_CONFIG_SCHEMA,
        sources: [
          {
            id: "Codex",
            driver: "codex-app-server",
            enabled: true,
          },
        ],
      }),
    Error,
    'sources[0].id must already be normalized as "codex"',
  );
});

Deno.test("parseAgentsHostConfig requires commands for enabled ACP sources", () => {
  assertThrows(
    () =>
      parseAgentsHostConfig({
        schema: AGENTS_HOST_CONFIG_SCHEMA,
        sources: [{ id: "acp", driver: "acp", enabled: true }],
      }),
    Error,
    "sources[0].command is required",
  );
});

Deno.test("loadAgentsHostConfig accepts JSONC", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.jsonc");
  try {
    await Deno.writeTextFile(
      path,
      `{
        // One source is enough for a host.
        "schema": "${AGENTS_HOST_CONFIG_SCHEMA}",
        "sources": [
          { "id": "claude", "driver": "claude-agent-sdk", "enabled": true }
        ]
      }`,
    );
    const config = await loadAgentsHostConfig(path);
    assertEquals(
      config.collectionIntervalMs,
      DEFAULT_COLLECTION_INTERVAL_MS,
    );
    assertEquals(config.sources[0].id, "claude");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("parseAgentsHostConfig rejects invalid collection intervals", () => {
  for (
    const collectionIntervalMs of [
      null,
      -1,
      1.5,
      "900000",
      MAX_COLLECTION_INTERVAL_MS + 1,
    ]
  ) {
    assertThrows(
      () =>
        parseAgentsHostConfig({
          schema: AGENTS_HOST_CONFIG_SCHEMA,
          collectionIntervalMs,
          sources: [{
            id: "codex",
            driver: "codex-app-server",
            enabled: true,
          }],
        }),
      Error,
      `configuration.collectionIntervalMs must be an integer from 0 through ${MAX_COLLECTION_INTERVAL_MS}`,
    );
  }
});

Deno.test("loadAgentsHostConfig reports a missing file", async () => {
  await assertRejects(
    () => loadAgentsHostConfig("/path/that/does/not/exist/agents.jsonc"),
    Error,
    "configuration file does not exist",
  );
});

Deno.test("loadAgentsHostConfig distinguishes invalid JSONC", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.jsonc");
  try {
    await Deno.writeTextFile(path, "{ invalid");
    await assertRejects(
      () => loadAgentsHostConfig(path),
      Error,
      "configuration file is not valid JSONC",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("parseAgentsHostCliOptions reads connection values from the environment", () => {
  const env: Record<string, string> = {
    CF_API_URL: "http://fabric.example.test",
    CF_IDENTITY: "./operator.key",
    CF_SPACE: "agent-space",
  };
  const options = parseAgentsHostCliOptions(
    ["--config", "./agents.jsonc", "--once", "--no-debug-view"],
    (key) => env[key],
  );
  if (options.help) throw new Error("expected executable options");

  assertEquals(options.apiUrl, env.CF_API_URL);
  assertEquals(basename(options.identityPath), "operator.key");
  assertEquals(options.space, "agent-space");
  assertEquals(options.once, true);
  assertEquals(options.debugView, false);
});

Deno.test("parseAgentsHostCliOptions rejects unknown flags", () => {
  assertThrows(
    () =>
      parseAgentsHostCliOptions(
        ["--config", "agents.jsonc", "--mystery"],
        () => undefined,
      ),
    Error,
    "unknown option: --mystery",
  );
});

Deno.test("parseAgentsHostCliOptions does not accept per-invocation ledgers", () => {
  assertThrows(
    () =>
      parseAgentsHostCliOptions(
        ["--config", "agents.jsonc", "--ledger", "ledger.json"],
        () => undefined,
      ),
    Error,
    "unknown option: --ledger",
  );
});

Deno.test("parseAgentsHostCliOptions does not expose invalid URL credentials", () => {
  const secret = "credential-that-must-not-appear";
  const error = assertThrows(
    () =>
      parseAgentsHostCliOptions(
        [
          "--config",
          "agents.jsonc",
          "--api-url",
          `https://operator:${secret}@[invalid`,
          "--identity",
          "operator.key",
          "--space",
          "agent-space",
        ],
        () => undefined,
      ),
    Error,
    "--api-url is not a valid URL",
  );
  assertEquals(error.cause, undefined);
  assertEquals(String(error).includes(secret), false);
});
