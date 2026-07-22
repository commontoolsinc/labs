// deno-lint-ignore-file no-explicit-any
/**
 * CommentThread — demo of the annotation primitive (accreting mode).
 *
 * Renders all #annotation comments about `doc` via `annotationsOf`, plus a
 * composer that posts a new comment with the single `annotate` verb. Each
 * comment is its **own document** in the space — `doc` is never written.
 *
 * This is the canonical loom example, realised on the backlinks-index-backed
 * library: `annotationsOf` reads the default app's mentionable index and keeps
 * the annotations whose `aboutId` is this doc.
 */
import {
  getEntityId,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type { MentionablePiece } from "../system/backlinks-index.tsx";
import { annotate, type AnnotationPiece, annotationsOf } from "./annotations.tsx";

interface CommentThreadInput {
  /** The target being commented on. Never written by this pattern. */
  doc: Writable<MentionablePiece>;
}

interface CommentThreadOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<CommentThreadInput, CommentThreadOutput>(({ doc }) => {
  // `mentionable` is typed `AnnotationPiece[]` (not `MentionablePiece[]`) so the
  // wish schema projection passes `isAnnotation`/`aboutId` through to
  // `annotationsOf` — see the note on `annotationsOf` in annotations.tsx.
  const dflt = wish<{
    addPiece: Stream<{ piece: MentionablePiece }>;
    backlinksIndex: { mentionable: AnnotationPiece[] | undefined };
  }>({ query: "#default" }).result!;

  const draft = new Writable<string>("");
  const targetId = getEntityId(doc)?.["/"];
  const comments = annotationsOf({
    all: dflt.backlinksIndex.mentionable,
    targetId,
    rel: "comment",
  });

  return {
    [NAME]: "💬 Comments",
    [UI]: (
      <cf-vstack gap="2" style={{ padding: "12px", maxWidth: "520px" }}>
        {comments.map((c: AnnotationPiece) => (
          <cf-card style={{ padding: "8px 10px" }}>
            <span style={{ fontSize: "14px" }}>{c.body}</span>
          </cf-card>
        ))}
        <cf-hstack gap="2" style={{ alignItems: "center" }}>
          <cf-input $value={draft} placeholder="Add a comment…" />
          <cf-button
            onClick={annotate({
              addPiece: dflt.addPiece,
              target: doc,
              rel: "comment",
              body: draft,
            })}
          >
            Post
          </cf-button>
        </cf-hstack>
      </cf-vstack>
    ),
  };
});
