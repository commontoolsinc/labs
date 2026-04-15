import {
  type CfcEnforcementMode as RunnerCfcEnforcementMode,
  DEFAULT_CFC_ENFORCEMENT_MODE,
} from "@commonfabric/runner/cfc";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeHex } from "@std/encoding/hex";
import {
  canonicalCfcJsonStringify,
  type CfcDerivedSlotsAnnotation,
  type CfcDirectoryEntryAnnotation,
  cfcFailClosedLabel,
  type CfcLabel,
  type CfcMetadataLabels,
  type CfcNodeAnnotation,
  type CfcPathSegment,
  type CfcProjectionKind,
  type CfcProjectionRef,
} from "./annotations.ts";
import type { FsTree } from "./tree.ts";

export type CfcEnforcementMode = RunnerCfcEnforcementMode;

export type CfcWritebackOperation =
  | "write"
  | "truncate"
  | "create"
  | "mkdir"
  | "unlink"
  | "rmdir"
  | "rename-source"
  | "rename-destination"
  | "symlink";
export type CfcCreateWritebackOperation = "create" | "mkdir";
export type CfcExistingWritebackOperation = "write" | "truncate";
export type CfcNamespaceMutationWritebackOperation =
  | "unlink"
  | "rmdir"
  | "rename-source"
  | "rename-destination";
export type CfcSymlinkWritebackOperation = "symlink";

export const CFC_WRITEBACK_PREPARE_XATTR = "trusted.cfc.writeback.prepare";
export const CFC_WRITEBACK_FINALIZE_XATTR = "trusted.cfc.writeback.finalize";

export type CfcPreparedWritebackLabels = {
  contentLabel?: CfcLabel;
  nameLabel?: CfcLabel;
  existenceLabel?: CfcLabel;
  namespaceLabel?: CfcLabel;
  linkTextLabel?: CfcLabel;
  targetIdentityLabel?: CfcLabel;
  metadataLabels?: Partial<CfcMetadataLabels>;
};

export type CfcPreparedWriteback = {
  version: 1;
  operation: CfcWritebackOperation;
  target: {
    ref?: CfcProjectionRef;
    parentRef?: CfcProjectionRef;
    sourceParentRef?: CfcProjectionRef;
    destinationParentRef?: CfcProjectionRef;
    path?: CfcPathSegment[];
    name?: string;
    sourceName?: string;
    destinationName?: string;
    targetText?: string;
    targetIdentity?: unknown;
  };
  expectedGeneration: string;
  labels: CfcPreparedWritebackLabels;
};

export type CfcFinalizedWriteback = {
  version: 1;
  operation: CfcWritebackOperation;
  committedGeneration: string;
};

export type CfcWritebackAuthorization =
  | {
    allowed: true;
    requiresPrepare: boolean;
    prepared?: CfcPreparedWriteback;
  }
  | {
    allowed: false;
    requiresPrepare: boolean;
    reason: string;
  };

const CFC_MODES = [
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
] as const satisfies readonly CfcEnforcementMode[];

export function parseCfcMode(
  value: string | undefined,
): CfcEnforcementMode | undefined {
  return (CFC_MODES as readonly string[]).includes(value ?? "")
    ? value as CfcEnforcementMode
    : undefined;
}

export function resolveCfcMode(options: {
  cliMode?: string;
  envMode?: string;
  runtimeMode?: CfcEnforcementMode;
}): CfcEnforcementMode {
  return parseCfcMode(options.cliMode) ??
    parseCfcMode(options.envMode) ??
    options.runtimeMode ??
    DEFAULT_CFC_ENFORCEMENT_MODE;
}

export function shouldEnableCfcAnnotations(options: {
  annotationsRequested: boolean;
  mode: CfcEnforcementMode;
}): boolean {
  return options.annotationsRequested || options.mode !== "disabled";
}

export function isCfcEnforcing(mode: CfcEnforcementMode): boolean {
  return mode === "enforce-explicit" || mode === "enforce-strict";
}

export function shouldRequirePrepareForExisting(options: {
  mode: CfcEnforcementMode;
  annotation?: CfcNodeAnnotation;
}): boolean {
  if (options.mode === "enforce-strict") return true;
  return options.mode === "enforce-explicit" &&
    options.annotation !== undefined;
}

export function shouldRequirePrepareForCreate(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForAnnotatedParent(options);
}

export function shouldRequirePrepareForNamespaceMutation(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForAnnotatedParent(options);
}

export function shouldRequirePrepareForSymlink(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForAnnotatedParent(options);
}

