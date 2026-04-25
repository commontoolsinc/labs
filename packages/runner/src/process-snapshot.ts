import type {
  FabricValue,
  JSONSchema,
  JSONValue,
  Module,
  Pattern,
} from "./builder/types.ts";
import type { RuntimeProgram } from "./harness/types.ts";
import type { NormalizedFullLink } from "./link-utils.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
} from "./link-utils.ts";
import { encodeJsonPointer } from "./link-types.ts";
import type { SigilLink } from "./sigil-types.ts";
import type { Cell } from "./cell.ts";

const PROCESS_BASE_POINTER = "#";
const PATTERN_BASE_PLACEHOLDER = "#pattern";

export interface ProcessSnapshotV1 {
  version: 1;
  program?: RuntimeProgram;
  generation?: number;
  cells: GeneratedCell[];
  predecessor?: ProcessSnapshotV1;
}

export type NodeFactoryDescriptor =
  | {
    type: "javascript";
    implementation: string;
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }
  | {
    type: "ref";
    ref: string;
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }
  | {
    type: "program";
    program: RuntimeProgram;
  };

export type GeneratedCell = {
  link: SnapshotCellLink;
  module?: NodeFactoryDescriptor;
  arguments?: SnapshotCellLink[];
  inputBindings?: JSONValue;
  stream?: SnapshotCellLink;
  state?: SnapshotCellLink[];
};

export type SnapshotCellLink = {
  baseCell: string;
  link: SigilLink;
};

export const createProcessSnapshotLink = (
  baseCell: Cell<any>,
  link: NormalizedFullLink,
): SnapshotCellLink => ({
  baseCell: PROCESS_BASE_POINTER,
  link: createSigilLinkFromParsedLink(link, {
    base: baseCell,
    includeSchema: true,
    overwrite: "this",
  }),
});

const snapshotLinkFromAlias = (
  alias: Record<string, unknown>,
  processCellId: string,
): SnapshotCellLink | undefined => {
  if (!Array.isArray(alias.path)) {
    return undefined;
  }
  const isProcessRelative = isSnapshotRecord(alias.cell) &&
    alias.cell["/"] === processCellId;
  const baseCell = isProcessRelative
    ? PROCESS_BASE_POINTER
    : PATTERN_BASE_PLACEHOLDER;
  const path = alias.path.map((segment) => String(segment));
  const schema = isSnapshotRecord(alias.schema)
    ? alias.schema as JSONSchema
    : undefined;
  return {
    baseCell,
    link: {
      "/": {
        "link@1": {
          path,
          ...(schema ? { schema } : {}),
        },
      },
    },
  };
};

const moduleDescriptor = (
  module: Module,
): NodeFactoryDescriptor | undefined => {
  if (module.type === "ref" && typeof module.implementation === "string") {
    return {
      type: "ref",
      ref: module.implementation,
      ...(module.argumentSchema !== undefined
        ? { argumentSchema: module.argumentSchema }
        : {}),
      ...(module.resultSchema !== undefined
        ? { resultSchema: module.resultSchema }
        : {}),
    };
  }

  if (module.type === "javascript") {
    const implementation = typeof module.implementationRef === "string"
      ? module.implementationRef
      : typeof module.implementation === "string"
      ? module.implementation
      : typeof module.implementation === "function"
      ? ((module.implementation as { src?: string }).src ??
        module.implementation.name ??
        Function.prototype.toString.call(module.implementation))
      : undefined;
    if (!implementation) {
      return undefined;
    }
    return {
      type: "javascript",
      implementation,
      ...(module.argumentSchema !== undefined
        ? { argumentSchema: module.argumentSchema }
        : {}),
      ...(module.resultSchema !== undefined
        ? { resultSchema: module.resultSchema }
        : {}),
    };
  }

  if (
    module.type === "pattern" &&
    module.implementation &&
    typeof module.implementation === "object" &&
    "program" in module.implementation &&
    (module.implementation as Pattern).program
  ) {
    return {
      type: "program",
      program: (module.implementation as Pattern).program!,
    };
  }

  return undefined;
};

const dedupeLinks = (
  links: NormalizedFullLink[],
): NormalizedFullLink[] => {
  const deduped: NormalizedFullLink[] = [];
  for (const link of links) {
    if (!deduped.some((existing) => areNormalizedLinksSame(existing, link))) {
      deduped.push(link);
    }
  }
  return deduped;
};

export function createReactiveSnapshotEntries(
  baseCell: Cell<any>,
  module: Module,
  reads: NormalizedFullLink[],
  writes: NormalizedFullLink[],
  options: {
    includeArguments?: boolean;
    inputBindings?: FabricValue;
  } = {},
): GeneratedCell[] {
  const boxedModule = moduleDescriptor(module);
  const inputBindings = options.inputBindings === undefined
    ? undefined
    : snapshotJsonValue(options.inputBindings, baseCell);
  const argumentsLinks = options.includeArguments === false
    ? []
    : inputBindings === undefined
    ? dedupeLinks(reads).map((link) =>
      createProcessSnapshotLink(baseCell, link)
    )
    : [];
  return dedupeLinks(writes).map((link) => ({
    link: createProcessSnapshotLink(baseCell, link),
    ...(boxedModule ? { module: boxedModule } : {}),
    ...(argumentsLinks.length > 0 ? { arguments: argumentsLinks } : {}),
    ...(inputBindings !== undefined ? { inputBindings } : {}),
  }));
}

