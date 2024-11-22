import { h, behavior, $, Reference, select, Session } from "@commontools/common-system";
import { build, make } from "../sugar/build.js";
import { event, events } from "../sugar/event.js";
import { llm } from "../effects/fetch.js";
import { Constant } from "synopsys";
import { remove, set } from "../sugar/transact.js";
import { each } from "../sugar/render.jsx";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { defaultTo } from "../sugar/default.js";

export const source = { readingList: { v: 1 } };

const ReadingListEvent = events({
  onChangeTitle: '~/on/changeTitle',
  onAddItem: '~/on/addItem',
  onDeleteItem: '~/on/deleteItem',
  onReimagineItem: '~/on/reimagineItem',
  onFinished: '~/on/finished'
})

function ReadingListItem({ self, title }: { self: Reference, title: string }) {
  return <li title={title} entity={self}>
    {title}
    <button onclick={ReadingListEvent.onDeleteItem} style="margin-left: 8px">Delete</button>
    <button onclick={ReadingListEvent.onReimagineItem} style="margin-left: 8px">Re-Imagine</button>
  </li>
}

const reimagine = ({ self, event, title }: { self: Reference, event: Constant, title: string }) => {
  return [
    llm(self, 'my/request', { prompt: 're-imagine this: ' + title }).json(),
  ];
}

const Title = select({ self: $.self, title: $.title })
  .match($.self, 'title', $.title)

const LlmResponse = select({ self: $.self, request: $.request, title: $.title })
  .match($.self, "my/request", $.request)
  .match($.request, "response/json", $.content)
  .match($.content, 'content', $.title)

const readingListItem = behavior({
  view: Title
    .render(ReadingListItem)
    .commit(),

  onDeleteItem: event(ReadingListEvent.onDeleteItem)
    .update(({ self }) => set(self, { deleted: true }))
    .commit(),

  onReimagineItem: event(ReadingListEvent.onReimagineItem)
    .with(Title)
    .update(reimagine)
    .commit(),

  onFinished: LlmResponse
    .update(({ self, title, request }) => {
      return [
        ...remove(self, { "my/request": request }),
        ...set(self, { title })
      ];
    })
    .commit(),
})


function Footer({ draftTitle }: { draftTitle: string }) {
  return <div>
    <hr />
    <common-input value={draftTitle} oncommon-input={ReadingListEvent.onChangeTitle} />
    <button onclick={ReadingListEvent.onAddItem}>Add</button>
  </div>
}

function EmptyState({ self, draftTitle, title }: { self: Reference, draftTitle: string, title: string }) {
  return <div title={title} entity={self}>
    <span>Empty!</span>
    {Footer({ draftTitle })}
  </div>
}

function ArticleList({ article, self, draftTitle, title }: { article: Reference[], self: Reference, draftTitle: string, title: string }) {
  return <div title={title} entity={self} >
    <h1>Unordered Collection (Set)</h1>
    <ul>
      {...each(article, readingListItem)}
    </ul>
    {Footer({ draftTitle })}
  </div>
}

const Articles = select({ article: [$.article] })
  .match($.self, "collection/articles", $.article)
  .not(q => q.match($.article, "deleted", true))

const TitleWithDefault = select({ self: $.self, title: $.title })
  .clause(defaultTo($.self, 'title', $.title, '<empty list>'))

const DraftTitle = select({ draftTitle: $.draftTitle })
  .clause(defaultTo($.self, 'draft/title', $.draftTitle, ''))

export const readingList = behavior({
  articles: build('collection/articles'),

  emptyStateView: TitleWithDefault
    .with(DraftTitle)
    // bf: how do we also check for the list existing but zero non-deleted elements?
    .not(q => q.match($.self, "collection/articles", $.article))
    .render(EmptyState)
    .commit(),

  listArticlesView: TitleWithDefault
    .with(DraftTitle)
    .with(Articles)
    .render(ArticleList)
    .commit(),

  onChangeTitle: event(ReadingListEvent.onChangeTitle)
    .update(({ self, event }) => {
      return set(self, { 'draft/title': Session.resolve<CommonInputEvent>(event).detail.value })
    })
    .commit(),

  onAddItem: event(ReadingListEvent.onAddItem)
    .with(DraftTitle)
    .update(({ self, event, draftTitle }) => {
      return [
        // bf: we should probably say the name of the collection here
        // currently it just adds it to ANY collection that listens for `NEW`
        make(self, { title: draftTitle }),
        ...remove(self, { 'draft/title': draftTitle })
      ]
    })
    .commit(),
})

console.log(readingList)
console.log(readingListItem)

export const spawn = (input: {} = source) => readingList.spawn(input);
