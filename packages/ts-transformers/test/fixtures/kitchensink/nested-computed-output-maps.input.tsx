/// <cts-enable />
/**
 * FIXTURE: nested-computed-output-maps
 * Verifies: nested computed outputs can flow back into later pattern-owned
 * maps while their inner compute-owned array maps stay plain, and callback
 * captures survive across multiple cloned callbacks.
 * Expected transform:
 * - laneLabels.map(...) lowers after calling a module-scope lift in pattern context
 * - visibleThreads.map(...), visibleComments.map(...), comment.reactions.map(...),
 *   and plainSeparators.map(...) remain plain Array.map() calls inside computed()
 * - liftedSeparators.map(...) lowers after calling that same module-scope lift
 *   inside the current compute callback
 * - reboundComments.map(...) lowers because a nested computed() re-wraps the
 *   local array inside the current compute callback
 * - threadRows.map(...) lowers once the flow re-enters pattern-owned UI
 * - closures preserve thread/comment indices, state.lane, and local Writables
 */
import {
  computed,
  handler,
  ifElse,
  lift,
  pattern,
  UI,
  Writable,
} from "commontools";

interface Comment {
  id: string;
  text: string;
  flagged: boolean;
  reactions: string[];
}

interface Thread {
  id: string;
  title: string;
  muted: boolean;
  comments: Comment[];
}

const jumpToComment = handler<unknown, {
  selectedCommentId: string | undefined;
  threadId: string;
  commentId: string;
  lane: string;
  outerIndex: number;
  innerIndex: number;
}>((_event, state) => state);

const passthroughLabels = lift((labels: string[]) => labels);

export default pattern<{
  threads: Thread[];
  lane: string;
  showFlagged: boolean;
}>((state) => {
  const selectedCommentId = Writable.of<string | undefined>();
  const laneLabels = passthroughLabels(["lane", "detail", "summary"]);

  const visibleThreads = computed(() =>
    state.threads.map((thread, outerIndex) => ({
      thread,
      outerIndex,
      visibleComments: state.showFlagged
        ? thread.comments.filter((comment) => comment.flagged)
        : thread.comments,
    }))
  );

  const threadRows = computed(() =>
    visibleThreads.map(({ thread, outerIndex, visibleComments }) => {
      const plainSeparators = ["top", "bottom"].map((edge) =>
        `${thread.title}-${edge}`
      );
      const liftedSeparators = passthroughLabels(plainSeparators);
      const reboundComments = computed(() => visibleComments);

      return (
        <article>
          <h2>{thread.title}</h2>
          {visibleComments.map((comment, innerIndex) => (
            <div>
              <button
                onClick={jumpToComment({
                  selectedCommentId,
                  threadId: thread.id,
                  commentId: comment.id,
                  lane: state.lane,
                  outerIndex,
                  innerIndex,
                })}
              >
                {comment.flagged
                  ? <strong>{comment.text}</strong>
                  : ifElse(
                    thread.muted,
                    <em>{comment.text}</em>,
                    <span>{comment.text}</span>,
                  )}
              </button>
              {comment.reactions.map((reaction, reactionIndex) => (
                <span>
                  {reactionIndex === innerIndex
                    ? `${state.lane}:${reaction}`
                    : reaction}
                </span>
              ))}
            </div>
          ))}
          {reboundComments.map((comment, reboundIndex) => (
            <aside>
              {reboundIndex === outerIndex
                ? `${state.lane}:${comment.id}`
                : comment.text}
            </aside>
          ))}
          {liftedSeparators.map((edge, edgeIndex) => (
            <small>
              {edgeIndex === outerIndex ? `${state.lane}:${edge}` : edge}
            </small>
          ))}
          {plainSeparators.map((edge) => <small>{edge}</small>)}
        </article>
      );
    })
  );

  return {
    [UI]: (
      <div>
        {laneLabels.map((label, labelIndex) => (
          <header data-lane-label={labelIndex}>
            {labelIndex === 0 ? `${state.lane}:${label}` : label}
          </header>
        ))}
        {threadRows.map((row, rowIndex) => (
          <section data-row={rowIndex}>{row}</section>
        ))}
      </div>
    ),
  };
});
