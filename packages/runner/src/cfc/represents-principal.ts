/**
 * How a CFC label names a principal in its integrity, and which principal a
 * label says its value represents.
 *
 * This module is the one definition of a principal claim that both sides use.
 * The runtime's write check (`prepare.ts`) refuses a pattern-authored claim in
 * any spelling a reader could take for one naming a principal, and the readers
 * accept only the canonical spelling: a trusted surface checking an author
 * claim asks this of the claim's label, `cf-cfc-authorship` on the main thread
 * and the HTML renderer's text integrity boundary in the worker. The module
 * depends on nothing but types from `@commonfabric/api` and the label view,
 * `@commonfabric/utils`, and `@commonfabric/identity/did`, so that either can
 * import it without the rest of the CFC machinery.
 */
import type { DID, PrincipalClaimKind } from "@commonfabric/api";
import { isWellFormedDID } from "@commonfabric/identity/did";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { CfcLabelView } from "./label-view-core.ts";

export type { PrincipalClaimKind };

const REPRESENTS_PRINCIPAL = "represents-principal";

/**
 * The kinds of integrity atom that name a principal as their `subject`: the
 * current-principal claim family. A pattern may attach one only with the
 * subject left for the runtime to resolve, which `prepare.ts` checks with
 * {@link principalClaimSpelling} and {@link subjectResemblesPrincipal}.
 */
export const PRINCIPAL_CLAIM_KINDS: ReadonlySet<string> = new Set<
  PrincipalClaimKind
>([
  "authored-by",
  REPRESENTS_PRINCIPAL,
]);

/**
 * How `atom` is spelled if it could be taken for a principal claim: `"object"`
 * for an object whose `kind` is one of {@link PRINCIPAL_CLAIM_KINDS}, and
 * `"string"` for a string that begins with one of those kinds and a colon,
 * ignoring case and surrounding whitespace. `undefined` for anything else.
 *
 * The recognition is deliberately wider than {@link principalClaimSubject}:
 * the write check refuses every spelling here that is not the canonical one,
 * so a reader anywhere that accepts more than the canonical form still reads
 * nothing a pattern wrote.
 */
export const principalClaimSpelling = (
  atom: unknown,
): "object" | "string" | undefined => {
  if (typeof atom === "string") {
    const text = atom.trim().toLowerCase();
    for (const kind of PRINCIPAL_CLAIM_KINDS) {
      if (text.startsWith(`${kind}:`)) return "string";
    }
    return undefined;
  }
  if (atom === null || typeof atom !== "object") return undefined;
  const kind = (atom as { kind?: unknown }).kind;
  return typeof kind === "string" && PRINCIPAL_CLAIM_KINDS.has(kind)
    ? "object"
    : undefined;
};

/**
 * The subject a principal claim of `kind` names, read the one way every reader
 * reads it: `atom` is an object whose `kind` is exactly `kind`, and its
 * `subject` is a non-empty string, returned as written. Any other spelling,
 * the `<kind>:<subject>` string form among them, names nothing.
 */
export const principalClaimSubject = (
  atom: unknown,
  kind: string,
): string | undefined => {
  if (!isObjectNotArray(atom)) return undefined;
  const record = atom as Record<string, unknown>;
  return record.kind === kind && typeof record.subject === "string" &&
      record.subject.length > 0
    ? record.subject
    : undefined;
};

/**
 * Whether a claim subject could be taken for a principal: a string that
 * begins with `did:` once surrounding whitespace is removed and case ignored.
 * The write check refuses a pattern-authored subject for which this holds.
 */
export const subjectResemblesPrincipal = (subject: unknown): boolean =>
  typeof subject === "string" &&
  subject.trim().toLowerCase().startsWith("did:");

/**
 * The DID a `represents-principal` integrity atom names: the subject
 * {@link principalClaimSubject} reads, when it is a well-formed DID as
 * written. `undefined` for any other atom, including the string form and a
 * subject with surrounding whitespace.
 */
export const representsPrincipalSubject = (
  atom: unknown,
): string | undefined => {
  const subject = principalClaimSubject(atom, REPRESENTS_PRINCIPAL);
  return isWellFormedDID(subject) ? subject : undefined;
};

/**
 * Every DID the `represents-principal` atoms of `entries` name, in order. An
 * entry a link carries from the document it points to (`observes` of
 * `followRef`) is skipped: it says whom that document represents, not whom
 * the one holding the link does.
 */
export const representsPrincipalSubjects = (
  entries: CfcLabelView["entries"],
): string[] =>
  entries.flatMap((entry) =>
    entry.observes === "followRef"
      ? []
      : (entry.label.integrity ?? []).flatMap((atom) => {
        const subject = representsPrincipalSubject(atom);
        return subject === undefined ? [] : [subject];
      })
  );

/**
 * The DIDs that could be the principal the value labeled by `view` represents,
 * as an author claim is checked against: each distinct DID a
 * `represents-principal` atom names in the entries
 * {@link representsPrincipalEntries} reads, in order of first appearance.
 * `nameWritten` says whether the value holds a name its owner wrote, as
 * {@link isWrittenProfileName} decides it. One DID is the principal. None means
 * the label names no principal. More than one means it names no single
 * principal, and a claim resting on it must not verify.
 */
