/**
 * Putting an environment variable into the shell profiles a person's
 * terminals actually read. The key tool uses it to finish the opt-in:
 * installing a key file does nothing on its own, because recording turns
 * on when CF_TEST_RECORDS_KEY_FILE names it in the environment every
 * later shell inherits.
 *
 * The lines carry a marker comment, so a second run recognizes its own
 * work and appends nothing. A line that sets the variable to something
 * else, or sets it without exporting it, is reported and left alone: a
 * profile is a person's file, and the tool's job there is to say what it
 * found.
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
  /** The variable is already exported with this value. */
  | "present"
  /** The variable is already set to something else; nothing was written. */
  | "conflict"
  /**
   * The variable is set to this value but never exported, so the
   * programs the shell starts do not see it; nothing was written.
   */
  | "unexported"
  /**
   * A login shell reads this file first and it does not exist. Creating
   * it would stop the shell reading the file it falls back to, so the
   * person is told rather than the file written.
   */
  | "absent";

export interface ProfileUpdate {
  path: string;
  outcome: ProfileOutcome;
  /** The line already in the file, for a conflict or an unexported set. */
  existing?: string;
}

/** An assignment of one variable found in a profile. */
export interface ProfileSetting {
  /** The line, as the profile carries it. */
  line: string;
  /** Whether the assignment reaches the programs the shell starts. */
  exported: boolean;
  /** The value, with one level of the shell's quoting taken off. */
  value: string;
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
 * The profile files to hold the export, the one a login shell reads
 * first at the head. Every one of these that exists is updated, because
 * bash splits its startup between two files differently on macOS than on
 * Linux and a person whose terminal reads only one of them would
 * otherwise get a line that never runs.
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

/** A path split at the home directory, when it sits under one. */
function splitHome(
  path: string,
  home: string | undefined,
): { underHome: boolean; rest: string } {
  if (home === undefined || home.length === 0) {
    return { underHome: false, rest: path };
  }
  const separators = /[\\/]/g;
  const root = home.replace(/[\\/]+$/, "");
  const normalized = path.replace(separators, "/");
  const normalizedRoot = root.replace(separators, "/");
  if (normalized === normalizedRoot) return { underHome: true, rest: "" };
  return normalized.startsWith(`${normalizedRoot}/`)
    ? { underHome: true, rest: path.slice(root.length) }
    : { underHome: false, rest: path };
}

/** A path under the home directory written through $HOME. */
export function homeRelative(path: string, home: string | undefined): string {
  const split = splitHome(path, home);
  return split.underHome ? `$HOME${split.rest}` : split.rest;
}

/** The path a value naming $HOME stands for. */
export function expandHome(value: string, home: string | undefined): string {
  if (home === undefined || home.length === 0) return value;
  // A name only ends at $HOME when what follows cannot continue it,
  // which is what keeps $HOMEBREW from reading as $HOME plus BREW.
  const match = value.match(/^\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))(.*)$/);
  return match === null ? value : `${home.replace(/[\\/]+$/, "")}${match[1]}`;
}

/**
 * A value inside double quotes, with everything the shell would still
 * act on there escaped, so a path holding a dollar sign, a quote, a
 * backslash, or a backtick names the file it says.
 */
function escapeInDoubleQuotes(kind: ShellKind, text: string): string {
  // Backticks open a command substitution in every shell here except
  // fish, which has none.
  const special = kind === "fish" ? /[\\"$]/g : /[\\"$`]/g;
  return text.replace(special, (character) => `\\${character}`);
}

/**
 * The line that exports one variable in a shell's own syntax, writing
 * the home directory as $HOME so the line survives a move between
 * machines.
 */
export function exportLine(
  kind: ShellKind,
  name: string,
  value: string,
  home?: string,
): string {
  const split = splitHome(value, home);
  const escaped = escapeInDoubleQuotes(kind, split.rest);
  const quoted = split.underHome ? `"$HOME${escaped}"` : `"${escaped}"`;
  return kind === "fish"
    ? `set -gx ${name} ${quoted}`
    : `export ${name}=${quoted}`;
}

/** One level of a shell's quoting taken off a value. */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** The assignment of a variable a profile already carries, if any. */
export function parseSetting(
  text: string,
  name: string,
): ProfileSetting | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const assignment = line.match(
      new RegExp(`^(export\\s+)?${name}=(.*)$`),
    );
    if (assignment !== null) {
      return {
        line,
        exported: assignment[1] !== undefined,
        value: unquote(assignment[2] ?? ""),
      };
    }
    const set = line.match(
      new RegExp(`^set\\s+((?:-\\S+\\s+)*)${name}\\s+(.*)$`),
    );
    if (set !== null) {
      return {
        line,
        exported: /-\S*x/.test(set[1] ?? ""),
        value: unquote(set[2] ?? ""),
      };
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
  home: string | undefined,
  create: boolean,
): Promise<ProfileUpdate | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined && !create) return undefined;
  const existing = parseSetting(text ?? "", name);
  if (existing !== undefined) {
    if (expandHome(existing.value, home) !== value) {
      return { path, outcome: "conflict", existing: existing.line };
    }
    return existing.exported
      ? { path, outcome: "present" }
      : { path, outcome: "unexported", existing: existing.line };
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
 * each file's update did. Every profile that exists is written; when
 * none does, the one a login shell reads first is created. A first
 * profile that is missing while a later one exists is reported and not
 * created, since creating it is what stops a login shell reading the
 * file it falls back to.
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
  const line = exportLine(shellKind(env), name, value, home);
  const updates: ProfileUpdate[] = [];
  for (const path of candidates) {
    const update = await updateOne(path, name, line, value, home, false);
    if (update !== undefined) updates.push(update);
  }
  if (updates.length === 0) {
    const created = await updateOne(
      candidates[0]!,
      name,
      line,
      value,
      home,
      true,
    );
    if (created !== undefined) updates.push(created);
    return updates;
  }
  const first = candidates[0]!;
  if (!updates.some((update) => update.path === first)) {
    updates.unshift({ path: first, outcome: "absent" });
  }
  return updates;
}

/** The command that loads a profile into the shell already running. */
export function reloadHint(path: string, kind: ShellKind): string {
  return kind === "fish" ? `source ${path}` : `. ${path}`;
}
