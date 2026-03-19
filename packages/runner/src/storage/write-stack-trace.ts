import { getLogger } from "@commontools/utils/logger";
import type {
  IMemorySpaceAddress,
  MemorySpace,
  URI,
} from "./interface.ts";

export type WriteStackTraceMatchMode = "exact" | "prefix";

export interface WriteStackTraceMatcher {
  space?: MemorySpace;
  entityId?: URI;
  path?: string[];
  match?: WriteStackTraceMatchMode;
  label?: string;
}

export interface WriteStackTraceEntry {
  recordedAt: number;
  space: MemorySpace;
  entityId: URI;
  path: string[];
  writerActionId?: string;
  match: WriteStackTraceMatchMode;
  label?: string;
  result: "ok" | "error";
  errorName?: string;
  valueKind:
    | "undefined"
    | "null"
    | "boolean"
    | "number"
    | "string"
    | "array"
    | "object"
    | "other";
  stack?: string;
}

const writeTraceLogger = getLogger("storage.write-trace", {
  enabled: false,
  level: "warn",
  logCountEvery: 0,
});

const MAX_WRITE_STACK_TRACE_HISTORY = 400;

type NormalizedWriteStackTraceMatcher =
  & Required<Pick<WriteStackTraceMatcher, "match" | "path">>
  & Omit<WriteStackTraceMatcher, "match" | "path">;

let writeTraceMatchers: NormalizedWriteStackTraceMatcher[] = [];
let writeStackTrace: WriteStackTraceEntry[] = [];

function normalizeLogicalPath(address: IMemorySpaceAddress): string[] {
  if (
    address.type === "application/json" &&
    address.path[0] === "value"
  ) {
    return address.path.slice(1).map(String);
  }
  return address.path.map(String);
}

function normalizeMatcher(
  matcher: WriteStackTraceMatcher,
): NormalizedWriteStackTraceMatcher {
  return {
    ...matcher,
    match: matcher.match ?? "exact",
    path: [...(matcher.path ?? [])],
  };
}

function pathsMatch(
  matcherPath: readonly string[],
  actualPath: readonly string[],
  mode: WriteStackTraceMatchMode,
): boolean {
  if (mode === "exact") {
    if (matcherPath.length !== actualPath.length) return false;
  } else if (matcherPath.length > actualPath.length) {
    return false;
  }

  return matcherPath.every((part, index) => actualPath[index] === part);
}

function matchWriteTrace(
  matcher: ReturnType<typeof normalizeMatcher>,
  address: IMemorySpaceAddress,
  logicalPath: readonly string[],
): boolean {
  if (matcher.space && matcher.space !== address.space) return false;
  if (matcher.entityId && matcher.entityId !== address.id) return false;
  return pathsMatch(matcher.path, logicalPath, matcher.match);
}

function getValueKind(value: unknown): WriteStackTraceEntry["valueKind"] {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "other";
}

function captureStack(): string | undefined {
  const raw = new Error().stack;
  if (!raw) return undefined;
  const filtered = raw.split("\n").filter((line, index) =>
    index === 0 ||
    (!line.includes("captureStack") &&
      !line.includes("recordWriteStackTrace") &&
      !line.includes("write-stack-trace.ts"))
  );
  return filtered.join("\n");
}

export function setWriteStackTraceMatchers(
  matchers: WriteStackTraceMatcher[],
): void {
  writeTraceMatchers = matchers.map(normalizeMatcher);
  writeStackTrace = [];
}

export function getWriteStackTrace(): WriteStackTraceEntry[] {
  return [...writeStackTrace];
}

export function recordWriteStackTrace(
  address: IMemorySpaceAddress,
  value: unknown,
  options: {
    errorName?: string;
    writerActionId?: string;
  } = {},
): void {
  if (writeTraceMatchers.length === 0) return;

  const logicalPath = normalizeLogicalPath(address);
  for (const matcher of writeTraceMatchers) {
    if (!matchWriteTrace(matcher, address, logicalPath)) continue;

    const entry: WriteStackTraceEntry = {
      recordedAt: performance.now(),
      space: address.space,
      entityId: address.id,
      path: [...logicalPath],
      ...(options.writerActionId ? { writerActionId: options.writerActionId } : {}),
      match: matcher.match,
      label: matcher.label,
      result: options.errorName ? "error" : "ok",
      errorName: options.errorName,
      valueKind: getValueKind(value),
      stack: captureStack(),
    };
    writeStackTrace.push(entry);
    if (writeStackTrace.length > MAX_WRITE_STACK_TRACE_HISTORY) {
      writeStackTrace.shift();
    }

    writeTraceLogger.warn("write-stack-trace-match", () => [
      `Matched ${matcher.label ?? "write watch"}`,
      `${entry.space}/${entry.entityId}/${entry.path.join("/")}`,
      entry.writerActionId ? `Writer: ${entry.writerActionId}` : undefined,
      `Result: ${entry.result}${entry.errorName ? ` (${entry.errorName})` : ""}`,
      entry.stack ?? "(no stack available)",
    ].filter(Boolean));
  }
}
