/**
 * Debug utilities for inspecting cell values from the browser console.
 *
 * Exposed on `globalThis.commontools` as:
 *   - readCell(options?)
 *   - readArgumentCell(options?)
 *   - subscribeToCell(options?)
 *   - watchWrites(options?)
 *   - getWriteStackTrace()
 *   - explainTriggerTrace(options?)
 */

import { CellHandle } from "@commontools/runtime-client";
import type {
  CellRef,
  RuntimeClient,
  TriggerTraceEntry,
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "@commontools/runtime-client";
import type { DID } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";

interface DebugCellOptions {
  /** Space DID — defaults to current shell space */
  space?: string;
  /** Piece CID — defaults to piece from URL bar */
  did?: string;
  /** Full entity ID — use this when you already have `of:...` from trigger trace */
  id?: string;
  /** Path into cell — defaults to [] */
  path?: string[];
}

interface ExplainTriggerTraceOptions {
  /** Number of grouped changes to resolve and return. Defaults to 10. */
  limit?: number;
  /** When true, only keep root writes (`path.length === 0`). Defaults to false. */
  rootOnly?: boolean;
  /** Include the full current value in each returned change. Defaults to false. */
  includeCurrentValue?: boolean;
}

interface WatchWritesOptions extends DebugCellOptions {
  /** Path matching mode. Defaults to "exact". */
  match?: "exact" | "prefix";
  /** Optional label shown in recorded write-trace entries. */
  label?: string;
}

export interface DebugValueSummary {
  kind:
    | "undefined"
    | "null"
    | "boolean"
    | "number"
    | "string"
    | "array"
    | "object"
    | "other";
  preview?: string | number | boolean | null;
  length?: number;
  topKeys?: string[];
  internalKeys?: string[];
  name?: string;
  type?: string;
  looksLike?: string[];
  uiChildCount?: number;
}

export interface TriggerTraceChangeSummary {
  changeKey: string;
  space: string;
  entityId: string;
  path: string[];
  pathLength: number;
  entryCount: number;
  directSchedules: number;
  downstreamSchedules: number;
  beforeKinds: string[];
  afterKinds: string[];
  writers: string[];
  topDirectActions: [string, number][];
  topDownstreamEffects: [string, number][];
}

export interface ExplainedTriggerTraceChange extends TriggerTraceChangeSummary {
  currentValueSummary?: DebugValueSummary;
  currentValue?: unknown;
}

export interface TriggerTraceExplanation {
  traceEntries: number;
  rootEntries: number;
  nestedEntries: number;
  pathLengthCounts: [number, number][];
  topChanges: TriggerTraceChangeSummary[];
}

export interface ExplainedTriggerTrace
  extends Omit<TriggerTraceExplanation, "topChanges"> {
  topChanges: ExplainedTriggerTraceChange[];
}

function getDefaultDid(): string {
  const segments = globalThis.location.pathname.split("/");
  // URL format: /<spaceName>/<pieceId>
  return segments[2] ?? "";
}

function normalizeEntityId(
  options?: Pick<DebugCellOptions, "did" | "id">,
): string {
  const id = options?.id;
  if (id) {
    return id.startsWith("of:") ? id : `of:${id}`;
  }
  const did = options?.did ?? getDefaultDid();
  if (!did) {
    return "";
  }
  return did.startsWith("of:") ? did : `of:${did}`;
}

function buildCellRef(
  space: string,
  id: string,
  path: string[],
): CellRef {
  return {
    id,
    space: space as DID,
    path,
    type: "application/json",
  } as CellRef;
}

function normalizeWriteTraceMatcher(
  defaultSpace: string,
  options: WatchWritesOptions,
): WriteStackTraceMatcher {
  return {
    space: (options.space ?? defaultSpace) as DID,
    entityId: options.id || options.did
      ? normalizeEntityId(options) as WriteStackTraceMatcher["entityId"]
      : undefined,
    path: [...(options.path ?? [])],
    match: options.match ?? "exact",
    label: options.label,
  };
}

export function summarizeDebugValue(value: unknown): DebugValueSummary {
  if (value === undefined) return { kind: "undefined" };
  if (value === null) return { kind: "null", preview: null };
  if (typeof value === "boolean") return { kind: "boolean", preview: value };
  if (typeof value === "number") return { kind: "number", preview: value };
  if (typeof value === "string") {
    return {
      kind: "string",
      length: value.length,
      preview: value.length > 100 ? `${value.slice(0, 97)}...` : value,
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array", length: value.length };
  }
  if (!isRecord(value)) {
    return { kind: "other", preview: Object.prototype.toString.call(value) };
  }

  const topKeys = Object.keys(value).slice(0, 12);
  const looksLike: string[] = [];
  const internal = isRecord(value.internal) ? value.internal : undefined;
  const internalKeys = internal
    ? Object.keys(internal).slice(0, 12)
    : undefined;

  const summary: DebugValueSummary = {
    kind: "object",
    topKeys,
    internalKeys,
    looksLike,
  };

  if (typeof value.$NAME === "string") {
    summary.name = value.$NAME;
    looksLike.push("named-piece-output");
  }
  if (typeof value.$TYPE === "string") {
    summary.type = value.$TYPE;
    looksLike.push("pattern-result");
  }
  if ("$UI" in value) {
    looksLike.push("ui-result");
    const ui = value.$UI;
    if (isRecord(ui) && Array.isArray(ui.children)) {
      summary.uiChildCount = ui.children.length;
    }
  }
  if (
    "argument" in value || "internal" in value || "resultRef" in value ||
    "spell" in value
  ) {
    looksLike.push("runtime-process-cell");
  }
  if (
    internalKeys?.includes("allPieces") ||
    internalKeys?.includes("visiblePieces")
  ) {
    looksLike.push("default-app-or-home-state");
  }
  if (
    internalKeys?.includes("mentionable") ||
    internalKeys?.includes("backlinks") ||
    internalKeys?.includes("summary")
  ) {
    looksLike.push("index-state");
  }
  if (
    topKeys.includes("title") || topKeys.includes("text") ||
    internalKeys?.includes("text") || internalKeys?.includes("title")
  ) {
    looksLike.push("note-like-state");
  }

  return summary;
}

export function summarizeTriggerTraceEntries(
  trace: TriggerTraceEntry[],
  options: { limit?: number; rootOnly?: boolean } = {},
): TriggerTraceExplanation {
  const { limit = 10, rootOnly = false } = options;
  const filtered = rootOnly
    ? trace.filter((entry) => entry.path.length === 0)
    : trace;
  const pathLengthCounts = new Map<number, number>();
  let rootEntries = 0;
  let nestedEntries = 0;
  const grouped = new Map<string, {
    summary: TriggerTraceChangeSummary;
    writers: Set<string>;
    beforeKinds: Set<string>;
    afterKinds: Set<string>;
    actions: Map<string, number>;
    downstreamEffects: Map<string, number>;
  }>();

  for (const entry of filtered) {
    pathLengthCounts.set(
      entry.path.length,
      (pathLengthCounts.get(entry.path.length) ?? 0) + 1,
    );
    if (entry.path.length === 0) rootEntries++;
    else nestedEntries++;

    const changeKey = `${entry.space}/${entry.entityId}/${
      entry.path.join("/")
    }`;
    let group = grouped.get(changeKey);
    if (!group) {
      group = {
        summary: {
          changeKey,
          space: entry.space,
          entityId: entry.entityId,
          path: [...entry.path],
          pathLength: entry.path.length,
          entryCount: 0,
          directSchedules: 0,
          downstreamSchedules: 0,
          beforeKinds: [],
          afterKinds: [],
          writers: [],
          topDirectActions: [],
          topDownstreamEffects: [],
        },
        writers: new Set(),
        beforeKinds: new Set(),
        afterKinds: new Set(),
        actions: new Map(),
        downstreamEffects: new Map(),
      };
      grouped.set(changeKey, group);
    }

    group.summary.entryCount++;
    if (entry.writerActionId) group.writers.add(entry.writerActionId);
    group.beforeKinds.add(entry.before.kind);
    group.afterKinds.add(entry.after.kind);

    for (const action of entry.triggered) {
      group.summary.directSchedules++;
      group.actions.set(
        action.actionId,
        (group.actions.get(action.actionId) ?? 0) + 1,
      );
      for (const effect of action.scheduledEffects) {
        group.summary.downstreamSchedules++;
        group.downstreamEffects.set(
          effect.actionId,
          (group.downstreamEffects.get(effect.actionId) ?? 0) + 1,
        );
      }
    }
  }

  const topChanges = [...grouped.values()]
    .map((group) => ({
      ...group.summary,
      beforeKinds: [...group.beforeKinds],
      afterKinds: [...group.afterKinds],
      writers: [...group.writers].slice(0, 8),
      topDirectActions: [...group.actions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
      topDownstreamEffects: [...group.downstreamEffects.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    }))
    .sort((a, b) =>
      (b.directSchedules + b.downstreamSchedules) -
      (a.directSchedules + a.downstreamSchedules)
    )
    .slice(0, limit);

  return {
    traceEntries: filtered.length,
    rootEntries,
    nestedEntries,
    pathLengthCounts: [...pathLengthCounts.entries()].sort((a, b) =>
      a[0] - b[0]
    ),
    topChanges,
  };
}

export function createDebugUtils(
  getSpace: () => DID | undefined,
  getRt: () => RuntimeClient | undefined,
) {
  async function readCellValue(
    options?: DebugCellOptions,
    { log = true }: { log?: boolean } = {},
  ): Promise<unknown> {
    const rt = getRt();
    if (!rt) {
      if (log) console.error("[debug] No runtime available");
      return undefined;
    }

    const space = (options?.space ?? getSpace()) as string;
    if (!space) {
      if (log) console.error("[debug] No space available");
      return undefined;
    }

    const id = normalizeEntityId(options);
    if (!id) {
      if (log) {
        console.error(
          "[debug] No piece DID — navigate to a piece first or pass { did } or { id }",
        );
      }
      return undefined;
    }

    const path = options?.path ?? [];
    const ref = buildCellRef(space, id, path);

    if (log) console.log("[debug] readCell ref:", ref);
    const cell = new CellHandle(rt, ref);
    const value = await cell.sync();
    if (log) console.log("[debug] readCell value:", value);
    return value;
  }

  async function readCell(options?: DebugCellOptions): Promise<unknown> {
    return await readCellValue(options);
  }

  function readArgumentCell(
    options?: DebugCellOptions,
  ): Promise<unknown> {
    const path = ["argument", ...(options?.path ?? [])];
    return readCell({ ...options, path });
  }

  function subscribeToCell(
    options?: DebugCellOptions,
  ): (() => void) | undefined {
    const rt = getRt();
    if (!rt) {
      console.error("[debug] No runtime available");
      return undefined;
    }

    const space = (options?.space ?? getSpace()) as string;
    if (!space) {
      console.error("[debug] No space available");
      return undefined;
    }

    const id = normalizeEntityId(options);
    if (!id) {
      console.error(
        "[debug] No piece DID — navigate to a piece first or pass { did } or { id }",
      );
      return undefined;
    }

    const path = options?.path ?? [];
    const ref = buildCellRef(space, id, path);

    console.log("[debug] subscribeToCell ref:", ref);
    const cell = new CellHandle(rt, ref);
    const cancel = cell.subscribe((value) => {
      console.log(`[debug] cell update [${new Date().toISOString()}]:`, value);
    });

    console.log("[debug] Subscribed. Call the returned function to cancel.");
    return cancel;
  }

  async function watchWrites(
    options?: WatchWritesOptions | WatchWritesOptions[],
  ): Promise<WriteStackTraceMatcher[] | undefined> {
    const rt = getRt();
    if (!rt) {
      console.error("[debug] No runtime available");
      return undefined;
    }

    const defaultSpace = getSpace() as string | undefined;

    const matcherOptions = options
      ? (Array.isArray(options) ? options : [options])
      : [];
    if (
      !defaultSpace &&
      matcherOptions.some((matcher) => !matcher.space)
    ) {
      console.error(
        "[debug] No space available — pass { space } in each matcher",
      );
      return undefined;
    }
    const matchers = matcherOptions.map((matcher) =>
      normalizeWriteTraceMatcher(defaultSpace ?? "", matcher)
    );
    await rt.setWriteStackTraceMatchers(matchers);
    console.log("[debug] watchWrites matchers:", matchers);
    return matchers;
  }

  async function getWriteStackTrace(): Promise<
    WriteStackTraceEntry[] | undefined
  > {
    const rt = getRt();
    if (!rt) {
      console.error("[debug] No runtime available");
      return undefined;
    }

    const trace = await rt.getWriteStackTrace();
    console.log("[debug] getWriteStackTrace:", trace);
    return trace;
  }

  async function explainTriggerTrace(
    options: ExplainTriggerTraceOptions = {},
  ): Promise<ExplainedTriggerTrace | undefined> {
    const rt = getRt();
    if (!rt) {
      console.error("[debug] No runtime available");
      return undefined;
    }

    const summary = summarizeTriggerTraceEntries(
      await rt.getTriggerTrace(),
      options,
    );

    const topChanges = await Promise.all(
      summary.topChanges.map(async (change) => {
        const currentValue = await readCellValue(
          {
            space: change.space,
            id: change.entityId,
            path: change.path,
          },
          { log: false },
        );

        return {
          ...change,
          currentValueSummary: summarizeDebugValue(currentValue),
          currentValue: options.includeCurrentValue ? currentValue : undefined,
        } satisfies ExplainedTriggerTraceChange;
      }),
    );

    const explained = {
      ...summary,
      topChanges,
    } satisfies ExplainedTriggerTrace;

    console.log("[debug] explainTriggerTrace:", explained);
    return explained;
  }

  return {
    readCell,
    readArgumentCell,
    subscribeToCell,
    watchWrites,
    getWriteStackTrace,
    explainTriggerTrace,
  };
}