function shouldRequirePrepareForAnnotatedParent(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  if (options.mode === "enforce-strict") return true;
  if (options.mode !== "enforce-explicit") return false;
  const annotation = options.parentAnnotation;
  return Boolean(annotation?.namespaceLabel || annotation?.entries);
}

export function authorizeExistingWriteback(options: {
  mode: CfcEnforcementMode;
  operation: CfcExistingWritebackOperation;
  annotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForExisting(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for ${options.operation}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForExisting(options)
        ? options.prepared
        : undefined,
    };
  }

  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!options.annotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent CFC annotation",
    };
  }
  if (options.annotation.ref.generation !== options.annotation.generation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale CFC ref generation",
    };
  }
  if (!validPreparedForExisting(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeNamespaceMutationWriteback(options: {
  mode: CfcEnforcementMode;
  operation: CfcNamespaceMutationWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  pairedName?: string;
  allowPairedRenamePrepare?: boolean;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForNamespaceMutation(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for ${options.operation}:${options.name}`,
      );
    } else if (!validPreparedForNamespaceMutation(options)) {
      options.diagnostics?.push(
        `malformed prepared CFC writeback metadata for ${options.operation}:${options.name}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForNamespaceMutation(options)
        ? options.prepared
        : undefined,
    };
  }
  if (options.mode === "enforce-strict" && !options.parentAnnotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent parent CFC annotation",
    };
  }
  if (
    options.parentAnnotation &&
    options.parentAnnotation.ref.generation !==
      options.parentAnnotation.generation
  ) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale parent CFC ref generation",
    };
  }
  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!validPreparedForNamespaceMutation(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale parent prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeSymlinkWriteback(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  targetText: string;
  targetIdentity?: unknown;
  allowDeferredTargetIdentity?: boolean;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForSymlink(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for symlink:${options.name}`,
      );
    } else if (!validPreparedForSymlink(options)) {
      options.diagnostics?.push(
        `malformed prepared CFC writeback metadata for symlink:${options.name}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForSymlink(options) ? options.prepared : undefined,
    };
  }
  if (options.mode === "enforce-strict" && !options.parentAnnotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent parent CFC annotation",
    };
  }
  if (
    options.parentAnnotation &&
    options.parentAnnotation.ref.generation !==
      options.parentAnnotation.generation
  ) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale parent CFC ref generation",
    };
  }
  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!validPreparedForSymlink(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale parent prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeCreateWriteback(options: {
  mode: CfcEnforcementMode;
  operation: CfcCreateWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForCreate(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for ${options.operation}:${options.name}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForCreate(options) ? options.prepared : undefined,
    };
  }
  if (options.mode === "enforce-strict" && !options.parentAnnotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent parent CFC annotation",
    };
  }
  if (
    options.parentAnnotation &&
    options.parentAnnotation.ref.generation !==
      options.parentAnnotation.generation
  ) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale parent CFC ref generation",
    };
  }
  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!validPreparedForCreate(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale parent prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

function validPreparedForExisting(options: {
  operation: CfcExistingWritebackOperation;
  annotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
}): boolean {
  const { annotation, prepared } = options;
  if (!annotation || !prepared) return false;
  return prepared.version === 1 &&
    prepared.operation === options.operation &&
    prepared.expectedGeneration === annotation.generation &&
    prepared.target.ref?.generation === annotation.generation &&
    prepared.target.ref?.projection === annotation.ref.projection &&
    canonicalCfcJsonStringify(prepared.target.ref) ===
      canonicalCfcJsonStringify(annotation.ref);
}

function validPreparedForCreate(options: {
  operation: CfcCreateWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
}): boolean {
  const { parentAnnotation, prepared } = options;
  if (!parentAnnotation || !prepared) return false;
  const preparedParentRef = prepared.target.parentRef ?? prepared.target.ref;
  return prepared.version === 1 &&
    prepared.operation === options.operation &&
    prepared.expectedGeneration === parentAnnotation.generation &&
    prepared.target.name === options.name &&
    preparedParentRef?.generation === parentAnnotation.generation &&
    canonicalCfcJsonStringify(preparedParentRef) ===
      canonicalCfcJsonStringify(parentAnnotation.ref);
}

function validPreparedForNamespaceMutation(options: {
  operation: CfcNamespaceMutationWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  pairedName?: string;
  allowPairedRenamePrepare?: boolean;
}): boolean {
  const { parentAnnotation, prepared } = options;
  if (!parentAnnotation || !prepared) return false;
  if (prepared.version !== 1) return false;
  if (prepared.expectedGeneration !== parentAnnotation.generation) {
    return false;
  }

  const preparedParentRef = parentRefForPrepared(prepared, options.operation);
  if (
    preparedParentRef?.generation !== parentAnnotation.generation ||
    canonicalCfcJsonStringify(preparedParentRef) !==
      canonicalCfcJsonStringify(parentAnnotation.ref)
  ) {
    return false;
  }

  if (prepared.operation === options.operation) {
    return preparedNameMatches(prepared, options.operation, options.name) &&
      pairedRenameNameMatches(prepared, options);
  }

  if (
    !options.allowPairedRenamePrepare ||
    !isRenameOperation(options.operation) ||
    !isRenameOperation(prepared.operation)
  ) {
    return false;
  }
  return renameNamesMatch(prepared, options.operation, options.name) &&
    pairedRenameNameMatches(prepared, options);
}

function parentRefForPrepared(
  prepared: CfcPreparedWriteback,
  operation: CfcNamespaceMutationWritebackOperation,
): CfcProjectionRef | undefined {
  if (operation === "rename-source") {
    return prepared.target.sourceParentRef ??
      (prepared.operation === "rename-destination"
        ? prepared.target.destinationParentRef
        : undefined) ??
      prepared.target.parentRef ??
      prepared.target.ref;
  }
  if (operation === "rename-destination") {
    return prepared.target.destinationParentRef ??
      (prepared.operation === "rename-source"
        ? prepared.target.sourceParentRef
        : undefined) ??
      prepared.target.parentRef ??
      prepared.target.ref;
  }
  return prepared.target.parentRef ?? prepared.target.ref;
}

function preparedNameMatches(
  prepared: CfcPreparedWriteback,
  operation: CfcNamespaceMutationWritebackOperation,
  name: string,
): boolean {
  if (operation === "rename-source") {
    return (prepared.target.sourceName ?? prepared.target.name) === name;
  }
  if (operation === "rename-destination") {
    return (prepared.target.destinationName ?? prepared.target.name) === name;
  }
  return prepared.target.name === name;
}

function pairedRenameNameMatches(
  prepared: CfcPreparedWriteback,
  options: {
    operation: CfcNamespaceMutationWritebackOperation;
    pairedName?: string;
  },
): boolean {
  if (
    !isRenameOperation(options.operation) || options.pairedName === undefined
  ) {
    return true;
  }
  if (options.operation === "rename-source") {
    return (prepared.target.destinationName ??
      (prepared.operation === "rename-destination"
        ? prepared.target.name
        : undefined)) === options.pairedName;
  }
  return (prepared.target.sourceName ??
    (prepared.operation === "rename-source"
      ? prepared.target.name
      : undefined)) ===
    options.pairedName;
}

function renameNamesMatch(
  prepared: CfcPreparedWriteback,
  requestedOperation: CfcNamespaceMutationWritebackOperation,
  requestedName: string,
): boolean {
  if (requestedOperation === "rename-source") {
    return prepared.target.sourceName === requestedName;
  }
  if (requestedOperation === "rename-destination") {
    return prepared.target.destinationName === requestedName;
  }
  return false;
}

function validPreparedForSymlink(options: {
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  targetText: string;
  targetIdentity?: unknown;
  allowDeferredTargetIdentity?: boolean;
}): boolean {
  const { parentAnnotation, prepared } = options;
  if (!parentAnnotation || !prepared) return false;
  if (prepared.version !== 1) return false;
  const preparedParentRef = prepared.target.parentRef ?? prepared.target.ref;
  if (
    prepared.operation !== "symlink" ||
    prepared.expectedGeneration !== parentAnnotation.generation ||
    prepared.target.name !== options.name ||
    preparedParentRef?.generation !== parentAnnotation.generation ||
    canonicalCfcJsonStringify(preparedParentRef) !==
      canonicalCfcJsonStringify(parentAnnotation.ref)
  ) {
    return false;
  }

  if (typeof prepared.target.targetText === "string") {
    return prepared.target.targetText === options.targetText;
  }
  if (prepared.target.targetIdentity === undefined) return false;
  if (options.targetIdentity === undefined) {
    return options.allowDeferredTargetIdentity === true;
  }
  return canonicalCfcJsonStringify(prepared.target.targetIdentity) ===
    canonicalCfcJsonStringify(options.targetIdentity);
}

function isRenameOperation(
  operation: CfcWritebackOperation,
): operation is "rename-source" | "rename-destination" {
  return operation === "rename-source" || operation === "rename-destination";
}

export class CfcWritebackStore {
  private prepared = new Map<string, CfcPreparedWriteback>();

  setPreparedXattr(
    ino: bigint,
    name: string,
    value: string,
  ): { ok: true; prepared: CfcPreparedWriteback } | {
    ok: false;
    reason: string;
  } {
    if (name !== CFC_WRITEBACK_PREPARE_XATTR) {
      return { ok: false, reason: "unsupported writeback xattr" };
    }
    const parsed = parsePreparedWriteback(value);
    if (!parsed) return { ok: false, reason: "invalid prepare metadata" };
    this.prepared.set(
      this.key(ino, parsed.operation, parsed.target.name),
      parsed,
    );
    return { ok: true, prepared: parsed };
  }

  setFinalizeXattr(
    ino: bigint,
    name: string,
    value: string,
  ): { ok: true; finalized: CfcFinalizedWriteback } | {
    ok: false;
    reason: string;
  } {
    if (name !== CFC_WRITEBACK_FINALIZE_XATTR) {
      return { ok: false, reason: "unsupported writeback xattr" };
    }
    const parsed = parseFinalizedWriteback(value);
    if (!parsed) return { ok: false, reason: "invalid finalize metadata" };
    this.deletePrepared(ino, parsed.operation);
    return { ok: true, finalized: parsed };
  }

  getPrepared(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): CfcPreparedWriteback | undefined {
    return this.prepared.get(this.key(ino, operation, name));
  }

  deletePrepared(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): void {
    this.prepared.delete(this.key(ino, operation, name));
  }

  deleteAllForIno(ino: bigint): void {
    const prefix = `${ino}:`;
    for (const key of this.prepared.keys()) {
      if (key.startsWith(prefix)) this.prepared.delete(key);
    }
  }

  private key(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): string {
    return `${ino}:${operation}:${name ?? ""}`;
  }
}

function parsePreparedWriteback(value: string): CfcPreparedWriteback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!isOperation(parsed.operation)) return null;
  if (typeof parsed.expectedGeneration !== "string") return null;
  if (!isRecord(parsed.target)) return null;
  if (!isRecord(parsed.labels)) return null;
  return parsed as CfcPreparedWriteback;
}

