/**
 * Operator input cells: cells the operator passes into a run by reference
 * with `--input-cell`, populated in the fabric before the run exists. Each
 * becomes a handle-table entry at run start — the handle is only how the
 * harness names a cell to a model that cannot hold addresses — so the run's
 * inputs reach the model as tokens from its first turn. The values stay in
 * their cells; what the model receives is a token and the operator's own
 * name for it. This is the calling convention the CT-2066 demonstration
 * rests on — a prompt that never holds a literal value cannot inline one by
 * accident, and cannot pass one on by accident either.
 *
 * Like a well-known grant, an input cell discloses nothing by itself: the
 * address stays trusted-side in the handle table, `describe_handle` answers
 * shape, and reading anything behind the token means running a pattern over
 * it. Unlike a grant, an input cell is explicit operator configuration, so
 * one that cannot be minted — an unparseable reference, or one targeting
 * another space — fails the run out loud rather than proceeding without it.
 */

import type { MemorySpace } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { createHarnessHandleTable, mintAddressHandle } from "./handle-table.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type {
  HarnessInputCell,
  HarnessInputCellSpec,
} from "./contracts/input-cells.ts";

export type {
  HarnessInputCell,
  HarnessInputCellSpec,
} from "./contracts/input-cells.ts";

/**
 * An input cell's name is model-facing text the operator authors, so it is
 * held to a shape that cannot smuggle structure: word characters and hyphens.
 */
const INPUT_CELL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A parsed `--input-cell` argument. */
export interface ParsedInputCellArgument {
  name: string;
  ref: string;
}

/**
 * Parses one `--input-cell` argument of the form `<name>=<link>`. Neither a
 * cell's shape nor its labels are stated here: both live on the cell in the
 * fabric, and `describe_handle` answers from there — one source of truth, on
 * the cell, rather than an operator's account of it.
 *
 * @throws Error naming the defect when the argument does not fit the
 * grammar; the caller surfaces it as a usage error before any run starts.
 */
export const parseInputCellArgument = (
  raw: string,
): ParsedInputCellArgument => {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `--input-cell must be <name>=<link>, got \`${raw}\``,
    );
  }
  const name = raw.slice(0, eq).trim();
  if (!INPUT_CELL_NAME_PATTERN.test(name)) {
    throw new Error(
      `--input-cell name must match ${INPUT_CELL_NAME_PATTERN}, got \`${name}\``,
    );
  }
  const ref = raw.slice(eq + 1).trim();
  if (ref.length === 0) {
    throw new Error(`--input-cell \`${name}\` names no reference`);
  }
  if (ref.includes(";")) {
    const option = ref.slice(ref.indexOf(";") + 1).trim();
    throw new Error(
      `--input-cell \`${name}\` carries an option \`${option}\`; the flag takes none — a cell's shape and labels live on the cell in the fabric`,
    );
  }
  return { name, ref };
};

/**
 * Mints a handle for each input cell into `table` (or a fresh table salted
 * with `runId`), returning the extended table and the records for run state.
 * Every reference must parse and target `space` — the session's authority
 * ends at its own space, and an input cell pointing elsewhere is refused
 * before anything is recorded.
 *
 * @throws Error naming the failing input cell on a duplicate name, an
 * unparseable reference, or a reference into another space.
 */
export const mintInputCellHandles = async (
  table: HarnessHandleTable | undefined,
  runId: string,
  specs: readonly HarnessInputCellSpec[],
  space: MemorySpace,
): Promise<{ table: HarnessHandleTable; inputCells: HarnessInputCell[] }> => {
  let current = table ?? createHarnessHandleTable(runId);
  const inputCells: HarnessInputCell[] = [];
  const names = new Set<string>();
  for (const spec of specs) {
    // Re-checked here, not only at CLI parse: the name is model-facing text,
    // and a library caller reaches this mint without the CLI grammar.
    if (!INPUT_CELL_NAME_PATTERN.test(spec.name)) {
      throw new Error(
        `--input-cell name must match ${INPUT_CELL_NAME_PATTERN}, got \`${spec.name}\``,
      );
    }
    if (names.has(spec.name)) {
      throw new Error(`--input-cell names \`${spec.name}\` twice`);
    }
    names.add(spec.name);
    let link;
    try {
      link = parseLLMFriendlyLink(spec.ref, space);
    } catch (error) {
      throw new Error(
        `--input-cell \`${spec.name}\` reference does not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (link.space !== space) {
      throw new Error(
        `--input-cell \`${spec.name}\` reference targets another space; only references into the session space are allowed`,
      );
    }
    const minted = await mintAddressHandle(current, spec.ref);
    current = minted.table;
    // The record carries the entry's canonical spelling, not the operator's
    // raw one, so the run-state record and the table entry agree on one ref.
    const entry = current.entries.find(
      (candidate) => candidate.token === minted.token,
    )!;
    inputCells.push({ name: spec.name, token: minted.token, ref: entry.ref });
  }
  return { table: current, inputCells };
};

/**
 * The context message announcing `inputCells` to the model: one line per
 * input cell, pairing the token with the operator's name for it. An empty
 * list yields no message at all rather than an empty header.
 */
export const inputCellsContextMessage = (
  inputCells: readonly HarnessInputCell[],
): string | undefined => {
  if (inputCells.length === 0) {
    return undefined;
  }
  return [
    "Input cells for this run, named by the operator:",
    ...inputCells.map((cell) => `- ${cell.token} — ${cell.name}`),
    "You cannot read what an input cell holds. Wire it into run_pattern `inputs` to compute over it, or into any other tool input that accepts a handle; use describe_handle to see its shape.",
  ].join("\n");
};
