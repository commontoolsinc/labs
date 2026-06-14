// deno-lint-ignore-file no-explicit-any
/**
 * Annotation primitive (prototype) — backlinks-index-backed library.
 *
 * An **annotation** is a statement that one entity is *about* another. It is
 * authored as its **own document** in the author's space, pointing at the
 * target through an `about` link (and the target's plain entity id, `aboutId`,
 * for robust matching). **Nothing is ever written into the target** — that is
 * the whole point of the primitive.
 *
 * The reverse lookup `annotationsOf` reads the space's concrete mentionable
 * index — `wish({ query: "#default" }).result.backlinksIndex.mentionable`,
 * which the default app maintains reactively — and keeps the annotations whose
 * `aboutId` equals the target's id. Reactive for free (an ordinary cell read),
 * works for ANY target (no `backlinks`-field cooperation required), and avoids
 * the favorites/schema fragility of hashtag discovery.
 *
 * One verb (`annotate`); `identity` alone switches accrete vs. converge.
 * Accreting works in pure pattern-space; converging (toggle/idempotent) needs a
 * content-independent piece identity — the surgical runtime affordance tracked
 * as plan §A.2.
 *
 * SES note: builder calls (pattern/lift/handler/wish) may not live in standalone
 * functions, so `annotate` is a module-scope handler and `annotationsOf` a
 * module-scope lift; the pattern body owns the `wish` call.
 *
 * See docs/development/connectors/annotations-prototype-plan.md
 */
