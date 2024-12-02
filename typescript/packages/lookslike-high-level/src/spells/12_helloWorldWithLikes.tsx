import { h, $, behavior, select } from "@commontools/common-system";
import { event, events } from "../sugar/event.js";
import { Likeable, LikeButton } from "./stickers/like.jsx";
import { mixin } from "../sugar/mixin.js";
import {
  Comment,
  Commentable,
  Comments,
  CommentsView,
} from "./stickers/comments.jsx";
import { Chattable } from "./stickers/chat.jsx";

const HelloWorldEvent = events({
  onAlert: "~/on/alert",
});

const spell = behavior({
  ...mixin(Likeable),
  ...mixin(Commentable),

  view: select({ self: $.self, likes: $.likes })
    .with(Comment)
    .match($.self, "likes", $.likes)
    .render(({ self, likes, comments, draft, screenName }) => {
      const collection = Comments.from(comments);

      return (
        <div entity={self} title="Hello World">
          <h1>Hello World</h1>
          <p>This is a spell.</p>
          <button type="button" onclick={HelloWorldEvent.onAlert}>
            Click me
          </button>
          <p>It has added likes!</p>
          <LikeButton likes={likes} />
          <hr />
          <CommentsView
            collection={collection}
            draft={draft}
            screenName={screenName}
          />
        </div>
      );
    })
    .commit(),

  onClick: event(HelloWorldEvent.onAlert)
    .update(({ self }) => {
      alert("Hello from " + self.toString());
      return [];
    })
    .commit(),
});

export const spawn = (source: {} = { hello: 1 }) => spell.spawn(source);
