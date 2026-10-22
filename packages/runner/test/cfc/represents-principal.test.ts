import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "../../src/cfc/label-view-core.ts";
import {
  authorPrincipalCandidates,
  exactPrincipalAttestations,
  isWrittenProfileName,
} from "../../src/cfc/represents-principal.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkoTHERoTHERoTHERoTHERoTHERoTHERoTHERoTHERoT";

const view = (entries: CfcLabelView["entries"]): CfcLabelView => ({
  version: 1,
  entries,
});

const representsAt = (path: string[], subject: string) => ({
  path,
  label: { integrity: [{ kind: "represents-principal", subject }] },
});

/**
 * A profile's label as a runtime that set up its defaults can leave it: the
 * owner on `name`, the owner and `OTHER_DID` on `avatar`, and `OTHER_DID`
 * alone on `inbox`.
 */
const stamped = () =>
  view([
    representsAt(["name"], DID),
    {
      path: ["avatar"],
      label: {
        integrity: [
          { kind: "represents-principal", subject: DID },
          { kind: "represents-principal", subject: OTHER_DID },
        ],
      },
    },
    representsAt(["inbox"], OTHER_DID),
  ]);

describe("represents-principal", () => {
  describe("isWrittenProfileName", () => {
    it("returns `true` for a string holding more than whitespace", () => {
      expect(isWrittenProfileName("Ada")).toBe(true);
      expect(isWrittenProfileName(" Ada ")).toBe(true);
    });

    it("returns `false` for an empty or blank string, and for anything but a string", () => {
      for (
        const name of ["", "  ", "\n", undefined, null, 1, { first: "Ada" }]
      ) {
        expect(isWrittenProfileName(name)).toBe(false);
      }
    });
  });

  describe("authorPrincipalCandidates", () => {
    it("returns the DID the root and `name` name for a value whose owner wrote a name", () => {
      expect(authorPrincipalCandidates(stamped(), true)).toEqual([DID]);
      expect(
        authorPrincipalCandidates(
          view([representsAt([], DID), ...stamped().entries]),
          true,
        ),
      ).toEqual([DID]);
    });

    it("returns every DID the fields name for the same value with no written name", () => {
      expect(authorPrincipalCandidates(stamped(), false)).toEqual([
        DID,
        OTHER_DID,
      ]);
    });

    it("returns both DIDs for a written name whose own label names two", () => {
      const label = view([
        representsAt(["name"], DID),
        representsAt(["name"], OTHER_DID),
        representsAt(["bio"], DID),
      ]);
      expect(authorPrincipalCandidates(label, true)).toEqual([DID, OTHER_DID]);
    });

    it("does not count what a link carried onto `name` for a value whose owner wrote a name", () => {
      const label = view([
        { ...representsAt(["name"], OTHER_DID), observes: "followRef" },
        representsAt(["bio"], DID),
      ]);
      expect(authorPrincipalCandidates(label, true)).toEqual([]);
    });

    it("returns the DID a profile's field atoms name when the root has none", () => {
      // A message's link to a Fabric profile: the root holds the message's own
      // `authored-by`, and the profile's owner-protected fields their owner.
      const label = view([
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: OTHER_DID }] },
        },
        representsAt(["avatar"], DID),
        representsAt(["bio"], DID),
        representsAt(["elements"], DID),
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([DID]);
    });

    it("returns the root's DID for an author labeled only at its root", () => {
      const label = view([representsAt([], DID)]);
      expect(authorPrincipalCandidates(label, false)).toEqual([DID]);
    });

    it("returns one DID when the root and a top-level field agree", () => {
      const label = view([representsAt([], DID), representsAt(["name"], DID)]);
      expect(authorPrincipalCandidates(label, false)).toEqual([DID]);
    });

    it("returns both DIDs when the root and a top-level field disagree", () => {
      // A link slot that is itself labeled with the principal who wrote it,
      // holding a profile someone else owns.
      const label = view([
        representsAt([], OTHER_DID),
        representsAt(["name"], DID),
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([OTHER_DID, DID]);
    });

    it("returns both DIDs when top-level fields disagree", () => {
      const label = view([
        representsAt(["name"], DID),
        representsAt(["avatar"], OTHER_DID),
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([DID, OTHER_DID]);
    });

    it("does not count atoms below the top-level fields", () => {
      // A profile that pins a piece owned by someone else holds a copy of that
      // piece's label below the field that links it.
      const label = view([
        representsAt(["name"], DID),
        representsAt(["elements"], DID),
        representsAt(["elements", "0", "cell"], OTHER_DID),
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([DID]);
    });

    it("returns no DID for a string-form atom", () => {
      // The runtime refuses the string form from a pattern, so a reader that
      // accepted it would trust a claim nothing checked.
      const label = view([
        {
          path: ["name"],
          label: { integrity: [`represents-principal:${DID}`] },
        },
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([]);
    });

    it("returns no DID for a subject that is not a DID as written", () => {
      const label = view([
        representsAt(["name"], ` ${DID}`),
        representsAt(["avatar"], `${DID}\n`),
        representsAt(["bio"], DID.replace("did:", "DID:")),
        representsAt(["elements"], "alice"),
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([]);
    });

    it("does not count an entry a link carries from another document", () => {
      // A document linking Bob's profile at a top-level field holds a copy of
      // that profile's label there, marked as a link's; it says what the link
      // points to, not whom this document represents.
      const label = view([
        representsAt(["name"], DID),
        { ...representsAt(["friend"], OTHER_DID), observes: "followRef" },
        { ...representsAt([], OTHER_DID), observes: "followRef" },
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([DID]);
    });

    it("returns no DID for a label with no represents-principal atom", () => {
      const label = view([
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: DID }] },
        },
      ]);
      expect(authorPrincipalCandidates(label, false)).toEqual([]);
      expect(authorPrincipalCandidates(view([]), false)).toEqual([]);
      expect(authorPrincipalCandidates(undefined, false)).toEqual([]);
    });
  });

  describe("exactPrincipalAttestations", () => {
    it("returns each DID the root and top-level fields attest in the minted form", () => {
      const label = view([
        representsAt([], DID),
        representsAt(["name"], DID),
        representsAt(["bio"], OTHER_DID),
        // Another claim kind names no represented principal.
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: OTHER_DID }] },
        },
        // Below the top-level fields, as authorPrincipalCandidates reads it.
        representsAt(["elements", "0"], "did:key:deeper"),
      ]);
      expect(exactPrincipalAttestations(label, "represents-principal", false))
        .toEqual(
          [DID, OTHER_DID],
        );
      expect(
        exactPrincipalAttestations(undefined, "represents-principal", false),
      )
        .toEqual([]);
    });

    it("refuses a claim in any form the runtime does not mint", () => {
      // No reader counts a string-form or padded claim, and one with another
      // key is read for its subject; a caller that must know who wrote an
      // attestation refuses the whole label for any of them.
      const cases: [
        NonNullable<CfcLabelView["entries"][number]["label"]["integrity"]>[
          number
        ],
        string[],
      ][] = [
        [`represents-principal:${DID}`, []],
        [{ kind: "represents-principal", subject: ` ${DID}` }, []],
        [{ kind: "represents-principal", subject: DID, scope: "x" }, [DID]],
      ];
      for (const [atom, candidates] of cases) {
        const label = view([{ path: ["name"], label: { integrity: [atom] } }]);
        expect(authorPrincipalCandidates(label, false)).toEqual(candidates);
        expect(exactPrincipalAttestations(label, "represents-principal", false))
          .toBeUndefined();
      }
    });

    it("counts a `represents-principal` claim on the root and `name` alone for a value whose owner wrote a name", () => {
      expect(
        exactPrincipalAttestations(stamped(), "represents-principal", true),
      )
        .toEqual([DID]);
      expect(
        exactPrincipalAttestations(stamped(), "represents-principal", false),
      ).toEqual([DID, OTHER_DID]);
    });

    it("refuses a claim in a form the runtime does not mint on any field, whether or not the name is written", () => {
      const label = view([
        representsAt(["name"], DID),
        {
          path: ["bio"],
          label: { integrity: [`represents-principal:${DID}`] },
        },
      ]);
      expect(exactPrincipalAttestations(label, "represents-principal", true))
        .toBeUndefined();
      expect(exactPrincipalAttestations(label, "represents-principal", false))
        .toBeUndefined();
    });

    it("counts an `authored-by` claim on any field whether or not the name is written", () => {
      const label = view([
        {
          path: ["body"],
          label: { integrity: [{ kind: "authored-by", subject: OTHER_DID }] },
        },
      ]);
      expect(exactPrincipalAttestations(label, "authored-by", true)).toEqual([
        OTHER_DID,
      ]);
    });

    it("skips what a link carries and a claim of another kind", () => {
      const label = view([
        representsAt([], DID),
        { ...representsAt(["name"], OTHER_DID), observes: "followRef" },
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: OTHER_DID }] },
        },
      ]);
      expect(exactPrincipalAttestations(label, "represents-principal", false))
        .toEqual(
          [DID],
        );
    });

    it("returns each DID an `authored-by` claim attests when asked for that kind", () => {
      const label = view([
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: DID }] },
        },
        {
          path: ["body"],
          label: { integrity: [{ kind: "authored-by", subject: OTHER_DID }] },
        },
        // A claim of the other kind is skipped.
        representsAt(["name"], "did:key:represented"),
      ]);
      expect(exactPrincipalAttestations(label, "authored-by", false)).toEqual([
        DID,
        OTHER_DID,
      ]);
    });

    it("refuses an `authored-by` claim in any form the runtime does not mint", () => {
      const atoms: NonNullable<
        CfcLabelView["entries"][number]["label"]["integrity"]
      > = [
        `authored-by:${DID}`,
        { kind: "authored-by", subject: ` ${DID}` },
        { kind: "authored-by", subject: DID, scope: "x" },
        { kind: "authored-by", subject: "not-a-did" },
        // A string-form claim of the other kind refuses the label too.
        `represents-principal:${DID}`,
      ];
      for (const atom of atoms) {
        const label = view([
          {
            path: [],
            label: { integrity: [{ kind: "authored-by", subject: DID }] },
          },
          { path: ["body"], label: { integrity: [atom] } },
        ]);
        expect(exactPrincipalAttestations(label, "authored-by", false))
          .toBeUndefined();
      }
    });
  });
});
