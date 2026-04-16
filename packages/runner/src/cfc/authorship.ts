import type { CfcLabelView } from "./label-view.ts";

export type CfcAuthorshipState = "verified" | "unverified" | "unknown";

export const DEFAULT_AUTHORSHIP_KIND = "authored-by";

const AUTHOR_FIELDS = [
  "subject",
  "author",
  "authorId",
  "sender",
  "senderId",
  "user",
  "userId",
  "id",
] as const;

const primitiveToString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

const objectField = (
  value: Record<string, unknown>,
  field: string,
): string | undefined => primitiveToString(value[field]);

const objectStringFields = (
  value: unknown,
  fields: readonly string[],
): string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  return fields.flatMap((field) => {
    const fieldValue = objectField(record, field);
    return fieldValue === undefined ? [] : [fieldValue];
  });
};

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

const authorIdsForClaim = (author: unknown): string[] => {
  const primitive = primitiveToString(author);
  if (primitive !== undefined) {
    return [primitive];
  }
  return uniqueStrings(objectStringFields(author, AUTHOR_FIELDS));
};

export const integrityAtomMatchesAuthor = (
  atom: unknown,
  author: unknown,
  kind: string = DEFAULT_AUTHORSHIP_KIND,
): boolean => {
  const authorIds = authorIdsForClaim(author);
  if (authorIds.length === 0) {
    return false;
  }

  if (typeof atom === "string") {
    return authorIds.some((authorId) => atom === `${kind}:${authorId}`);
  }

  if (typeof atom !== "object" || atom === null || Array.isArray(atom)) {
    return false;
  }

  const atomRecord = atom as Record<string, unknown>;
  if (objectField(atomRecord, "kind") !== kind) {
    return false;
  }

  return AUTHOR_FIELDS.some((field) => {
    const atomAuthor = objectField(atomRecord, field);
    return atomAuthor !== undefined && authorIds.includes(atomAuthor);
  });
};

const hasAnyIntegrity = (view: CfcLabelView): boolean =>
  view.entries.some((entry) =>
    Array.isArray(entry.label.integrity) && entry.label.integrity.length > 0
  );

export const authorshipStateForLabel = (
  view: CfcLabelView | undefined,
  author: unknown,
  kind: string = DEFAULT_AUTHORSHIP_KIND,
): CfcAuthorshipState => {
  if (!view || authorIdsForClaim(author).length === 0) {
    return "unknown";
  }

  for (const entry of view.entries) {
    const integrity = entry.label.integrity;
    if (!Array.isArray(integrity)) {
      continue;
    }
    if (
      integrity.some((atom) => integrityAtomMatchesAuthor(atom, author, kind))
    ) {
      return "verified";
    }
  }

  return hasAnyIntegrity(view) ? "unverified" : "unknown";
};