function parseFinalizedWriteback(value: string): CfcFinalizedWriteback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!isOperation(parsed.operation)) return null;
  if (typeof parsed.committedGeneration !== "string") return null;
  return parsed as CfcFinalizedWriteback;
}

function isOperation(value: unknown): value is CfcWritebackOperation {
  return value === "write" || value === "truncate" ||
    value === "create" || value === "mkdir" ||
    value === "unlink" || value === "rmdir" ||
    value === "rename-source" || value === "rename-destination" ||
    value === "symlink";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preparedGeneration(prepared: CfcPreparedWriteback): string {
  return `prepared:sha256:${
    encodeHex(
      sha256(new TextEncoder().encode(canonicalCfcJsonStringify(prepared))),
    )
  }`;
}

function labelOrFail(label: CfcLabel | undefined): CfcLabel {
  return label ?? cfcFailClosedLabel();
}

function metadataLabelsFor(
  prepared: CfcPreparedWriteback,
  primaryLabel: CfcLabel,
): CfcMetadataLabels {
  const preparedMetadata = prepared.labels.metadataLabels ?? {};
  const fallback = labelOrFail(primaryLabel);
  return {
    type: labelOrFail(preparedMetadata.type ?? fallback),
    mode: labelOrFail(preparedMetadata.mode ?? fallback),
    size: labelOrFail(preparedMetadata.size ?? fallback),
    mtime: labelOrFail(preparedMetadata.mtime ?? fallback),
    ctime: labelOrFail(preparedMetadata.ctime ?? fallback),
    generation: labelOrFail(preparedMetadata.generation ?? fallback),
    uid: labelOrFail(preparedMetadata.uid ?? fallback),
    gid: labelOrFail(preparedMetadata.gid ?? fallback),
    nlink: labelOrFail(preparedMetadata.nlink ?? fallback),
    inode: labelOrFail(preparedMetadata.inode ?? fallback),
  };
}

const emptyDerivedSlots = (): CfcDerivedSlotsAnnotation => ({
  version: 1 as const,
  slots: [],
  status: "no-trusted-derived-slots" as const,
});

function preparedRef(
  ref: CfcProjectionRef,
  generation: string,
): CfcProjectionRef {
  return { ...ref, generation };
}

export function applyPreparedExistingWrite(
  tree: FsTree,
  ino: bigint,
  prepared: CfcPreparedWriteback,
): void {
  const existing = tree.getCfcAnnotation(ino);
  if (!existing) return;
  const generation = preparedGeneration(prepared);
  const contentLabel = labelOrFail(prepared.labels.contentLabel);
  tree.setCfcAnnotation(ino, {
    version: 1,
    ref: preparedRef(existing.ref, generation),
    generation,
    contentLabel,
    metadataLabels: metadataLabelsFor(prepared, contentLabel),
    namespaceLabel: existing.namespaceLabel,
    entries: existing.entries,
    derivedSlots: emptyDerivedSlots(),
    callable: existing.callable,
    symlink: existing.symlink,
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + existing.ref.path.map(String).join("/")],
    },
  });
}

