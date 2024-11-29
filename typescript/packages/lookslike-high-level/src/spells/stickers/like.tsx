import { h, behavior, $, select } from "@commontools/common-system";
import { events } from "../../sugar/event.js";

export const LikeEvents = events({
  onLike: "~/on/like",
});

export const likes = `likes`;

export function LikeButton({ likes }: { likes: number }) {
  return (
    <div>
      Likes: {likes}
      <button onclick={LikeEvents.onLike}>👍</button>
    </div>
  );
}

export const Likeable = behavior({
  "likes/default": select({ self: $.self })
    .not(q => q.match($.self, "likes", $._))
    .assert(({ self }) => [self, "likes", 0])
    .commit(),

  "likes/onLike": select({ self: $.self, event: $.event, likes: $.likes })
    .match($.self, LikeEvents.onLike, $.event)
    .match($.self, "likes", $.likes)
    .update(({ self, likes }) => {
      return [{ Assert: [self, "likes", Number(likes) + 1] }];
    })
    .commit(),
});