import {
  Cell,
  computed,
  type Default,
  getEntityId,
  handler,
  lift,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { MentionablePiece } from "../system/backlinks-index.tsx";

// ===== Types =====

/**
 * A persisted annotation document. `about` is a link to the target; `aboutId`
 * is the target's plain entity id (the matching key); `rel` is the relationship
 * ("comment", "tag", "verdict", …); the remaining fields are the annotation's
 * own data.
 */
export interface AnnotationPiece {
  [NAME]?: string;
  about?: MentionablePiece | null;
  aboutId?: string;
  rel?: string;
  body?: string;
  isAnnotation?: boolean;
  isMentionable?: boolean;
  mentioned?: MentionablePiece[];
}

export interface AnnotationInput {
  about?: Writable<MentionablePiece | null | Default<null>>;
  aboutId?: string | Default<"">;
  rel?: Writable<string | Default<"comment">>;
  body?: Writable<string | Default<"">>;
  isAnnotation?: boolean | Default<true>;
  isMentionable?: boolean | Default<true>;
}

/**
 * An #annotation document that points at a target via `about`. (The `#annotation`
 * hashtag here keeps the piece nominally tag-discoverable too, but the reverse
 * lookup does not depend on hashtag discovery.)
 */
export interface AnnotationOutput extends AnnotationPiece {
  [NAME]: string;
  [UI]: VNode;
  about: MentionablePiece | null;
  aboutId: string;
  rel: string;
  body: string;
  isAnnotation: boolean;
  isMentionable: boolean;
  mentioned: MentionablePiece[];
}

// ===== The annotation document pattern =====

export const Annotation = pattern<AnnotationInput, AnnotationOutput>(
  ({ about, aboutId, rel, body, isAnnotation, isMentionable }) => {
    const name = computed(() => {
      const r = (rel.get() || "comment").trim();
      const b = (body.get() ?? "").trim();
      return b ? `💬 ${r}: ${b.slice(0, 48)}` : `💬 ${r}`;
    });

    // `mentioned` feeds the backlinks/mentionable system for free, so the
    // annotation is discoverable and the about-edge is visible to tooling —
    // without writing anything back into the target.
    const mentioned = computed<MentionablePiece[]>(() => {
      const t = about.get();
      return t ? [t] : [];
    });

    return {
      [NAME]: name,
      [UI]: (
        <cf-vstack
          gap="1"
          style={{
            padding: "8px 10px",
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            background: "white",
          }}
        >
          <span
            style={{ fontSize: "11px", color: "#6b7280", fontWeight: "600" }}
          >
            {rel}
          </span>
          <span style={{ fontSize: "14px" }}>{body}</span>
        </cf-vstack>
      ),
      about,
      aboutId,
      rel,
      body,
      isAnnotation,
      isMentionable,
      mentioned,
    };
  },
);

export default Annotation;

// ===== Authoring: the single verb (handler) =====

/**
 * The single annotation verb. Bind it to a UI event with the `target` and
 * (optionally) a draft cell for the body. `identity` alone switches accrete vs.
 * converge — there is no second API surface.
 *
 * ```tsx
 * // accreting comment from a draft cell (cleared on post):
 * <cf-button onClick={annotate({ addPiece, target: doc, rel: "comment", body: draft })}>
 *   Post
 * </cf-button>
 * // converging tag toggle (idempotent, keyed by identity):
 * <cf-button onClick={annotate({ addPiece, target: rec, rel: "tag", identity: "#alex", body: "#alex" })}>
 *   #alex
 * </cf-button>
 * ```
 */
export const annotate = handler<
  unknown,
  {
    addPiece: Stream<{ piece: MentionablePiece }>;
    /**
     * The target. Declared as a Cell so the handler receives a cell *link* (not
     * a plain value): the link is stored as `about`, and its entity id as
     * `aboutId` — the key `annotationsOf` matches on.
     */
    target: Cell<MentionablePiece>;
    rel?: string;
    identity?: unknown;
    /** A literal, or a Writable draft that is cleared after posting. */
    body?: string | Writable<string>;
  }
>((_event, { addPiece, target, rel, identity, body }) => {
  const draft = isWritable(body) ? body : undefined;
  const text = (draft ? (draft.get() ?? "") : ((body as string) ?? "")).trim();
  if (identity === undefined && !text) return; // accreting text needs content
  if (identity !== undefined) assertDeterministicIdentity(identity);
  const aboutId = getEntityId(target)?.["/"] ?? "";
  // Accreting (no identity): a fresh distinct piece per call.
  // Converging (identity): must mint with a content-independent cause keyed by
  // (target, rel, identity) so re-runs update in place and addPiece's equals()
  // dedup keeps exactly one — the surgical runtime affordance (plan §A.2).
  const piece = Annotation(
    { about: target as any, aboutId, rel: rel ?? "comment", body: text },
  );
  addPiece.send({ piece: piece as any });
  draft?.set("");
});

function isWritable(v: unknown): v is Writable<string> {
  return !!v && typeof (v as { get?: unknown }).get === "function";
}

/** Reject non-deterministic identity (timestamps, randoms) loudly, per the design. */
function assertDeterministicIdentity(identity: unknown): void {
  if (JSON.stringify(identity) === undefined) {
    throw new Error(
      "annotate(): `identity` must be JSON-serializable and deterministic",
    );
  }
}

// ===== Reverse lookup: annotationsOf =====

/**
 * Reactive reverse lookup, as a lift: every annotation about `target`,
 * optionally filtered by `rel`. The pattern body supplies `all` from the
 * default app's mentionable index and `targetId` from `getEntityId(target)`.
 *
 * ```tsx
 * const dflt = wish<{
 *   addPiece: Stream<{ piece: MentionablePiece }>;
 *   backlinksIndex: { mentionable: AnnotationPiece[] | undefined };
 * }>({ query: "#default" }).result!;
 * const targetId = getEntityId(doc)?.["/"];
 * const comments = annotationsOf({ all: dflt.backlinksIndex.mentionable, targetId, rel: "comment" });
 * ```
 *
 * NOTE: `all` is typed `AnnotationPiece[]`, not `MentionablePiece[]`, on
 * purpose. A lift projects its inputs through the schema derived from this
 * declared type, *stripping undeclared fields*. Typed as `MentionablePiece[]`
 * (which has no `isAnnotation`/`aboutId`) those fields arrive `undefined` and
 * the filter silently returns nothing. Consumers' `wish` types must be widened
 * the same way. (A `computed` would not strip — it auto-tracks cell proxies.)
 *
 * O(N) over the space's mentionable pieces — a deliberate prototype trade-off;
 * plan Phase E promotes this to a concrete per-target reverse index.
 */
export const annotationsOf = lift<
  {
    all: AnnotationPiece[] | undefined;
    targetId: string | undefined;
    rel?: string;
  },
  AnnotationPiece[]
>(({ all, targetId, rel }) => {
  if (!targetId) return [];
  return (all ?? []).filter((a) =>
    !!a &&
    a.isAnnotation === true &&
    a.aboutId === targetId &&
    (rel === undefined || a.rel === rel)
  );
});
