/**
 * Whether a directory an eval writes answers to is inside a git repository:
 * its work tree, its `.git` directory, or a bare repository. The answers can
 * carry the owner's data, so they are kept out of all three.
 */

import { dirname } from "@std/path";

/** The arguments `insideGit()` reads the output of. */
export const REV_PARSE_ARGS = [
  "rev-parse",
  "--is-inside-work-tree",
  "--is-inside-git-dir",
];

/**
 * Whether `git rev-parse` run with `REV_PARSE_ARGS` says its directory is
 * inside a repository, given how it exited and what it printed. Git answers
 * outside any repository by failing with "not a git repository"; any other
 * failure, or an answer that is not two booleans, is a throw rather than a
 * guess.
 */
export const insideGit = (
  revParse: { success: boolean; stdout: string; stderr: string },
): boolean => {
  if (!revParse.success) {
    if (/not a git repository/.test(revParse.stderr)) return false;
    throw new Error(`git rev-parse failed: ${revParse.stderr.trim()}`);
  }
  const answers = revParse.stdout.trim().split("\n").map((line) => line.trim());
  if (
    answers.length !== 2 ||
    answers.some((answer) => answer !== "true" && answer !== "false")
  ) {
    throw new Error(
      `git rev-parse answered ${JSON.stringify(revParse.stdout)}`,
    );
  }
  return answers.includes("true");
};

/**
 * Whether `path`, or the nearest directory above it that exists, is inside a
 * git repository's work tree or git directory.
 */
export const insideRepository = async (path: string): Promise<boolean> => {
  let at = path;
  for (;;) {
    try {
      if ((await Deno.stat(at)).isDirectory) break;
    } catch (error) {
      // A path beneath a file, such as a linked work tree's `.git`, is
      // looked for no more than one beneath a missing directory.
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.NotADirectory)
      ) throw error;
    }
    at = dirname(at);
  }
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", at, ...REV_PARSE_ARGS],
    // The refusal `insideGit()` reads is matched in English.
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return insideGit({
    success,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  });
};