export function applyPreparedParent(
  tree: FsTree,
  parentIno: bigint,
  prepared: CfcPreparedWriteback,
): void {
  const existing = tree.getCfcAnnotation(parentIno);
  if (!existing) return;
  const generation = preparedGeneration(prepared);
  const namespaceLabel = labelOrFail(prepared.labels.namespaceLabel);
  tree.setCfcAnnotation(parentIno, {
    ...existing,
    ref: preparedRef(existing.ref, generation),
    generation,
    namespaceLabel,
    metadataLabels: metadataLabelsFor(prepared, namespaceLabel),
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + existing.ref.path.map(String).join("/")],
    },
  });
}

export function applyPreparedCreate(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  kind: "file" | "dir",
  prepared: CfcPreparedWriteback,
): bigint {
  applyPreparedParent(tree, parentIno, prepared);
  const childIno = kind === "dir"
    ? tree.addDir(parentIno, name, "object")
    : tree.addFile(parentIno, name, "", "string");
  const parent = tree.getCfcAnnotation(parentIno);
  if (!parent) return childIno;

  const generation = parent.generation;
  const projection: CfcProjectionKind = kind === "dir" ? "dir" : "value";
  const childRef: CfcProjectionRef = {
    ...parent.ref,
    path: [...parent.ref.path, name],
    projection,
    generation,
  };
  const contentLabel = kind === "dir"
    ? undefined
    : labelOrFail(prepared.labels.contentLabel);
  const namespaceLabel = kind === "dir"
    ? labelOrFail(prepared.labels.namespaceLabel)
    : undefined;
  const primaryLabel = contentLabel ?? namespaceLabel ?? cfcFailClosedLabel();
  const childAnnotation: CfcNodeAnnotation = {
    version: 1,
    ref: childRef,
    generation,
    contentLabel,
    namespaceLabel,
    entries: kind === "dir" ? { version: 1, entries: [] } : undefined,
    metadataLabels: metadataLabelsFor(prepared, primaryLabel),
    derivedSlots: emptyDerivedSlots(),
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + childRef.path.map(String).join("/")],
    },
  };
  tree.setCfcAnnotation(childIno, childAnnotation);
  tree.setCfcEntryAnnotation(
    parentIno,
    name,
    {
      name,
      nameDigest: `pending:${name}`,
      childRef,
      kind,
      nameLabel: labelOrFail(prepared.labels.nameLabel),
      existenceLabel: labelOrFail(prepared.labels.existenceLabel),
      metadataLabels: childAnnotation.metadataLabels,
    } satisfies CfcDirectoryEntryAnnotation,
  );
  return childIno;
}

