#!/usr/bin/env -S deno run --allow-read
//
// Verifies that every place that encodes a Deno toolchain version agrees with
// the pin in mise.toml.
//
// mise.toml is the canonical pin: mise installs that version for developers,
// and .github/actions/deno-setup reads it at job time for CI. Two other places
// encode a version and can drift, so this script checks them:
//
// - Dockerfile.toolshed bakes the version into its FROM lines, which cannot
//   read a file. Each denoland/deno image tag must equal the pin.
// - tasks/check.sh accepts a range of versions (so a developer without mise
//   can still build, at the cost of a warning). The range must contain the
//   pin, otherwise the version mise installs would fail the check.
//
// The deno-setup action is also inspected: it must keep reading mise.toml,
// and any literal version in it must equal the pin.
//
// Usage: deno run --allow-read ./tasks/check-deno-pins.ts

import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

const MISE_TOML = "mise.toml";
const DOCKERFILE = "Dockerfile.toolshed";
const CHECK_SH = "tasks/check.sh";
const DENO_SETUP_ACTION = ".github/actions/deno-setup/action.yml";

// Matches a command that reads the pin out of mise.toml. The checks below
// match on this rather than on the file name alone: the name also appears in
// the action's description and comments, so a check for the name would still
// pass after the read itself had been replaced with a hardcoded version.
const READS_MISE_TOML = /sed[^\n]*\bmise\.toml\b/;

// Extracts the pinned Deno version from mise.toml contents.
export function parseMisePin(miseToml: string): string | undefined {
  return miseToml.match(/^deno = "([^"]+)"$/m)?.[1];
}

// Extracts the version tag of each denoland/deno base image in a Dockerfile.
// Tolerates flags before the image (`FROM --platform=... denoland/deno:X`)
// and a lowercase `from`, and drops any `@sha256:...` digest so a
// digest-pinned image compares on its version tag.
export function parseDockerfileDenoVersions(dockerfile: string): string[] {
  return [
    ...dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*denoland\/deno:(\S+)/gim),
  ].map((match) => match[1].split("@")[0]);
}

// Extracts the accepted version range from tasks/check.sh contents. The
// minimum is inclusive and the maximum is exclusive, matching the comparison
// in that script.
export function parseCheckShRange(
  checkSh: string,
): { min: string; max: string } | undefined {
  const min = checkSh.match(/^DENO_VERSION_MIN="([^"]+)"$/m)?.[1];
  const max = checkSh.match(/^DENO_VERSION_MAX="([^"]+)"$/m)?.[1];
  return min !== undefined && max !== undefined ? { min, max } : undefined;
}

// Compares two MAJOR.MINOR.PATCH versions numerically per component. Returns
// a negative number, zero, or a positive number as `a` is less than, equal
// to, or greater than `b`.
export function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
  }
  return 0;
}

// Reports whether `version` is within [min, max).
export function versionInRange(
  version: string,
  min: string,
  max: string,
): boolean {
  return compareVersions(version, min) >= 0 &&
    compareVersions(version, max) < 0;
}

// Checks all the pinned versions against each other, returning a description
// of each misalignment found. An empty result means everything agrees.
export function findProblems(files: {
  miseToml: string;
  dockerfile: string;
  checkSh: string;
  denoSetupAction: string;
}): string[] {
  const problems: string[] = [];

  const pin = parseMisePin(files.miseToml);
  if (pin === undefined) {
    return [`${MISE_TOML}: no Deno pin found (expected a 'deno = "..."' line)`];
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin)) {
    return [
      `${MISE_TOML}: pin "${pin}" is not an exact MAJOR.MINOR.PATCH version`,
    ];
  }

  const dockerVersions = parseDockerfileDenoVersions(files.dockerfile);
  if (dockerVersions.length === 0) {
    problems.push(`${DOCKERFILE}: no denoland/deno FROM lines found`);
  }
  for (const version of dockerVersions) {
    if (version !== pin) {
      problems.push(
        `${DOCKERFILE}: FROM denoland/deno:${version} does not match the ` +
          `${MISE_TOML} pin ${pin}`,
      );
    }
  }

  const range = parseCheckShRange(files.checkSh);
  if (range === undefined) {
    problems.push(
      `${CHECK_SH}: DENO_VERSION_MIN/DENO_VERSION_MAX not found`,
    );
  } else if (!versionInRange(pin, range.min, range.max)) {
    problems.push(
      `${CHECK_SH}: accepted range [${range.min}, ${range.max}) does not ` +
        `contain the ${MISE_TOML} pin ${pin}`,
    );
  }

  if (!READS_MISE_TOML.test(files.checkSh)) {
    problems.push(
      `${CHECK_SH}: does not read ${MISE_TOML}; it would no longer warn ` +
        `when the running Deno is off the pin`,
    );
  }

  if (!READS_MISE_TOML.test(files.denoSetupAction)) {
    problems.push(
      `${DENO_SETUP_ACTION}: does not read ${MISE_TOML}; CI would no longer ` +
        `follow the pin`,
    );
  }
  for (
    const [literal] of files.denoSetupAction.matchAll(/\b\d+\.\d+\.\d+\b/g)
  ) {
    if (literal !== pin) {
      problems.push(
        `${DENO_SETUP_ACTION}: contains version literal ${literal}, which ` +
          `does not match the ${MISE_TOML} pin ${pin}`,
      );
    }
  }

  return problems;
}

export async function main(): Promise<number> {
  const read = (path: string) => Deno.readTextFile(join(REPO_ROOT, path));
  const files = {
    miseToml: await read(MISE_TOML),
    dockerfile: await read(DOCKERFILE),
    checkSh: await read(CHECK_SH),
    denoSetupAction: await read(DENO_SETUP_ACTION),
  };

  const problems = findProblems(files);
  if (problems.length > 0) {
    console.error("Deno toolchain pins are misaligned:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    return 1;
  }

  console.log(
    `Deno toolchain pins are aligned: ${parseMisePin(files.miseToml)}`,
  );
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