export const authorPrincipalCandidates = (
  view: CfcLabelView | undefined,
  nameWritten: boolean,
): string[] => [
  ...new Set(
    representsPrincipalEntries(view, nameWritten).flatMap((entry) =>
      (entry.label.integrity ?? []).flatMap((atom) => {
        const subject = representsPrincipalSubject(atom);
        return subject === undefined ? [] : [subject];
      })
    ),
  ),
];

/**
 * The entries of `view` a principal claim is read from: those at the root and
 * on top-level fields, where a profile's owner-protected fields carry their
 * owner's atom. Entries deeper down come from documents the value links, and
 * so does an entry a link carries from the document it points to (`observes`
 * of `followRef`): it says whom that document represents, not whom the one
 * holding the link does.
 */
export const principalClaimEntries = (
  view: CfcLabelView | undefined,
): CfcLabelView["entries"] =>
  view === undefined
    ? []
    : view.entries.filter((entry) =>
      entry.path.length <= 1 && entry.observes !== "followRef"
    );

/** The field of a profile whose written value says whose the profile is. */
export const PROFILE_NAME_FIELD = "name";

/**
 * Whether `name`, the value of a profile's `name` field, is a name its owner
 * wrote: a string holding something besides whitespace. A field left at its
 * default holds an empty string or nothing.
 */
export const isWrittenProfileName = (name: unknown): boolean =>
  typeof name === "string" && name.trim() !== "";

/**
 * The entries of `view` a `represents-principal` claim is read from.
 *
 * When the value holds a name its owner wrote (`nameWritten`), they are the
 * entries on its `name` field, of any observation class, and the root's own. A
 * written name is its owner's own claim about whose the value is. Any other
 * field still at its default can carry the principal of whichever runtime set
 * that default up, beside the owner's or in its place, so those fields do not
 * count.
 *
 * Otherwise they are every entry `view` holds: every path at or beneath the
 * root, and every observation class, an entry a link carried (`followRef`)
 * among them. A value whose entries name two principals names no single one,
 * and a value whose own fields name no one represents whoever a deeper or a
 * link-carried entry names. A view holds payload entries only, so no
 * label-metadata entry is among them.
 */
export const representsPrincipalEntries = (
  view: CfcLabelView | undefined,
  nameWritten: boolean,
): CfcLabelView["entries"] =>
  view === undefined
    ? []
    : nameWritten
    ? view.entries.filter((entry) =>
      (entry.path.length === 1 && entry.path[0] === PROFILE_NAME_FIELD) ||
      (entry.path.length === 0 && entry.observes !== "followRef")
    )
    : view.entries;

/**
 * The principals `view` attests with claims of `kind`, in exactly the form a
 * runtime mints, or `undefined` when a claim it reads is in another form, or
 * any claim there is in the string form. A runtime binds a `{ kind, subject }`
 * atom's subject to its acting principal and refuses a literal DID only in
 * that form, so the string form, a padded subject, or an atom with another key
 * may have been written by someone other than the principal it names. A
 * caller that must know who wrote the attestation, rather than whom a claim is
 * about, refuses those.
 *
 * An `authored-by` principal is counted from the entries
 * {@link principalClaimEntries} names. A `represents-principal` one is counted
 * from the entries {@link representsPrincipalEntries} reads for `nameWritten`,
 * which says whether the value holds a name its owner wrote; `nameWritten`
 * has no effect on an `authored-by` claim. Every entry
 * {@link principalClaimEntries} names is checked for a claim in another form
 * whatever is counted, and so is every entry counted.
 */
export const exactPrincipalAttestations = (
  view: CfcLabelView | undefined,
  kind: PrincipalClaimKind,
  nameWritten: boolean,
): DID[] | undefined => {
  const principals = new Set<DID>();
  const counted = new Set(
    kind === REPRESENTS_PRINCIPAL
      ? representsPrincipalEntries(view, nameWritten)
      : principalClaimEntries(view),
  );
  const checked = new Set([...principalClaimEntries(view), ...counted]);
  // In the view's own order, so the principals are listed as they first
  // appear there.
  for (const entry of view?.entries ?? []) {
    if (!checked.has(entry)) continue;
    for (const atom of entry.label.integrity ?? []) {
      const spelling = principalClaimSpelling(atom);
      if (spelling === undefined) continue;
      // Any string-form claim is refused: no reader counts one, and the
      // write check refuses a pattern writing one.
      if (spelling === "string") return undefined;
      if ((atom as { kind?: unknown }).kind !== kind) continue;
      const subject = principalClaimSubject(atom, kind);
      if (
        !isWellFormedDID(subject) || Object.keys(atom as object).length !== 2
      ) {
        return undefined;
      }
      if (counted.has(entry)) principals.add(subject);
    }
  }
  return [...principals];
};