export function applyPreparedSymlink(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  target: string,
  prepared: CfcPreparedWriteback,
): bigint {
  applyPreparedParent(tree, parentIno, prepared);
  const childIno = tree.addSymlink(parentIno, name, target);
  const parent = tree.getCfcAnnotation(parentIno);
  if (!parent) return childIno;

  const generation = parent.generation;
  const childRef: CfcProjectionRef = {
    ...parent.ref,
    path: [...parent.ref.path, name],
    projection: "symlink",
    generation,
  };
  const contentLabel = labelOrFail(prepared.labels.contentLabel);
  const childAnnotation: CfcNodeAnnotation = {
    version: 1,
    ref: childRef,
    generation,
    contentLabel,
    metadataLabels: metadataLabelsFor(prepared, contentLabel),
    derivedSlots: emptyDerivedSlots(),
    symlink: {
      version: 1,
      target,
      linkTextLabel: labelOrFail(prepared.labels.linkTextLabel),
      targetIdentityLabel: labelOrFail(prepared.labels.targetIdentityLabel),
    },
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + childRef.path.map(String).join("/")],
    },
  };
  tree.setCfcAnnotation(childIno, childAnnotation);
  tree.setCfcEntryAnnotation(
    parentIno,
    name,
    {
      name,
      nameDigest: `pending:${name}`,
      childRef,
      kind: "symlink",
      nameLabel: labelOrFail(prepared.labels.nameLabel),
      existenceLabel: labelOrFail(prepared.labels.existenceLabel),
      metadataLabels: childAnnotation.metadataLabels,
    } satisfies CfcDirectoryEntryAnnotation,
  );
  return childIno;
}
