import {
  h,
  behavior,
  $,
  Session,
  select,
  Variable,
} from "@commontools/common-system";
import { CommonInputEvent } from "../../../../common-ui/lib/components/common-input.js";
import {
  Collection,
  CollectionView,
  defaultTo,
  event,
  events,
  isEmpty,
  Transact,
} from "../../sugar.js";

export const source = { comments: { v: 1 } };

export const CommentsModel = {
  draft: "~/comments/draft",
  screenName: "~/comments/screenName",
  comments: "comments",
};

const CommentEvents = events({
  onSendComment: "~/on/SendComment",
  onDraftComment: "~/on/DraftComment",
  onChangeScreenName: "~/on/ChangeScreenName",
});

export const Comments = Collection.of({
  comment: $.comment,
  author: $.author,
  postedAt: $.postedAt,
});

const CommentHistoryLink = select({ comments: $.comments }).match(
  $.self,
  "comments",
  $.comments,
);

export const Comment = select({
  self: $.self,
  draft: $.draft,
  screenName: $.screenName,
  comments: Comments.select,
})
  .clause(defaultTo($.self, CommentsModel.draft, $.draft, ""))
  .clause(
    defaultTo($.self, CommentsModel.screenName, $.screenName, "Anonymous"),
  )
  .match($.self, "comments", $.comments)
  .clause(Comments.match($.comments));

const Uninitialized = select({ self: $.self }).clause(
  isEmpty($.self, CommentsModel.comments),
);

export const CommentsView = ({
  collection,
  screenName,
  draft,
}: {
  collection: CollectionView<{
    comment: Variable<any>;
    author: Variable<any>;
    postedAt: Variable<any>;
  }>;
  screenName: string;
  draft: string;
}) => (
  <div title="Comments">
    <ul>
      {[...collection].map(item => (
        <li key={item.author + item.comment}>
          <b>{item.author}</b>: {item.comment}{" "}
          <sub style="opacity: 0.5;">
            {new Date(item.postedAt).toLocaleTimeString()}
          </sub>
        </li>
      ))}
    </ul>
    <fieldset style="border-radius: 8px;">
      <label>Name</label>
      <common-input
        type="text"
        value={screenName}
        oncommon-input={CommentEvents.onChangeScreenName}
      />
      <label>Comment</label>
      <common-input
        type="text"
        value={draft}
        placeholder="Add a comment..."
        oncommon-input={CommentEvents.onDraftComment}
      />
      <button onclick={CommentEvents.onSendComment}>Post</button>
    </fieldset>
  </div>
);

export const Commentable = behavior({
  "comments/init": Uninitialized.update(({ self }) => {
    const collection = Comments.new({ comments: self });
    return [
      ...collection.push({
        comment: "First comment!",
        author: "system",
        postedAt: Date.now(),
      }),
    ];
  }).commit(),

  "comments/sendComment": event(CommentEvents.onSendComment)
    .with(Comment)
    .update(({ self, screenName, comments, draft }) => {
      const collection = Comments.from(comments);
      return [
        ...Transact.remove(self, { "~/comments/draft": draft }),
        ...collection.push({
          comment: draft,
          author: screenName,
          postedAt: Date.now(),
        }),
      ];
    })
    .commit(),

  "comments/editComment": event(CommentEvents.onDraftComment)
    .update(({ self, event }) => {
      return Transact.set(self, {
        [CommentsModel.draft]:
          Session.resolve<CommonInputEvent>(event).detail.value,
      });
    })
    .commit(),

  "comments/changeName": event(CommentEvents.onChangeScreenName)
    .update(({ self, event }) => {
      return Transact.set(self, {
        [CommentsModel.screenName]:
          Session.resolve<CommonInputEvent>(event).detail.value,
      });
    })
    .commit(),

  // "comments/view": Comment.update(({ self, comments, screenName, draft }) => {
  //   const collection = Comments.from(comments);
  //   return [
  //     render({ self }, () => (
  //       <CommentsView
  //         collection={collection}
  //         screenName={screenName}
  //         draft={draft}
  //       />
  //     )),
  //   ];
  // }).commit(),
});
