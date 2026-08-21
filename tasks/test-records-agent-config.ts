/**
 * Putting an environment variable into the configuration of the
 * harnesses that run agents. A shell profile reaches an agent whose
 * commands go through that shell; an agent that runs commands some
 * other way is reached only by telling its harness to carry the
 * variable, which is what this does.
 *
 * These are other programs' files. Nothing here writes one that does
 * not parse, writes one whose variable is already set to something
 * else, or writes a file in place: the new text goes to a temporary
 * file beside it and is renamed over it, so an interrupted write leaves
 * the configuration a harness reads either exactly as it was or exactly
 * as it should be, and never half of each.
 */

import { dirname, join } from "@std/path";
import { type Environment, readEnv } from "@commonfabric/test-support/records";

/** A harness whose configuration can carry the variable. */
export interface AgentHarness {
  /** What the harness is called, for what the tool prints. */
  name: string;
  /** The directory whose presence means the harness is installed. */
  home: (home: string) => string;
  /** The configuration file, which need not exist yet. */
  config: (home: string) => string;
}

/**
 * The harnesses this knows how to configure. A harness is left alone
 * unless its own directory is there, so nothing creates configuration
 * for a program the person does not run.
 */
export const AGENT_HARNESSES: readonly AgentHarness[] = [
  {
    name: "Claude Code",
    home: (home) => join(home, ".claude"),
    config: (home) => join(home, ".claude", "settings.json"),
  },
];

/** What one harness configuration's update did. */
export type AgentConfigOutcome =
  /** The variable was written into the configuration. */
  | "added"
  /** The configuration already carries the variable with this value. */
  | "present"
  /** It carries the variable with another value; nothing was written. */
  | "conflict"
  /** The file does not parse, so nothing was written. */
  | "unreadable";

export interface AgentConfigUpdate {
  harness: string;
  path: string;
  outcome: AgentConfigOutcome;
  /** The value already there, for a conflict. */
  existing?: string;
}

/** What one harness configuration's removal did. */
export type AgentConfigRemoval = {
  harness: string;
  path: string;
  outcome: "removed" | "kept" | "unreadable";
  existing?: string;
};

function homeDirectory(env: Environment): string | undefined {
  return readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
}

/** The harnesses installed for this person. */
export async function installedHarnesses(
  env: Environment = Deno.env.get,
  harnesses: readonly AgentHarness[] = AGENT_HARNESSES,
): Promise<{ harness: AgentHarness; config: string }[]> {
  const home = homeDirectory(env);
  if (home === undefined || home.length === 0) return [];
  const installed: { harness: AgentHarness; config: string }[] = [];
  for (const harness of harnesses) {
    try {
      const stat = await Deno.stat(harness.home(home));
      if (stat.isDirectory) {
        installed.push({ harness, config: harness.config(home) });
      }
    } catch {
      // A harness that is not installed has nothing to configure.
    }
  }
  return installed;
}

/** The configuration a file holds, or undefined when it holds none. */
async function readConfig(
  path: string,
): Promise<Record<string, unknown> | undefined | "unreadable"> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    return "unreadable";
  }
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Writes configuration through a temporary file in the same directory,
 * so what a harness reads is never a half-written file.
 */
async function writeConfig(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.mkdir(dirname(path), { recursive: true });
  try {
    await Deno.writeTextFile(temporary, JSON.stringify(config, null, 2) + "\n");
    await Deno.rename(temporary, path);
  } finally {
    // The rename takes the temporary file's name away, so this removes
    // one only when the write or the rename did not get that far.
    await Deno.remove(temporary).catch(() => {});
  }
}

/** The env block a configuration carries, when it carries a usable one. */
function envBlock(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const env = config.env;
  if (env === undefined) return {};
  return typeof env === "object" && env !== null && !Array.isArray(env)
    ? env as Record<string, unknown>
    : undefined;
}

/**
 * Carries one variable into every installed harness's configuration,
 * returning what each one's update did.
 */
export async function exportFromAgentConfigs(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  harnesses: readonly AgentHarness[] = AGENT_HARNESSES,
): Promise<AgentConfigUpdate[]> {
  const updates: AgentConfigUpdate[] = [];
  for (
    const { harness, config: path } of await installedHarnesses(
      env,
      harnesses,
    )
  ) {
    const config = await readConfig(path);
    if (config === "unreadable") {
      updates.push({ harness: harness.name, path, outcome: "unreadable" });
      continue;
    }
    const held = config ?? {};
    const block = envBlock(held);
    if (block === undefined) {
      updates.push({ harness: harness.name, path, outcome: "unreadable" });
      continue;
    }
    const existing = block[name];
    if (typeof existing === "string" && existing !== value) {
      updates.push({
        harness: harness.name,
        path,
        outcome: "conflict",
        existing,
      });
      continue;
    }
    if (existing === value) {
      updates.push({ harness: harness.name, path, outcome: "present" });
      continue;
    }
    await writeConfig(path, { ...held, env: { ...block, [name]: value } });
    updates.push({ harness: harness.name, path, outcome: "added" });
  }
  return updates;
}

/**
 * Takes one variable back out of every installed harness's
 * configuration, leaving a value this tool did not write in place. An
 * env block with nothing left in it goes too, so the file returns to
 * the shape it had.
 */
export async function unexportFromAgentConfigs(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  harnesses: readonly AgentHarness[] = AGENT_HARNESSES,
): Promise<AgentConfigRemoval[]> {
  const removals: AgentConfigRemoval[] = [];
  for (
    const { harness, config: path } of await installedHarnesses(
      env,
      harnesses,
    )
  ) {
    const config = await readConfig(path);
    if (config === undefined) continue;
    if (config === "unreadable") {
      removals.push({ harness: harness.name, path, outcome: "unreadable" });
      continue;
    }
    const block = envBlock(config);
    if (block === undefined || !(name in block)) continue;
    const existing = block[name];
    if (existing !== value) {
      removals.push({
        harness: harness.name,
        path,
        outcome: "kept",
        ...(typeof existing === "string" ? { existing } : {}),
      });
      continue;
    }
    const { [name]: _removed, ...rest } = block;
    const written = { ...config };
    if (Object.keys(rest).length === 0) {
      delete written.env;
    } else {
      written.env = rest;
    }
    await writeConfig(path, written);
    removals.push({ harness: harness.name, path, outcome: "removed" });
  }
  return removals;
}
