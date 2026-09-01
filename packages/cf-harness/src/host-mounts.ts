/**
 * Host bind-mount provisioning, shared by every cf-harness entrypoint.
 *
 * This lives here rather than in `cli.ts` because it used to live there, and
 * that is exactly how the interactive chat entrypoint ended up with no way to
 * mount anything. The batch CLI parsed `--host-mount` and handed the result to
 * the engine; the interactive stdio host, a different entrypoint over the same
 * engine, had no equivalent — so an embedder could provision a batch run and
 * not a chat session, with nothing in the types to say why.
 *
 * There is one spec grammar and one parser. Adding an entrypoint means calling
 * `parseHostMountSpecs` and passing `hostMountsToAdditionalMounts` to the
 * engine; it must not mean inventing a second way in.
 */

import { dirname, isAbsolute, resolve } from "@std/path";
import {
  isAbsolute as isAbsoluteSandboxPath,
  normalize as normalizeSandboxPath,
} from "@std/path/posix";

import type { DockerRunscAdditionalMountConfig } from "./sandbox/types.ts";

export type CfHarnessHostMountMode = "readonly" | "writable";

export interface CfHarnessHostMountConfig {
  name: string;
  hostPath: string;
  sandboxPath: string;
  mode: CfHarnessHostMountMode;
}

const HOST_MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const normalizeSandboxMountPath = (path: string, label: string): string => {
  const normalized = normalizeSandboxPath(path);
  if (!isAbsoluteSandboxPath(normalized) || normalized === "/") {
    throw new Error(`${label} must be an absolute non-root sandbox path`);
  }
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const HOST_MOUNT_FIELDS = new Set(["name", "source", "target", "mode"]);

const parseHostMountSpecParts = (spec: string): Record<string, string> => {
  const parts: Record<string, string> = {};
  for (const segment of spec.split(",")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      throw new Error(
        "--host-mount entries must use key=value comma-separated fields",
      );
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new Error("--host-mount fields require non-empty keys and values");
    }
    if (parts[key] !== undefined) {
      throw new Error(`--host-mount field repeated: ${key}`);
    }
    // Reject unknown keys rather than ignoring them. A typo like `mdoe=writable`
    // would otherwise fall through to the readonly default and provision a
    // mount the caller believes is writable — a silent capability difference,
    // which is the failure mode this whole module exists to stop.
    if (!HOST_MOUNT_FIELDS.has(key)) {
      throw new Error(
        `--host-mount field unknown: ${key} (expected name, source, target, or mode)`,
      );
    }
    parts[key] = value;
  }
  return parts;
};

const realPathIfDirectory = async (
  path: string,
  label: string,
): Promise<string> => {
  let realPath: string;
  try {
    realPath = await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${label} must exist: ${path}`);
    }
    throw error;
  }
  const stat = await Deno.stat(realPath);
  if (!stat.isDirectory) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
  if (realPath === dirname(realPath)) {
    throw new Error(`${label} must not be the filesystem root`);
  }
  return realPath;
};

const parseHostMountSpec = async (
  spec: string,
  cwd: string,
): Promise<CfHarnessHostMountConfig> => {
  if (spec.trim().length === 0) {
    throw new Error("--host-mount requires a non-empty spec");
  }
  const parts = parseHostMountSpecParts(spec);
  const name = parts.name;
  const source = parts.source;
  const target = parts.target;
  const mode = parts.mode ?? "readonly";
  if (name === undefined || source === undefined || target === undefined) {
    throw new Error("--host-mount requires name, source, and target fields");
  }
  if (!HOST_MOUNT_NAME_PATTERN.test(name)) {
    throw new Error(
      "--host-mount name must start with an alphanumeric character and contain only alphanumerics, dot, underscore, or dash",
    );
  }
  if (mode !== "readonly" && mode !== "writable") {
    throw new Error("--host-mount mode must be readonly or writable");
  }
  return {
    name,
    hostPath: await realPathIfDirectory(
      isAbsolute(source) ? resolve(source) : resolve(cwd, source),
      "--host-mount source",
    ),
    sandboxPath: normalizeSandboxMountPath(target, "--host-mount target"),
    mode,
  };
};

/** Parse repeated `--host-mount` specs. Names must be unique within a run. */
export const parseHostMountSpecs = async (
  input: string | readonly string[] | undefined,
  cwd: string,
): Promise<readonly CfHarnessHostMountConfig[]> => {
  const specs = input === undefined
    ? []
    : Array.isArray(input)
    ? input
    : [input as string];
  const mounts = await Promise.all(
    specs.map((spec) => parseHostMountSpec(spec, cwd)),
  );
  const names = new Set<string>();
  for (const mount of mounts) {
    if (names.has(mount.name)) {
      throw new Error(`--host-mount name repeated: ${mount.name}`);
    }
    names.add(mount.name);
  }
  return mounts;
};

/**
 * Engine options for an interactive run's provisioning flags.
 *
 * Both interactive entrypoints call this — the standalone stdio CLI and the
 * Loom-local host — so neither can advertise a flag it then drops. The first
 * version of this change wired only the Loom host, and the standalone
 * entrypoint accepted `--host-mount`, printed it in its usage text, and ignored
 * it: the same "second entrypoint, no provisioning" defect one layer in. The
 * sandbox Docker runtime pin was a third instance of that class —
 * `CF_HARNESS_SANDBOX_DOCKER_RUNTIME` reached the batch CLI only, so on a host
 * whose gVisor runtime is unusable an interactive session had no way to select
 * a working one and every sandboxed tool call died — and so it is resolved
 * here too.
 */
export const resolveInteractiveProvisioning = async (
  parsed: {
    hostMountSpecs?: readonly string[];
    maxModelTurns?: number;
  },
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = Deno.env.toObject(),
): Promise<{
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  maxModelTurns?: number;
  sandboxDockerRuntime?: string;
}> => {
  const mounts = hostMountsToAdditionalMounts(
    await parseHostMountSpecs(parsed.hostMountSpecs, cwd),
  );
  const sandboxDockerRuntime = env.CF_HARNESS_SANDBOX_DOCKER_RUNTIME?.trim();
  return {
    ...(mounts.length > 0 ? { additionalMounts: mounts } : {}),
    ...(parsed.maxModelTurns !== undefined
      ? { maxModelTurns: parsed.maxModelTurns }
      : {}),
    ...(sandboxDockerRuntime !== undefined && sandboxDockerRuntime !== ""
      ? { sandboxDockerRuntime }
      : {}),
  };
};

/** Engine-shaped mounts. The only supported way to get bind mounts into a run. */
export const hostMountsToAdditionalMounts = (
  mounts: readonly CfHarnessHostMountConfig[],
): readonly DockerRunscAdditionalMountConfig[] =>
  mounts.map((mount) => ({
    kind: "host-bind" as const,
    name: mount.name,
    hostPath: mount.hostPath,
    sandboxPath: mount.sandboxPath,
    readOnly: mount.mode === "readonly",
  }));
