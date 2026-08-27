/**
 * A run as a data-flow graph: the patterns it ran, the cells those patterns
 * produced and read, and the routing between them.
 *
 * The harness's model is that work happens by running patterns over handles —
 * a pattern reads a cell the agent only ever named, computes in the space, and
 * hands back a reference to what it made. A graph of that is the shape of the
 * question "does this data flow look right": which cells a pattern was wired
 * to read, what it produced, what got named, and which confidentiality atoms
 * ride along each edge.
 *
 * Every node and edge records the step it appeared at, so the graph can be
 * shown as it stood at any point of the timeline rather than only at the end.
 */

import type { ConsoleDisclosure, ConsoleHandle, ConsoleStep } from "./steps.ts";
import { HANDLE_TOKEN_PATTERN } from "../src/contracts/handle-table.ts";

/** A pattern that ran, or a cell in the space. */
export type ConsoleGraphNodeKind = "pattern" | "cell";

export interface ConsoleGraphNode {
  id: string;
  kind: ConsoleGraphNodeKind;

  /** What to write on the node. */
  label: string;

  /** The step this node first appeared at. */
  atStep: number;

  /** For a pattern: how the call turned out, and what CFC said about it. */
  status?: ConsoleStep["status"];
  policyDecision?: string;
  disclosure?: ConsoleDisclosure;

  /** For a pattern run from the index rather than from fresh source. */
  patternId?: string;

  /** For a cell: the handle that named it, and the address it stands for. */
  token?: string;
  address?: string;

  /** For a cell: the slug `assign_slug` gave it, once it has one. */
  slug?: string;

  /** Whether any step asked what shape this cell's referent has. */
  described?: boolean;

  /** Confidentiality atoms the run's labels attached to this node. */
  confidentiality: readonly string[];
}

/**
 * How one node reaches another. `reads` is a pattern taking a cell as an
 * input; `produces` is the cell a pattern's result addressed. The two together
 * are the routing — a run with no `reads` edge composed nothing, however many
 * patterns it ran.
 */
export type ConsoleGraphEdgeKind = "reads" | "produces";

export interface ConsoleGraphEdge {
  from: string;
  to: string;
  kind: ConsoleGraphEdgeKind;

  /** The input name a `reads` edge was wired to. */
  label?: string;

  atStep: number;

  /** Confidentiality atoms the run's labels attached to this position. */
  confidentiality: readonly string[];
}

export interface ConsoleGraph {
  nodes: readonly ConsoleGraphNode[];
  edges: readonly ConsoleGraphEdge[];

  /**
   * Patterns that read no cell. The harness's whole model is composing work
   * out of references, so a run whose patterns all read nothing built
   * everything from literals — worth stating rather than leaving to be
   * counted off the picture.
   */
  unwiredPatterns: number;
}

/** Every handle token in a value, wherever it sits inside it. */
const tokensIn = (value: unknown): string[] => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.match(new RegExp(HANDLE_TOKEN_PATTERN)) ?? [];
};

/** The short name of a CFC atom, which is the last segment of its type URL. */
const atomNames = (clauses: readonly unknown[] = []): string[] =>
  clauses.flatMap((clause) => {
    const type = typeof clause === "object" && clause !== null
      ? (clause as { type?: unknown }).type
      : undefined;
    return typeof type === "string" ? [type.split("/").pop() ?? type] : [];
  });

/** The confidentiality atoms a step's labels put at one input path. */
const atomsAtPath = (step: ConsoleStep, key: string): string[] => {
  const entries = step.invocation?.cfcInputLabels?.entries ?? [];
  const names = new Set<string>();
  for (const entry of entries) {
    // A label at `inputs.books` governs the `books` input; one at `inputs`
    // governs every input under it.
    const path = entry.path.map(String);
    const governs = path.length === 0 ||
      (path[0] === "inputs" && (path.length === 1 || path[1] === key)) ||
      path[0] === key;
    if (!governs) {
      continue;
    }
    for (const name of atomNames(entry.label?.confidentiality)) {
      names.add(name);
    }
  }
  return [...names];
};

