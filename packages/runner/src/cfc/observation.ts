import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import {
  cfcLabelPathPrefixMatches,
  type CfcLabelView,
} from "./label-view-core.ts";

export type CfcObservedConfidentiality = readonly unknown[];
export type CfcObservationMaxConfidentiality =
  | readonly unknown[]
  | undefined;

// Marker confidentiality atom injected when a cell's label could not be read
// because a metadata read ERRORED (as opposed to being cleanly absent), so the
// LLM-observation path can fail CLOSED on read errors (audit item 22): a
// swallowed read error must not let confidential data serialize to the model as
// if it were public. `cfcObservationFitsCeiling` treats this marker as
// UNGRANTABLE — an observation carrying it never fits a ceiling, even one that
// names the marker, so it cannot be allow-listed by an author-supplied ceiling.
export const CFC_LABEL_READ_FAILED_ATOM = "cfc:label-read-failed";

export interface CfcOpaqueLink {
  "@link": string;
}

export interface CfcObservationResult<T = unknown> {
  value: T;
  observedConfidentiality: CfcObservedConfidentiality;
}

export const uniqueCfcAtoms = (
  atoms: Iterable<unknown>,
): ImmutableJSONValue[] => {
  const unique: ImmutableJSONValue[] = [];
  for (const atom of atoms) {
    if (!unique.some((existing) => deepEqual(existing, atom))) {
      unique.push(atom as ImmutableJSONValue);
    }
  }
  return unique;
};

export const joinCfcObservedConfidentiality = (
  parts: Iterable<readonly unknown[] | undefined>,
): CfcObservedConfidentiality => {
  const joined: unknown[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      joined.push(...part);
    }
  }
  return uniqueCfcAtoms(joined);
};

export const cfcConfidentialityForObservationNode = (
  options: {
    schema?: JSONSchema;
    labelView?: CfcLabelView;
    logicalPath?: readonly string[];
  },
): CfcObservedConfidentiality => {
  const joined: unknown[] = [];
  const logicalPath = options.logicalPath ?? [];

  if (isRecord(options.schema) && isRecord(options.schema.ifc)) {
    joined.push(...(options.schema.ifc.confidentiality ?? []));
  }

  if (options.labelView !== undefined) {
    for (const entry of options.labelView.entries) {
      if (cfcLabelPathPrefixMatches(entry.path, logicalPath)) {
        joined.push(...(entry.label.confidentiality ?? []));
      }
    }
  }

  return uniqueCfcAtoms(joined);
};

export const cfcObservationFitsCeiling = (
  confidentiality: readonly unknown[],
  observationMaxConfidentiality: CfcObservationMaxConfidentiality,
): boolean => {
  // undefined means no ceiling. A declared but empty ceiling means "public
  // only": no confidential atom is permitted. Public data (no confidentiality
  // atoms) fits any ceiling, including the empty one.
  if (observationMaxConfidentiality === undefined) {
    return true;
  }

  // The read-failed marker is UNGRANTABLE: an observation that carries it never
  // fits a declared ceiling, even one that names the marker. The atom is an
  // exported string, so an author-supplied ceiling could otherwise allow-list it
  // and defeat the fail-closed redaction (audit item 22). Reject it explicitly
  // before the per-atom membership check rather than relying on its absence.
  if (
    confidentiality.some((value) =>
      deepEqual(value, CFC_LABEL_READ_FAILED_ATOM)
    )
  ) {
    return false;
  }

  return confidentiality.every((value) =>
    observationMaxConfidentiality.some((allowed) => deepEqual(allowed, value))
  );
};

export const cfcJsonPointerForPath = (
  path: readonly (string | number)[],
): string =>
  path.length === 0
    ? ""
    : `/${
      path.map((segment) =>
        String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
      ).join("/")
    }`;

export const cfcOpaqueLinkForPath = (
  opaqueHandleId: string,
  path: readonly (string | number)[],
): CfcOpaqueLink => ({
  "@link": `opaque:${encodeURIComponent(opaqueHandleId)}${
    path.length === 0 ? "" : `#${cfcJsonPointerForPath(path)}`
  }`,
});
