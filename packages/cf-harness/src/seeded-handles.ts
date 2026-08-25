/**
 * Operator-seeded handles: handle tokens minted into a run's table at start
 * for references the operator named with `--seed-handle`, so values seeded
 * into cells before the run exists reach the model as handles from its first
 * turn. The values stay in the fabric; what the model receives is a token
 * and the operator's own name for it. This is the calling convention the
 * CT-2066 demonstration rests on — a prompt that never holds a literal
 * value cannot inline one by accident, and cannot pass one on by accident
 * either.
 *
 * Like a well-known grant, a seed discloses nothing by itself: the address
 * stays trusted-side in the handle table, `describe_handle` answers shape,
 * and reading anything behind the token means running a pattern over it.
 * Unlike a grant, a seed is explicit operator configuration, so a seed that
 * cannot be minted — an unparseable reference, or one targeting another
 * space — fails the run out loud rather than proceeding without it.
 */

import type { MemorySpace } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { createHarnessHandleTable, mintAddressHandle } from "./handle-table.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type {
  HarnessSeededHandle,
  HarnessSeedHandleSpec,
} from "./contracts/seeded-handles.ts";

export type {
  HarnessSeededHandle,
  HarnessSeedHandleSpec,
} from "./contracts/seeded-handles.ts";

/**
 * A seed's name is model-facing text the operator authors, so it is held to
 * a shape that cannot smuggle structure: word characters and hyphens.
 */
const SEED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A parsed `--seed-handle` argument, before its schema file is read. */
export interface ParsedSeedHandleArgument {
  name: string;
  ref: string;
  /** Path of the operator's schema file, when the argument named one. */
  schemaFile?: string;
}

/**
 * Parses one `--seed-handle` argument of the form
 * `<name>=<link>[;schema=<file>]`.
 *
 * @throws Error naming the defect when the argument does not fit the
 * grammar; the caller surfaces it as a usage error before any run starts.
 */
export const parseSeedHandleArgument = (
  raw: string,
): ParsedSeedHandleArgument => {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `--seed-handle must be <name>=<link>[;schema=<file>], got \`${raw}\``,
    );
  }
  const name = raw.slice(0, eq).trim();
  if (!SEED_NAME_PATTERN.test(name)) {
    throw new Error(
      `--seed-handle name must match ${SEED_NAME_PATTERN}, got \`${name}\``,
    );
  }
  const [refText, ...extras] = raw.slice(eq + 1).split(";");
  const ref = refText!.trim();
  if (ref.length === 0) {
    throw new Error(`--seed-handle \`${name}\` names no reference`);
  }
  let schemaFile: string | undefined;
  for (const extra of extras) {
    const option = extra.trim();
    if (!option.startsWith("schema=") || option.length <= "schema=".length) {
      throw new Error(
        `--seed-handle \`${name}\` carries an unknown option \`${option}\`; the one supported is schema=<file>`,
      );
    }
    if (schemaFile !== undefined) {
      throw new Error(`--seed-handle \`${name}\` names schema= twice`);
    }
    schemaFile = option.slice("schema=".length);
  }
  return { name, ref, ...(schemaFile !== undefined ? { schemaFile } : {}) };
};

/**
 * Mints a handle for each seed into `table` (or a fresh table salted with
 * `runId`), returning the extended table and the seed records for run state.
 * Every reference must parse and target `space` — the session's authority
 * ends at its own space, and a seed pointing elsewhere is refused before
 * anything is recorded.
 *
 * @throws Error naming the failing seed on a duplicate name, an unparseable
 * reference, or a reference into another space.
 */
export const mintSeededHandles = async (
  table: HarnessHandleTable | undefined,
  runId: string,
  specs: readonly HarnessSeedHandleSpec[],
  space: MemorySpace,
): Promise<{ table: HarnessHandleTable; seeded: HarnessSeededHandle[] }> => {
  let current = table ?? createHarnessHandleTable(runId);
  const seeded: HarnessSeededHandle[] = [];
  const names = new Set<string>();
  for (const spec of specs) {
    if (names.has(spec.name)) {
      throw new Error(`--seed-handle names \`${spec.name}\` twice`);
    }
    names.add(spec.name);
    let link;
    try {
      link = parseLLMFriendlyLink(spec.ref, space);
    } catch (error) {
      throw new Error(
        `--seed-handle \`${spec.name}\` reference does not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (link.space !== space) {
      throw new Error(
        `--seed-handle \`${spec.name}\` reference targets another space; only references into the session space are allowed`,
      );
    }
    const minted = await mintAddressHandle(current, spec.ref, {
      ...(spec.schema !== undefined
        ? { schema: spec.schema, schemaSource: "operator" as const }
        : {}),
    });
    current = minted.table;
    // The record carries the entry's canonical spelling, not the operator's
    // raw one, so the run-state record and the table entry agree on one ref.
    const entry = current.entries.find(
      (candidate) => candidate.token === minted.token,
    )!;
    seeded.push({ name: spec.name, token: minted.token, ref: entry.ref });
  }
  return { table: current, seeded };
};

/**
 * The context message announcing `seeded` to the model: one line per seed,
 * pairing the token with the operator's name for it. An empty seed list
 * yields no message at all rather than an empty header.
 */
export const seededHandlesContextMessage = (
  seeded: readonly HarnessSeededHandle[],
): string | undefined => {
  if (seeded.length === 0) {
    return undefined;
  }
  return [
    "Seeded references for this run, named by the operator:",
    ...seeded.map((seed) => `- ${seed.token} — ${seed.name}`),
    "You cannot read what a seeded reference holds. Wire it into run_pattern `inputs` to compute over it, or into any other tool input that accepts a handle; use describe_handle to see its shape.",
  ].join("\n");
};
