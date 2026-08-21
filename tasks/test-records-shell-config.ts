/**
 * Putting an environment variable into the shell profiles a person's
 * terminals actually read. The key tool uses it to finish the opt-in:
 * installing a key file does nothing on its own, because recording turns
 * on when CF_TEST_RECORDS_KEY_FILE names it in the environment every
 * later shell inherits.
 *
 * The lines carry a marker comment, so a second run recognizes its own
 * work and appends nothing. A line that sets the variable to something
 * else is reported and left alone: a profile is a person's file, and the
 * tool's job there is to say what it found.
 */

import { dirname, join } from "@std/path";
import { type Environment, readEnv } from "@commonfabric/test-support/records";

/** The comment that marks the lines this tool wrote. */
export const MARKER = "# common-fabric test-records reporting key";

/** Shell families with their own profile paths and assignment syntax. */
export type ShellKind = "zsh" | "bash" | "fish" | "posix";

/** What one profile file's update did. */
export type ProfileOutcome =
  /** The line was appended. */
  | "added"
  /** The variable was already exported with this value. */
  | "present"
  /** The variable is already set to something else; nothing was written. */
  | "conflict";

export interface ProfileUpdate {
  path: string;
  outcome: ProfileOutcome;
  /** The line already in the file, for a conflict. */
  existing?: string;
}

/** The login shell's family, read from SHELL. */
export function shellKind(env: Environment = Deno.env.get): ShellKind {
  const shell = readEnv("SHELL", env) ?? "";
  const name = shell.split("/").pop() ?? "";
  if (name.includes("zsh")) return "zsh";
  if (name.includes("fish")) return "fish";
  if (name.includes("bash")) return "bash";
  return "posix";
}

/**
 * The profile files to hold the export, in the order a shell reads them.
 * Every one of these that exists is updated, and the first is created
 * when none does: bash splits its startup between two files differently
 * on macOS than on Linux, and a person whose terminal reads only one of
 * them would otherwise get a line that never runs.
 */
export function profileCandidates(
  env: Environment = Deno.env.get,
  os: string = Deno.build.os,
): string[] {
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  if (home === undefined || home.length === 0) return [];
  switch (shellKind(env)) {
    case "zsh": {
      const zdotdir = readEnv("ZDOTDIR", env);
      const dir = zdotdir !== undefined && zdotdir.length > 0 ? zdotdir : home;
      return [join(dir, ".zshrc")];
    }
    case "bash":
      return os === "darwin"
        ? [join(home, ".bash_profile"), join(home, ".bashrc")]
        : [join(home, ".bashrc"), join(home, ".bash_profile")];
    case "fish": {
      const xdg = readEnv("XDG_CONFIG_HOME", env);
      const dir = xdg !== undefined && xdg.length > 0
        ? xdg
        : join(home, ".config");
      return [join(dir, "fish", "config.fish")];
    }
    case "posix":
      return [join(home, ".profile")];
  }
}

/** A path under the home directory written through $HOME. */
export function homeRelative(path: string, home: string | undefined): string {
  if (home === undefined || home.length === 0) return path;
  const root = home.endsWith("/") ? home.slice(0, -1) : home;
  return path === root || path.startsWith(`${root}/`)
    ? `$HOME${path.slice(root.length)}`
    : path;
}

/** The line that exports one variable in a shell's own syntax. */
export function exportLine(
  kind: ShellKind,
  name: string,
  value: string,
): string {
  return kind === "fish"
    ? `set -gx ${name} "${value}"`
    : `export ${name}="${value}"`;
}

/** The line in a profile that already sets the variable, if there is one. */
export function settingLine(
  text: string,
  name: string,
): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes(name)) continue;
    if (
      new RegExp(`(^|\\s)(export\\s+)?${name}=`).test(trimmed) ||
      new RegExp(`(^|\\s)set\\s+[^\\n]*\\b${name}\\s`).test(trimmed)
    ) {
      return trimmed;
    }
  }
  return undefined;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function updateOne(
  path: string,
  name: string,
  line: string,
  value: string,
  literalValue: string,
  create: boolean,
): Promise<ProfileUpdate | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined && !create) return undefined;
  const existing = settingLine(text ?? "", name);
  if (existing !== undefined) {
    return existing.includes(value) || existing.includes(literalValue)
      ? { path, outcome: "present" }
      : { path, outcome: "conflict", existing };
  }
  const separator = text === undefined || text.length === 0
    ? ""
    : text.endsWith("\n")
    ? "\n"
    : "\n\n";
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${separator}${MARKER}\n${line}\n`, {
    append: true,
  });
  return { path, outcome: "added" };
}

/**
 * Exports one variable from the login shell's profiles, returning what
 * each file's update did. The value is written through $HOME when it
 * sits under the home directory, so the line survives a move between
 * machines.
 */
export async function exportFromProfiles(
  name: string,
  value: string,
  env: Environment = Deno.env.get,
  os: string = Deno.build.os,
): Promise<ProfileUpdate[]> {
  const candidates = profileCandidates(env, os);
  if (candidates.length === 0) return [];
  const home = readEnv("HOME", env) ?? readEnv("USERPROFILE", env);
  const literal = homeRelative(value, home);
  const line = exportLine(shellKind(env), name, literal);
  const updates: ProfileUpdate[] = [];
  for (const path of candidates) {
    const update = await updateOne(path, name, line, value, literal, false);
    if (update !== undefined) updates.push(update);
  }
  if (updates.length === 0) {
    const created = await updateOne(
      candidates[0]!,
      name,
      line,
      value,
      literal,
      true,
    );
    if (created !== undefined) updates.push(created);
  }
  return updates;
}

/** The command that loads a profile into the shell already running. */
export function reloadHint(path: string, kind: ShellKind): string {
  return kind === "fish" ? `source ${path}` : `. ${path}`;
}