/** Every confidentiality atom a step's labels carry, at any path. */
const allAtoms = (step: ConsoleStep): string[] => {
  const names = new Set<string>();
  for (const entry of step.invocation?.cfcInputLabels?.entries ?? []) {
    for (const name of atomNames(entry.label?.confidentiality)) {
      names.add(name);
    }
  }
  return [...names];
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The graph a run's steps describe. Cells are keyed by the address they stand
 * for where the run's handle table resolves one, so two tokens naming the same
 * cell are one node; a token the table does not resolve keys on itself, which
 * is the most that can honestly be said about it.
 */
export const consoleRunGraph = (
  steps: readonly ConsoleStep[],
  handles: readonly ConsoleHandle[] = [],
  runId = "",
): ConsoleGraph => {
  const addressByToken = new Map(
    handles.flatMap((handle) =>
      handle.ref === undefined ? [] : [[handle.token, handle.ref] as const]
    ),
  );
  const cellId = (token: string): string =>
    `cell:${addressByToken.get(token) ?? token}`;

  const nodes = new Map<string, ConsoleGraphNode>();
  const edges: ConsoleGraphEdge[] = [];

  const cellNode = (token: string, atStep: number): ConsoleGraphNode => {
    const id = cellId(token);
    const held = nodes.get(id);
    if (held !== undefined) {
      return held;
    }
    const address = addressByToken.get(token);
    const node: ConsoleGraphNode = {
      id,
      kind: "cell",
      label: token,
      atStep,
      token,
      ...(address !== undefined ? { address } : {}),
      confidentiality: [],
    };
    nodes.set(id, node);
    return node;
  };

  for (const step of steps) {
    if (step.kind !== "tool") {
      continue;
    }
    const args = asRecord(step.input);
    switch (step.toolName) {
      case "run_pattern": {
        const id = `pattern:${runId}:${step.index}`;
        const patternId = asString(args.patternId);
        const node: ConsoleGraphNode = {
          id,
          kind: "pattern",
          label: patternId ?? `run_pattern #${step.index}`,
          atStep: step.index,
          status: step.status,
          ...(step.policy !== undefined
            ? { policyDecision: step.policy.decision }
            : {}),
          ...(step.disclosure !== undefined
            ? { disclosure: step.disclosure }
            : {}),
          ...(patternId !== undefined ? { patternId } : {}),
          confidentiality: allAtoms(step),
        };
        nodes.set(id, node);

        // Read edges: an input whose value carries a handle wires this pattern
        // to the cell that handle names.
        for (const [key, value] of Object.entries(asRecord(args.inputs))) {
          for (const token of tokensIn(value)) {
            cellNode(token, step.index);
            edges.push({
              from: cellId(token),
              to: id,
              kind: "reads",
              label: key,
              atStep: step.index,
              confidentiality: atomsAtPath(step, key),
            });
          }
        }

        // The result reference is the cell this pattern produced.
        const resultRef = asString(asRecord(step.output).resultRef);
        for (
          const token of resultRef === undefined ? [] : tokensIn(resultRef)
        ) {
          cellNode(token, step.index);
          edges.push({
            from: id,
            to: cellId(token),
            kind: "produces",
            atStep: step.index,
            confidentiality: [],
          });
        }
        break;
      }
      case "assign_slug": {
        const token = asString(args.token);
        const slug = asString(asRecord(step.output).slug) ??
          asString(args.slug);
        if (token !== undefined) {
          const node = cellNode(token, step.index);
          if (slug !== undefined && step.status !== "error") {
            node.slug = slug;
            node.label = slug;
          }
        }
        break;
      }
      case "describe_handle": {
        const token = asString(args.token);
        if (token !== undefined) {
          cellNode(token, step.index).described = true;
        }
        break;
      }
      default:
        break;
    }
  }

  const readTargets = new Set(
    edges.filter((edge) => edge.kind === "reads").map((edge) => edge.to),
  );
  const unwiredPatterns =
    [...nodes.values()].filter((node) =>
      node.kind === "pattern" && !readTargets.has(node.id)
    ).length;

  return { nodes: [...nodes.values()], edges, unwiredPatterns };
};

/** One run of a family, as the family graph needs to read it. */
export interface ConsoleGraphRunInput {
  runId: string;
  steps: readonly ConsoleStep[];
  handles: readonly ConsoleHandle[];
}

/**
 * The graph of a run and the `delegate_task` children beneath it.
 *
 * A run family is where the routing actually lives: a parent commonly names a
 * cell its child produced, so a graph drawn per run splits that flow in two
 * and shows a cell arriving from nowhere. Cells are keyed by the address they
 * stand for, so the child's token and the parent's token for one cell are one
 * node.
 *
 * A descendant's nodes are dated to the ancestor step that delegated into it:
 * from the parent's point of view, everything the child made becomes available
 * at the `delegate_task` call, and a child's own step order is not comparable
 * with its parent's. Open the child's own run to scrub inside it.
 */
export const consoleRunFamilyGraph = (
  root: ConsoleGraphRunInput,
  descendants: readonly ConsoleGraphRunInput[] = [],
): ConsoleGraph => {
  const byRunId = new Map(descendants.map((run) => [run.runId, run]));
  const nodes = new Map<string, ConsoleGraphNode>();
  const edges: ConsoleGraphEdge[] = [];

  const absorb = (graph: ConsoleGraph, atStep?: number): void => {
    for (const node of graph.nodes) {
      const dated = atStep === undefined ? node : { ...node, atStep };
      const held = nodes.get(node.id);
      if (held === undefined) {
        nodes.set(node.id, dated);
        continue;
      }
      // One cell reached from two runs: keep the earliest sighting, and take
      // whichever facts either run established about it.
      nodes.set(node.id, {
        ...held,
        atStep: Math.min(held.atStep, dated.atStep),
        ...(held.slug === undefined && dated.slug !== undefined
          ? { slug: dated.slug, label: dated.label }
          : {}),
        described: held.described || dated.described,
        confidentiality: [
          ...new Set([...held.confidentiality, ...dated.confidentiality]),
        ],
      });
    }
    for (const edge of graph.edges) {
      edges.push(atStep === undefined ? edge : { ...edge, atStep });
    }
  };

  // The root, then each subtree dated to the step that delegated into it.
  absorb(consoleRunGraph(root.steps, root.handles, root.runId));
  const walk = (run: ConsoleGraphRunInput, dateAt?: number): void => {
    for (const step of run.steps) {
      if (step.childRunId === undefined) {
        continue;
      }
      const child = byRunId.get(step.childRunId);
      if (child === undefined) {
        continue;
      }
      const at = dateAt ?? step.index;
      absorb(consoleRunGraph(child.steps, child.handles, child.runId), at);
      walk(child, at);
    }
  };
  walk(root);

  const readTargets = new Set(
    edges.filter((edge) => edge.kind === "reads").map((edge) => edge.to),
  );
  return {
    nodes: [...nodes.values()],
    edges,
    unwiredPatterns:
      [...nodes.values()].filter((node) =>
        node.kind === "pattern" && !readTargets.has(node.id)
      ).length,
  };
};

/**
 * The graph as it stood at the end of a step — everything that had appeared by
 * then, and nothing that had not. This is what makes the picture something to
 * scrub rather than a single end-state.
 */
export const consoleGraphAtStep = (
  graph: ConsoleGraph,
  step: number,
): ConsoleGraph => {
  const nodes = graph.nodes.filter((node) => node.atStep <= step);
  const present = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) =>
    edge.atStep <= step && present.has(edge.from) && present.has(edge.to)
  );
  const readTargets = new Set(
    edges.filter((edge) => edge.kind === "reads").map((edge) => edge.to),
  );
  return {
    nodes,
    edges,
    unwiredPatterns:
      nodes.filter((node) =>
        node.kind === "pattern" && !readTargets.has(node.id)
      ).length,
  };
};
