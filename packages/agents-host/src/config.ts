import type {
  AgentSourceConfig,
  CodexAppServerTransport,
  DriverKind,
} from "@commonfabric/agents-connector/types";
import { normalizeSourceId } from "@commonfabric/agents-connector";
import { parse as parseJsonc } from "@std/jsonc";
import { isAbsolute } from "@std/path";

export const AGENTS_HOST_CONFIG_SCHEMA = "commonfabric.agents-host.config.v1";
export const DEFAULT_COLLECTION_INTERVAL_MS = 15 * 60 * 1_000;
export const MAX_COLLECTION_INTERVAL_MS = 2_147_483_647;

export interface AgentsHostConfig {
  schema: typeof AGENTS_HOST_CONFIG_SCHEMA;
  collectionIntervalMs: number;
  checkoutRoots?: string[];
  sources: AgentSourceConfig[];
}

const SOURCE_FIELDS = new Set([
  "id",
  "driver",
  "enabled",
  "command",
  "configDir",
  "codexBin",
  "codexHome",
  "codexTransport",
  "codexSocket",
  "cwd",
  "env",
  "allowDangerFullAccess",
]);

const DRIVERS = new Set<DriverKind>([
  "claude-agent-sdk",
  "codex-app-server",
  "acp",
]);

const CODEX_TRANSPORTS = new Set<CodexAppServerTransport>([
  "stdio",
  "managed",
  "proxy",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!(key in source)) return undefined;
  return nonEmptyString(source[key], `${label}.${key}`);
}

function parseCommand(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}.command must be a non-empty string array`);
  }
  return value.map((item, index) =>
    nonEmptyString(item, `${label}.command[${index}]`)
  );
}

function parseEnvironment(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, `${label}.env`);
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== "string") {
      throw new Error(`${label}.env.${key} must be a string`);
    }
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function parseSource(value: unknown, index: number): AgentSourceConfig {
  const label = `sources[${index}]`;
  const source = record(value, label);
  for (const key of Object.keys(source)) {
    if (!SOURCE_FIELDS.has(key)) {
      throw new Error(`${label} has an unknown field: ${key}`);
    }
  }

  const rawId = nonEmptyString(source.id, `${label}.id`).trim();
  const id = normalizeSourceId(rawId);
  if (rawId !== id) {
    throw new Error(`${label}.id must already be normalized as "${id}"`);
  }

  if (
    typeof source.driver !== "string" ||
    !DRIVERS.has(source.driver as DriverKind)
  ) {
    throw new Error(`${label}.driver is not supported`);
  }
  const driver = source.driver as DriverKind;

  if (typeof source.enabled !== "boolean") {
    throw new Error(`${label}.enabled must be a boolean`);
  }

  const command = parseCommand(source.command, label);
  if (driver === "acp" && source.enabled && command === undefined) {
    throw new Error(`${label}.command is required for an enabled ACP source`);
  }

  let codexTransport: CodexAppServerTransport | undefined;
  if (source.codexTransport !== undefined) {
    if (
      typeof source.codexTransport !== "string" ||
      !CODEX_TRANSPORTS.has(
        source.codexTransport as CodexAppServerTransport,
      )
    ) {
      throw new Error(`${label}.codexTransport is not supported`);
    }
    codexTransport = source.codexTransport as CodexAppServerTransport;
  }

  if (
    source.allowDangerFullAccess !== undefined &&
    typeof source.allowDangerFullAccess !== "boolean"
  ) {
    throw new Error(`${label}.allowDangerFullAccess must be a boolean`);
  }

  const configDir = optionalString(source, "configDir", label);
  const codexBin = optionalString(source, "codexBin", label);
  const codexHome = optionalString(source, "codexHome", label);
  const codexSocket = optionalString(source, "codexSocket", label);
  const cwd = optionalString(source, "cwd", label);
  const env = parseEnvironment(source.env, label);

  return {
    id,
    driver,
    enabled: source.enabled,
    ...(command ? { command } : {}),
    ...(configDir ? { configDir } : {}),
    ...(codexBin ? { codexBin } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(codexTransport ? { codexTransport } : {}),
    ...(codexSocket ? { codexSocket } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(source.allowDangerFullAccess !== undefined
      ? { allowDangerFullAccess: source.allowDangerFullAccess }
      : {}),
  };
}

export function parseAgentsHostConfig(value: unknown): AgentsHostConfig {
  const config = record(value, "configuration");
  for (const key of Object.keys(config)) {
    const allowed = key === "schema" || key === "collectionIntervalMs" ||
      key === "sources" || key === "checkoutRoots";
    if (!allowed) {
      throw new Error(`configuration has an unknown field: ${key}`);
    }
  }
  if (config.schema !== AGENTS_HOST_CONFIG_SCHEMA) {
    throw new Error(
      `configuration.schema must be "${AGENTS_HOST_CONFIG_SCHEMA}"`,
    );
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error("configuration.sources must be a non-empty array");
  }
  const collectionIntervalMs = "collectionIntervalMs" in config
    ? config.collectionIntervalMs
    : DEFAULT_COLLECTION_INTERVAL_MS;
  if (
    typeof collectionIntervalMs !== "number" ||
    !Number.isSafeInteger(collectionIntervalMs) ||
    collectionIntervalMs < 0 ||
    collectionIntervalMs > MAX_COLLECTION_INTERVAL_MS
  ) {
    throw new Error(
      `configuration.collectionIntervalMs must be an integer from 0 through ${MAX_COLLECTION_INTERVAL_MS}`,
    );
  }

  const sources = config.sources.map(parseSource);
  let checkoutRoots: string[] = [];
  if (config.checkoutRoots !== undefined) {
    if (!Array.isArray(config.checkoutRoots)) {
      throw new Error("configuration.checkoutRoots must be a string array");
    }
    checkoutRoots = config.checkoutRoots.map((root, index) => {
      const path = nonEmptyString(
        root,
        `configuration.checkoutRoots[${index}]`,
      );
      if (!isAbsolute(path)) {
        throw new Error(
          `configuration.checkoutRoots[${index}] must be an absolute path`,
        );
      }
      return path;
    });
    if (new Set(checkoutRoots).size !== checkoutRoots.length) {
      throw new Error("configuration.checkoutRoots contains a duplicate path");
    }
  }
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`configuration has duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }
  if (!sources.some((source) => source.enabled)) {
    throw new Error("configuration must enable at least one source");
  }
  return {
    schema: AGENTS_HOST_CONFIG_SCHEMA,
    collectionIntervalMs,
    ...(checkoutRoots.length > 0 ? { checkoutRoots } : {}),
    sources,
  };
}

export async function loadAgentsHostConfig(
  path: string,
): Promise<AgentsHostConfig> {
  let contents: string;
  try {
    contents = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`configuration file does not exist: ${path}`, {
        cause: error,
      });
    }
    throw new Error(`could not read configuration file ${path}: ${error}`, {
      cause: error,
    });
  }
  let decoded: unknown;
  try {
    decoded = parseJsonc(contents);
  } catch (error) {
    throw new Error(`configuration file is not valid JSONC: ${path}`, {
      cause: error,
    });
  }
  return parseAgentsHostConfig(decoded);
}
