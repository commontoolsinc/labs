/**
 * Content-addressed label documents: the `cid:` documents a version-2 CFC
 * envelope names its labels by, the canonical content that decides a
 * label's document id, the inline limit below which a label stays inline,
 * and the realm-wide registry of verified label documents. The design is
 * `docs/specs/content-addressed-cfc-labels.md`. Nothing here reads
 * storage; resolution through a transaction is `metadata.ts`.
 */

import { taggedHashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { canonicalizeCfcLabel } from "./canonical.ts";
import type { IFCLabel } from "./label-view-core.ts";
import { onSchemaRegistryClear } from "../schema-registry.ts";
import type {
  CfcLabelReference,
  LabelMapEntry,
  StoredLabelMapEntry,
} from "./types.ts";

/**
 * The byte length of a label's canonical JSON above which a version-2
 * envelope stores it by reference. A reference is 63 bytes, so below two
 * references' worth the saving is under half the label and the document
 * costs more than it saves. Part of the versioned envelope contract: the
 * same label takes the same form wherever it is written, so it hashes to
 * one document rather than existing as two spellings.
 */
export const CFC_LABEL_INLINE_LIMIT = 128;

const CID_PREFIX = "cid:";

/** Whether a stored entry's label is a reference rather than an inline label. */
export const isCfcLabelReference = (
  value: unknown,
): value is CfcLabelReference =>
  isObjectNotArray(value) && typeof value.$ref === "string" &&
  Object.keys(value).length === 1;

/**
 * The document hash a label reference names, or `undefined` for a reference
 * outside the `cid:` namespace. The hash is the part after the prefix, the
 * form `schemaHash` carries and `cid:<hash>` documents are addressed by.
 */
export const parseCfcLabelReference = (
  reference: CfcLabelReference,
): string | undefined =>
  reference.$ref.startsWith(CID_PREFIX) &&
    reference.$ref.length > CID_PREFIX.length
    ? reference.$ref.slice(CID_PREFIX.length)
    : undefined;

/** The reference a stored entry carries for the label document `hash` names. */
export const formatCfcLabelReference = (hash: string): CfcLabelReference => ({
  $ref: `${CID_PREFIX}${hash}`,
});

/**
 * The canonical content of a label document: the label with its clauses
 * normalized and every `undefined` member dropped, so a label written with
 * `integrity: undefined` and one written without the member are one
 * document. Only the two label members survive; nothing else of the input
 * reaches the document.
 */
export const cfcLabelDocumentContent = (label: IFCLabel): IFCLabel => {
  const canonical = canonicalizeCfcLabel(label);
  const content: IFCLabel = {};
  if (canonical.confidentiality !== undefined) {
    content.confidentiality = canonical.confidentiality;
  }
  if (canonical.integrity !== undefined) {
    content.integrity = canonical.integrity;
  }
  return content;
};

/** The id hash of the label document holding `content`. */
export const cfcLabelDocumentHash = (content: IFCLabel): string =>
  taggedHashStringOf(content);

/**
 * Whether a label's canonical content is stored by reference in a
 * version-2 envelope: its JSON is longer than {@link CFC_LABEL_INLINE_LIMIT}.
 * A pure function of the content, which is what makes the stored form
 * canonical.
 */
export const cfcLabelTakesReference = (content: IFCLabel): boolean =>
  JSON.stringify(content).length > CFC_LABEL_INLINE_LIMIT;

/** Thrown when a label document's content does not hash to its claimed id. */
export class CfcLabelDocumentHashMismatchError extends Error {
  constructor(readonly claimed: string, readonly actual: string) {
    super(
      `CFC label document content does not match its id: claimed \`${claimed}\`, hashed \`${actual}\``,
    );
    this.name = "CfcLabelDocumentHashMismatchError";
  }
}

// The realm-wide index from label document hash to verified label, with the
// schema registry's retention: an entry is content-verified at registration
// so it can only ever be the one value its key names, and the index clears
// when the last schema-registry lease releases, so a document resolves for
// as long as a session can read the envelope naming it.
const labelsByHash = new Map<string, IFCLabel>();

onSchemaRegistryClear(() => labelsByHash.clear());

/**
 * Registers `label` as the content of the label document `hash` names,
 * verifying the content against the claim first — a mismatch throws
 * {@link CfcLabelDocumentHashMismatchError} and never enters the registry.
 * Returns the registered label. Registering a hash twice is idempotent by
 * construction: only one content can verify against it.
 */
export const registerCfcLabelDocument = (
  hash: string,
  label: IFCLabel,
): IFCLabel => {
  const actual = cfcLabelDocumentHash(label);
  if (actual !== hash) {
    throw new CfcLabelDocumentHashMismatchError(hash, actual);
  }
  const existing = labelsByHash.get(hash);
  if (existing !== undefined) return existing;
  labelsByHash.set(hash, label);
  return label;
};

/**
 * The registered label document for `hash`, or `undefined` when none has
 * been registered. A miss is recoverable — the document may arrive by sync
 * later — which is why a resolution failure is never memoized.
 */
export const lookupCfcLabelDocument = (hash: string): IFCLabel | undefined =>
  labelsByHash.get(hash);

/**
 * The version-2 stored form of resolved entries: each label's canonical
 * content, held inline when it fits under the limit and otherwise replaced
 * by a reference to the document `stage` installs for it. `stage` returns
 * the staged document's id (`cid:<hash>`), and the content is registered
 * under that hash so the label resolves in this session before the commit
 * lands. Entries keep their `path`, `origin`, and `observes` inline.
 */
export const storedLabelMapEntries = (
  entries: readonly LabelMapEntry[],
  stage: (content: IFCLabel) => string,
): StoredLabelMapEntry[] =>
  entries.map((entry) => {
    const content = cfcLabelDocumentContent(entry.label);
    if (!cfcLabelTakesReference(content)) {
      return { ...entry, label: content };
    }
    const id = stage(content);
    const reference: CfcLabelReference = { $ref: id };
    const hash = parseCfcLabelReference(reference);
    if (hash === undefined) {
      throw new Error(
        `staged label document id \`${id}\` is outside the cid: namespace`,
      );
    }
    registerCfcLabelDocument(hash, content);
    return { ...entry, label: reference };
  });

/**
 * The label document hashes a stored envelope's entries reference, in
 * entry order and deduplicated. A reference outside the `cid:` namespace
 * contributes nothing here; resolution refuses it.
 */
export const referencedCfcLabelDocumentHashes = (
  entries: readonly StoredLabelMapEntry[],
): string[] => {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isCfcLabelReference(entry.label)) continue;
    const hash = parseCfcLabelReference(entry.label);
    if (hash === undefined || seen.has(hash)) continue;
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
};