export function createHandlerSnapshotEntry(
  baseCell: Cell<any>,
  module: Module,
  streamLink: NormalizedFullLink,
  reads: NormalizedFullLink[],
): GeneratedCell {
  const boxedModule = moduleDescriptor(module);
  const state = dedupeLinks(
    reads.filter((link) => !areNormalizedLinksSame(link, streamLink)),
  ).map((link) => createProcessSnapshotLink(baseCell, link));
  return {
    link: createProcessSnapshotLink(baseCell, streamLink),
    ...(boxedModule ? { module: boxedModule } : {}),
    stream: createProcessSnapshotLink(baseCell, streamLink),
    ...(state.length > 0 ? { state } : {}),
  };
}

export function createProcessSnapshotV1(
  previous: ProcessSnapshotV1 | undefined,
  pattern: Pattern,
  cells: GeneratedCell[],
): ProcessSnapshotV1 {
  const snapshot: ProcessSnapshotV1 = {
    version: 1,
    ...(pattern.program ? { program: pattern.program } : {}),
    generation: (previous?.generation ?? 0) + 1,
    cells,
    ...(previous ? { predecessor: previous } : {}),
  };
  const resolved = resolvePatternBasePointers(
    snapshot as unknown as JSONValue,
  ) as unknown as ProcessSnapshotV1;
  return populateInputBindingArguments(resolved);
}

function snapshotJsonValue(
  value: FabricValue,
  baseCell: Cell<any>,
): JSONValue | undefined {
  // Strip runtime-only fields such as symbol-keyed original pattern pointers and
  // force toJSON() hooks to materialize plain snapshot data.
  const json = JSON.parse(JSON.stringify(value)) as JSONValue;
  return annotateSnapshotBaseCells(json, String(baseCell.entityId["/"]));
}

function annotateSnapshotBaseCells(
  value: JSONValue,
  processCellId: string,
): JSONValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      annotateSnapshotBaseCells(item, processCellId)
    ) as JSONValue;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if ("$alias" in value && isSnapshotRecord(value.$alias)) {
    return snapshotLinkFromAlias(
      value.$alias,
      processCellId,
    ) as unknown as JSONValue;
  }

  return annotateSnapshotObject(
    value as Record<string, unknown>,
    processCellId,
  ) as JSONValue;
}

function annotateSnapshotObject(
  value: Record<string, unknown>,
  processCellId: string,
): Record<string, JSONValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      annotateSnapshotBaseCells(nested as JSONValue, processCellId),
    ]),
  );
}

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectAliasLinks(value: JSONValue): SnapshotCellLink[] {
  const links: SnapshotCellLink[] = [];
  const seen = new Set<string>();
  collectAliasLinksInto(value, links, seen);
  return links;
}

function collectAliasLinksInto(
  value: JSONValue,
  links: SnapshotCellLink[],
  seen: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAliasLinksInto(item, links, seen);
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  if (isSnapshotCellLink(value)) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      links.push(value);
    }
  }

  for (const nested of Object.values(value as Record<string, JSONValue>)) {
    collectAliasLinksInto(nested, links, seen);
  }
}

function populateInputBindingArguments(
  snapshot: ProcessSnapshotV1,
): ProcessSnapshotV1 {
  return {
    ...snapshot,
    cells: snapshot.cells.map((cell) => {
      if (cell.arguments !== undefined || cell.inputBindings === undefined) {
        return cell;
      }
      const argumentsLinks = collectAliasLinks(cell.inputBindings);
      return argumentsLinks.length > 0
        ? { ...cell, arguments: argumentsLinks }
        : cell;
    }),
  };
}

function resolvePatternBasePointers(value: JSONValue): JSONValue {
  return rewritePatternBasePointers(value, "#", undefined);
}

function rewritePatternBasePointers(
  value: JSONValue,
  pointer: string,
  currentPatternPointer: string | undefined,
): JSONValue {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      rewritePatternBasePointers(
        item,
        childPointer(pointer, String(index)),
        currentPatternPointer,
      )
    ) as JSONValue;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const nextPatternPointer = isSnapshotPatternObject(value)
    ? pointer
    : currentPatternPointer;

  if (isSnapshotCellLink(value)) {
    const baseCell = value.baseCell === PATTERN_BASE_PLACEHOLDER
      ? nextPatternPointer ?? pointer
      : value.baseCell;
    return {
      ...value,
      baseCell,
    } as unknown as JSONValue;
  }

  if ("$alias" in value && isSnapshotRecord(value.$alias)) {
    const alias = value.$alias;
    const baseCell = alias.baseCell === PATTERN_BASE_PLACEHOLDER
      ? nextPatternPointer ?? pointer
      : alias.baseCell;
    return {
      ...value,
      $alias: Object.fromEntries(
        Object.entries(alias).map(([key, nested]) => [
          key,
          key === "baseCell"
            ? baseCell as JSONValue
            : rewritePatternBasePointers(
              nested as JSONValue,
              childPointer(pointer, "$alias", key),
              nextPatternPointer,
            ),
        ]),
      ),
    } as JSONValue;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      rewritePatternBasePointers(
        nested as JSONValue,
        childPointer(pointer, key),
        nextPatternPointer,
      ),
    ]),
  ) as JSONValue;
}

function isSnapshotPatternObject(value: object): boolean {
  return "nodes" in value && "result" in value;
}

function isSnapshotCellLink(value: object): value is SnapshotCellLink {
  return "baseCell" in value && "link" in value &&
    typeof (value as { baseCell?: unknown }).baseCell === "string" &&
    isSnapshotRecord((value as { link?: unknown }).link) &&
    "/" in ((value as { link: Record<string, unknown> }).link);
}

function childPointer(pointer: string, ...segments: string[]): string {
  const suffix = encodeJsonPointer(segments);
  return suffix ? `${pointer}/${suffix}` : pointer;
}
