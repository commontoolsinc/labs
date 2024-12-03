import { h, behavior, $, select } from "@commontools/common-system";
import { events } from "../../sugar/event.js";

export const LikeEvents = events({
  onLike: "~/on/like",
});

export const likes = `likes`;

export function LikeButton({ likes }: { likes: number }) {
  const buttonStyles = `
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
    transition: transform 0.2s ease;
    &:hover { transform: scale(1.2); }
    &:active { transform: scale(0.9); }
  `;

  const containerStyles = `
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  `;

  const countStyles = `
    font-size: 16px;
    font-weight: bold;
    color: #aaa;
  `;

  return (
    <div style={containerStyles}>
      <span style={countStyles}>{likes}</span>
      <button
        onclick={LikeEvents.onLike}
        style={buttonStyles}
      >❤️</button>
    </div>
  );
}

export const resolveLikes = select({ self: $.self, likes: $.likes }).match($.self, likes, $.likes)

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
