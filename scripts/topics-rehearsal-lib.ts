/**
 * Shared plumbing for the Topics content export/restore pair
 * (`topics-export.ts`, `topics-restore.ts`). Both scripts shell out to the
 * `cf` CLI rather than importing runtime internals, so they track the CLI's
 * contract — the surface the rehearsal runbook already teaches — instead of
 * private APIs.
 */

export const repoRoot = new URL("..", import.meta.url).pathname;

/** Run `cf` from the repository root and return stdout; throw on failure. */
export async function cf(args: string[]): Promise<string> {
  const command = new Deno.Command("deno", {
    args: ["task", "--quiet", "cf", ...args],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(
      `cf ${args.join(" ")} exited ${code}\n${err.trim() || out.trim()}`,
    );
  }
  return out;
}

/** Run `cf` and parse its stdout as JSON. */
export async function cfJson<T>(args: string[]): Promise<T> {
  const out = await cf(args);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(
      `cf ${args.join(" ")} did not return JSON:\n${out.slice(0, 500)}`,
    );
  }
}

/** Run `cf piece apply` with a JSON input document on stdin. Apply REPLACES
 * the piece's whole input document (measured in the restore drill — a
 * partial document zeroes every field it omits), so callers pass the
 * complete document, never a fragment. */
export async function cfApply(
  addr: string[],
  inputDoc: Record<string, unknown>,
): Promise<void> {
  const command = new Deno.Command("deno", {
    args: ["task", "--quiet", "cf", "piece", "apply", "-q", ...addr],
    cwd: repoRoot,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(inputDoc)));
  await writer.close();
  const { code, stderr } = await child.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(
      `cf piece apply ${addr.join(" ")} exited ${code}\n${err.trim()}`,
    );
  }
}

/** The authored scalar fields of a topic's argument document. Everything a
 * restore may write and nothing else: `myName` is per-user state and
 * `mentionable` is a structural link into the board, so neither is content. */
export const SCALAR_CONTENT_FIELDS = [
  "title",
  "body",
  "createdAt",
  "createdBy",
  "createdByName",
  "bodyUpdatedAt",
  "bodyUpdatedBy",
] as const;

/** The authored array fields whose elements the store keeps as links to
 * their own entities, so an export must resolve each element. */
export const LINKED_ARRAY_FIELDS = ["comments", "links"] as const;

export type TopicContent =
  & {
    [K in (typeof SCALAR_CONTENT_FIELDS)[number]]?: unknown;
  }
  & { comments: unknown[]; links: unknown[] };

export interface TopicExportRow {
  fid: string;
  patternIdentity: string;
  argumentId: string;
  content: TopicContent;
  /** The argument document exactly as stored, links unresolved — the
   * forensic copy. Restore consumes `content`, never this. */
  rawArgument: unknown;
}

export interface TopicsExport {
  version: 1;
  exportedAt: string;
  snapshot: string;
  spaceDid: string | null;
  board: {
    fid: string;
    patternIdentity: string;
    argumentId: string;
    /** Stored membership links of the board's `topics` array, in order —
     * evidence of membership and order, never a restore payload. */
    topicsLinks: unknown[];
  } | null;
  topics: TopicExportRow[];
  /** Every piece in the snapshot, so "did I select the right ones?" is
   * answerable from the export alone. */
  manifest: { fid: string; patternIdentity: string; resultKeys: string[] }[];
}

/** The known link-valued argument fields a restore handles specially:
 * `mentionable` is re-established with `cf piece link` after the write, and
 * the deprecated `myName` stays retired. */
export const STRUCTURAL_LINK_FIELDS = ["mentionable"] as const;
export const LEGACY_LINK_FIELDS = ["myName"] as const;

export interface RestoreDocument {
  /** The complete input document a restore applies. */
  doc: Record<string, unknown>;
  /** Link fields present in the raw argument that the caller re-links. */
  structural: string[];
  /** Deprecated link fields present in the raw argument, left retired. */
  legacy: string[];
}

/**
 * The document a restore writes, built from the export's raw argument rather
 * than from a fixed field list: `cf piece apply` replaces the whole document,
 * so a field a list failed to name would be zeroed by the restore — a schema
 * that has since grown a field must not lose it to an older script. Every
 * plain-valued field is carried verbatim; the linked arrays take their
 * resolved values; the known link fields are reported for the caller to
 * handle; and an unrecognized link-valued field throws, because writing it as
 * data would corrupt it and dropping it would destroy it.
 */
export function buildRestoreDocument(
  rawArgument: Record<string, unknown>,
  resolved: { comments: unknown[]; links: unknown[] },
): RestoreDocument {
  const doc: Record<string, unknown> = {};
  const structural: string[] = [];
  const legacy: string[] = [];
  for (const [field, value] of Object.entries(rawArgument)) {
    if (value === undefined) continue;
    if ((LINKED_ARRAY_FIELDS as readonly string[]).includes(field)) {
      doc[field] = resolved[field as (typeof LINKED_ARRAY_FIELDS)[number]];
    } else if ((STRUCTURAL_LINK_FIELDS as readonly string[]).includes(field)) {
      structural.push(field);
    } else if ((LEGACY_LINK_FIELDS as readonly string[]).includes(field)) {
      legacy.push(field);
    } else {
      const linkPath = findLink(value);
      if (linkPath) {
        throw new Error(
          `${field} holds a link at ${linkPath} and this restore does not ` +
            "understand it; writing it as data would corrupt it and " +
            "dropping it would destroy it",
        );
      }
      doc[field] = value;
    }
  }
  return { doc, structural, legacy };
}

/** The path below any node where a `$link` marker appears, or null. Used to
 * refuse an export that would silently record a reference as content. */
export function findLink(node: unknown, path = "$"): string | null {
  if (node === null || typeof node !== "object") return null;
  if (Object.hasOwn(node, "$link")) return path;
  for (const [key, value] of Object.entries(node)) {
    const hit = findLink(value, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/** Structural equality over JSON values; `undefined` equals absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) {
    return false;
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((k) =>
    (a as Record<string, unknown>)[k] !== undefined
  );
  const keysB = Object.keys(b).filter((k) =>
    (b as Record<string, unknown>)[k] !== undefined
  );
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    )
  );
}

/** Normalize any accepted piece spelling to its bare `of:fid1:…` id. */
export function normalizeFid(ref: string): string {
  let id = ref.trim();
  if (id.startsWith("/")) id = id.slice(1);
  const hash = id.indexOf("#");
  if (hash >= 0) id = id.slice(0, hash);
  if (id.startsWith("fid1:")) id = `of:${id}`;
  return id;
}
