import {
  h,
  $,
  Reference,
  select,
  Session,
  behavior,
} from "@commontools/common-system";
import {
  build,
  make,
  event,
  events,
  remove,
  set,
  each,
  defaultTo,
} from "../sugar.js";
import { llm } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { CommonAudioRecordingEvent } from "../../../common-ui/lib/components/common-audio-recorder.js";

const ReadingListEvent = events({
  onChangeTitle: "~/on/changeTitle",
  onTranscription: "~/on/transcription",
  onAddItem: "~/on/addItem",
  onDeleteItem: "~/on/deleteItem",
  onReimagineItem: "~/on/reimagineItem",
  onFinished: "~/on/finished",
});

function ReadingListItem({ self, title }: { self: Reference; title: string }) {
  return (
    <li title={title} entity={self}>
      {title}
      <button onclick={ReadingListEvent.onDeleteItem}>Delete</button>
      <button onclick={ReadingListEvent.onReimagineItem}>Re-Imagine</button>
    </li>
  );
}

const reimagine = ({ self, title }: { self: Reference; title: string }) => [
  llm(self, "my/request", { prompt: "re-imagine this: " + title }).json(),
];

const Title = select({ self: $.self, title: $.title }).match(
  $.self,
  "title",
  $.title,
);

const LlmResponse = select({ self: $.self, request: $.request, title: $.title })
  .match($.self, "my/request", $.request)
  .match($.request, "response/json", $.content)
  .match($.content, "content", $.title);

const readingListItem = behavior({
  view: Title.render(ReadingListItem).commit(),

  onDeleteItem: event(ReadingListEvent.onDeleteItem)
    .update(({ self }) => set(self, { deleted: true }))
    .commit(),

  onReimagineItem: event(ReadingListEvent.onReimagineItem)
    .with(Title)
    .update(reimagine)
    .commit(),

  onFinished: LlmResponse.update(({ self, title, request }) => [
    ...remove(self, { "my/request": request }),
    ...set(self, { title }),
  ]).commit(),
});

function Footer({ draftTitle }: { draftTitle: string }) {
  return (
    <div>
      <hr />
      <common-input
        value={draftTitle}
        oncommon-input={ReadingListEvent.onChangeTitle}
      />
      <common-audio-recorder
        transcribe={true}
        oncommon-audio-recording={ReadingListEvent.onTranscription}
      >
        <button slot="start">🎤</button>
        <button slot="stop">⏹️</button>
      </common-audio-recorder>
      <button onclick={ReadingListEvent.onAddItem}>Add</button>
    </div>
  );
}

function EmptyState({
  self,
  draftTitle,
}: {
  self: Reference;
  draftTitle: string;
}) {
  return (
    <div title="Empty Reading List" entity={self}>
      <span>Empty!</span>
      <Footer draftTitle={draftTitle} />
    </div>
  );
}

function ArticleList({
  articles,
  self,
  draftTitle,
}: {
  articles: Reference[];
  self: Reference;
  draftTitle: string;
}) {
  return (
    <div title={`Reading List ${articles.length} items`} entity={self}>
      <h1>Unordered Collection (Set of {articles.length})</h1>
      <ul>{each(articles, readingListItem)}</ul>
      <Footer draftTitle={draftTitle} />
    </div>
  );
}

const Articles = select({ articles: [$.article] })
  .match($.self, "collection/articles", $.article)
  .not(q => q.match($.article, "deleted", true));

const DraftTitle = select({ self: $.self, draftTitle: $.draftTitle }).clause(
  defaultTo($.self, "draft/title", $.draftTitle, ""),
);

export const readingList = behavior({
  articles: build("collection/articles"),

  emptyStateView: DraftTitle
    // bf: how do we also check for the list existing but zero non-deleted elements?
    .not(q => q.match($.self, "collection/articles", $.article))
    .render(EmptyState)
    .commit(),

  listArticlesView: DraftTitle.with(Articles).render(ArticleList).commit(),

  // NOTE(ja): this is highlighting a "problem" with double-binding
  // where keypress triggers this, which triggers ui event, which updates UI
  // with the new value.. but the time to go through the whole pipeline and
  // update the UI is too long - so the inputted but not processed text gets overwritten
  // by the processed text.  this will be a common pattern we need to get right
  onChangeArticleTitle: event(ReadingListEvent.onChangeTitle)
    .update(({ self, event }) =>
      set(self, {
        "draft/title": Session.resolve<CommonInputEvent>(event).detail.value,
      }),
    )
    .commit(),

  onTranscription: event(ReadingListEvent.onTranscription)
    .update(({ self, event }) =>
      set(self, {
        "draft/title":
          Session.resolve<CommonAudioRecordingEvent>(event).detail
            .transcription || "",
      }),
    )
    .commit(),

  onAddItem: event(ReadingListEvent.onAddItem)
    .with(DraftTitle)
    .update(({ self, draftTitle }) => {
      return [
        // bf: we should probably say the name of the collection here
        // currently it just adds it to ANY collection that listens for `NEW`
        make(self, { title: draftTitle }),
        ...remove(self, { "draft/title": draftTitle }),
      ];
    })
    .commit(),
});

console.log(readingList);
console.log(readingListItem);

export const spawn = (source: {} = { readingList: 2 }) =>
  readingList.spawn(source, "Reading List");
