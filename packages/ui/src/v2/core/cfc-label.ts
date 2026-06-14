/**
 * Shared helpers for reading CFC labels on the trusted main thread.
 *
 * These let a trusted component query a cell's runtime-attested CFC label (over
 * IPC) and pull the owning principal out of a `represents-principal` integrity
 * atom. `cf-cfc-authorship` has its own root-scoped, authorship-specific label
 * reading; this module is intentionally narrower (owner-principal extraction,
 * scanning every entry) and is the shared home for that concern. A future pass
 * can fold the authorship reader onto these primitives.
 */
import type { CfcLabelView } from "@commonfabric/runner/cfc";

export type { CfcLabelView };

export type CfcLabelQueryable = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

export type CfcLabelResolvable = {
  resolveAsCell(): Promise<unknown> | unknown;
};

const REPRESENTS_PRINCIPAL = "represents-principal";

export const canQueryCfcLabel = (value: unknown): value is CfcLabelQueryable =>
  typeof value === "object" && value !== null &&
  typeof (value as { getCfcLabel?: unknown }).getCfcLabel === "function";

const canResolveAsCell = (value: unknown): value is CfcLabelResolvable =>
  typeof value === "object" && value !== null &&
  typeof (value as { resolveAsCell?: unknown }).resolveAsCell === "function";

/**
 * Reads a cell's CFC label view, resolving the cell first if the handle itself
 * doesn't expose `getCfcLabel` (e.g. an unresolved link). Returns undefined if
 * no label can be read.
 */
export const readCfcLabelView = async (
  value: unknown,
): Promise<CfcLabelView | undefined> => {
  if (canQueryCfcLabel(value)) {
    return await value.getCfcLabel();
  }
  if (canResolveAsCell(value)) {
    const resolved = await value.resolveAsCell();
    if (canQueryCfcLabel(resolved)) {
      return await resolved.getCfcLabel();
    }
  }
  return undefined;
};

/**
 * Extracts the owning principal DID from a `represents-principal` integrity atom
 * anywhere in the label. Owner-protected profile fields (`name`/`avatar`/…)
 * carry this atom at their own paths rather than the root, so every entry is
 * scanned. Supports both the object form (`{ kind, subject }`) and the string
 * form (`represents-principal:<did>`). Returns the first concrete DID found.
 */
export const ownerPrincipalFromLabel = (
  view: CfcLabelView | undefined,
): string | undefined => {
  if (!view) {
    return undefined;
  }
  for (const entry of view.entries) {
    for (const atom of entry.label.integrity ?? []) {
      if (typeof atom === "string") {
        if (atom.startsWith(`${REPRESENTS_PRINCIPAL}:`)) {
          const subject = atom.slice(REPRESENTS_PRINCIPAL.length + 1).trim();
          if (subject.length > 0) {
            return subject;
          }
        }
        continue;
      }
      if (typeof atom !== "object" || atom === null || Array.isArray(atom)) {
        continue;
      }
      const record = atom as Record<string, unknown>;
      if (
        record.kind === REPRESENTS_PRINCIPAL &&
        typeof record.subject === "string" && record.subject.trim().length > 0
      ) {
        // Trim to match the string-form branch — both yield a normalized DID.
        return record.subject.trim();
      }
    }
  }
  return undefined;
};
