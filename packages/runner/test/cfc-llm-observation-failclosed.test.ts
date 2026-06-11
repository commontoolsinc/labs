import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cfcLabelViewForCell,
  cfcLabelViewForCellFailClosed,
  cfcLabelViewForCellWithStatus,
} from "../src/cfc/label-view.ts";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  cfcConfidentialityForObservationNode,
  cfcObservationFitsCeiling,
} from "../src/cfc/observation.ts";

// Audit item 22 — the LLM observation path must fail CLOSED on a metadata READ
// ERROR. `cfcConfidentialityForObservationNode` treats an absent label as
// unconfidential (public), and `cfcObservationFitsCeiling` lets public data
// through any ceiling. So if acquiring a cell's label *errors* and is swallowed
// to `undefined`, confidential data would serialize to the LLM as if public.
// `cfcLabelViewForCellFailClosed` taints the observation with a sentinel atom
// (absent from every real ceiling) so the node is redacted instead.
//
// The renderer's shared `cfcLabelViewForCell` seam is intentionally left
// unchanged (it already treats a missing label as blocked) — only the LLM
// egress path adopts the fail-closed variant.

const cellWhoseMetadataReadErrors = {
  getAsNormalizedFullLink: () => ({
    id: "of:labelled-cell",
    space: "did:key:test",
    type: "application/json",
    path: [],
  }),
  runtime: {
    readTx: () => ({
      readOrThrow: () => {
        throw new Error("storage read error");
      },
      readValueOrThrow: () => {
        throw new Error("storage read error");
      },
    }),
  },
};

const cellWithAbsentMetadata = {
  getAsNormalizedFullLink: () => ({
    id: "of:unlabelled-cell",
    space: "did:key:test",
    type: "application/json",
    path: [],
  }),
  runtime: {
    readTx: () => ({
      // No `["cfc"]` doc: a clean read returning undefined (NOT an error).
      readOrThrow: () => undefined,
      readValueOrThrow: () => undefined,
    }),
  },
};

const REAL_CEILING = ["some-real-confidentiality-atom"];

describe("LLM observation fail-closed on metadata read error (audit 22)", () => {
  it("reports readFailed when a metadata read errors (vs. cleanly absent)", () => {
    expect(
      cfcLabelViewForCellWithStatus(cellWhoseMetadataReadErrors).readFailed,
    )
      .toBe(true);
    expect(cfcLabelViewForCellWithStatus(cellWithAbsentMetadata).readFailed)
      .toBe(false);
  });

  it("demonstrates the fail-OPEN: the plain seam swallows the error to undefined", () => {
    // This is the renderer-safe behavior (undefined = blocked there), but for
    // the LLM observer undefined means "unconfidential" → fits any ceiling.
    const view = cfcLabelViewForCell(cellWhoseMetadataReadErrors);
    expect(view).toBeUndefined();
    const observed = cfcConfidentialityForObservationNode({
      labelView: view,
      logicalPath: ["0"],
    });
    // Fail-open: a read error looks like public data and is admitted.
    expect(cfcObservationFitsCeiling(observed, REAL_CEILING)).toBe(true);
  });

  it("fails CLOSED: the fail-closed seam taints the node so it is redacted", () => {
    const view = cfcLabelViewForCellFailClosed(cellWhoseMetadataReadErrors);
    const observed = cfcConfidentialityForObservationNode({
      labelView: view,
      logicalPath: ["0"],
    });
    expect(observed).toContain(CFC_LABEL_READ_FAILED_ATOM);
    // The marker is absent from any real ceiling → node does not fit → redact.
    expect(cfcObservationFitsCeiling(observed, REAL_CEILING)).toBe(false);
  });

  it("treats the read-failed marker as UNGRANTABLE (can't be allow-listed)", () => {
    // A caller could otherwise name the marker atom in their own ceiling to
    // re-open the fail-open. The marker must never fit a ceiling, even one that
    // lists it (or lists everything).
    const observed = [CFC_LABEL_READ_FAILED_ATOM];
    expect(cfcObservationFitsCeiling(observed, [CFC_LABEL_READ_FAILED_ATOM]))
      .toBe(false);
    expect(
      cfcObservationFitsCeiling(observed, [
        CFC_LABEL_READ_FAILED_ATOM,
        ...REAL_CEILING,
      ]),
    ).toBe(false);
  });

  it("does NOT over-redact cleanly-unlabelled data (no error → no sentinel)", () => {
    const view = cfcLabelViewForCellFailClosed(cellWithAbsentMetadata);
    expect(view).toBeUndefined();
    const observed = cfcConfidentialityForObservationNode({
      labelView: view,
      logicalPath: ["0"],
    });
    expect(observed).toEqual([]);
    // Absent metadata stays public (unchanged behavior) — fits any ceiling.
    expect(cfcObservationFitsCeiling(observed, REAL_CEILING)).toBe(true);
  });
});
