import { h, behavior, $, Reference, select, Select, Session } from "@commontools/common-system";
import { Variable } from 'datalogia'
import { build, make } from "../sugar/build.js";
import { query, queryDefault } from "../sugar/query.js";
import { event } from "../sugar/event.js";
import { fetch, llm } from "../effects/fetch.js";
import { Constant, Instruction } from "synopsys";

export const source = { readingList: { v: 1 } };

const defaultTo = (field: string, defaultValue: any) => select({ self: $.self })
  .not(q => q.match($.self, field, $._))
  .assert(({ self }) => [self, field, defaultValue])
  .commit();
const defaults = <T extends Record<string, any>>(input: T) => {
  return Object.entries(input).reduce((rules, [field, value]) => {
    const ruleName = `defaultFor${field.charAt(0).toUpperCase() + field.slice(1).replace(/\//g, '_')}`;
    return {
      ...rules,
      [ruleName]: Array.isArray(value) ? build(field) : defaultTo(field, value)
    };
  }, {});
}

const createDispatch = <T extends string>(names: readonly T[]) => (name: T) => `~/on/${name}`;

// bf: probably not where we want to end up here but sort of works
// bf: there's something strange going on where new items look like clones of an existing item until you reload (I suspect local memory?)
const charms = (items: { id: Reference }[], behaviour: any) => items.sort((a, b) => a.id.toString().localeCompare(b.id.toString())).map(a => <common-charm
  id={a.id.toString()}
  key={a.id.toString()}
  spell={() => behaviour}
  entity={() => a.id}
></common-charm>);

function upsert(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Upsert: [self, k, v] } as Instruction));
}

function retract(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Retract: [self, k, v] } as Instruction));
}

// bf: exploring typesafe event names
const dispatch = createDispatch([
  'add-item',
  'delete-item',
  'change-title',
  'reimagine-item'
]);

const Model = {
  'title': "Ben's Reading List 98",
  'draft/title': '',
  'collection/articles': [],
  'font-family': 'Helvetica'
};

const ItemModel = {
  title: ''
}

function ReadingListItem({ self, title }: { self: Reference, title: string }) {
  return <li title={title} entity={self}>
    {title}
    <button onclick={dispatch('delete-item')} style="margin-left: 8px">Delete</button>
    <button onclick={dispatch('reimagine-item')} style="margin-left: 8px">Re-Imagine</button>
  </li>
}


const getTodo = ({ self, event, title }: { self: Reference, event: Constant, title: string }) => {
  return [
    llm(self, 'my/request', { prompt: 're-imagine this: ' + title }).json(),
  ];
}

const readingListItem = behavior({
  view: query(ItemModel, 'title')
    .render(ReadingListItem)
    .commit(),

  onDeleteItem: event('delete-item')
    .upsert(({ self }) => [self, 'deleted', true])
    .commit(),

  onReimagineItem: query(ItemModel, 'title')
    .event('reimagine-item')
    .update(getTodo)
    .commit(),

  onFinished: select({ self: $.self, request: $.request, title: $.title })
    .match($.self, "my/request", $.request)
    .match($.request, "response/json", $.content)
    .match($.content, 'content', $.title)
    .update(({ self, title, request }) => {
      return [
        ...retract(self, { "my/request": request }),
        ...upsert(self, { title })
      ];
    })
    .commit(),
})


function Footer({ draftTitle }: { draftTitle: string }) {
  return <div>
    <hr />
    <common-input value={draftTitle} oncommon-input={dispatch('change-title')} />
    <button onclick={dispatch('add-item')}>Add</button>
  </div>
}

function EmptyState({ self, 'draft/title': draftTitle, title }: { self: Reference, 'draft/title': string, title: string }) {
  return <div title={title} entity={self}>
    <span>Empty!</span>
    {Footer({ draftTitle })}
  </div>
}

function ArticleList({ article, self, 'draft/title': draftTitle, title, "font-family": font }: { article: { id: Reference }[], self: Reference, 'draft/title': string, title: string, "font-family": string }) {
  return <div title={title} entity={self} style={`font-family: "${font}"`}>
    <h1>Unordered Collection (Set)</h1>
    <ul>
      {...charms(article, readingListItem)}
    </ul>
    {Footer({ draftTitle })}
  </div>
}

export const readingList = behavior({
  articles: build('collection/articles'),

  // empty state view
  emptyStateView: queryDefault(Model, 'title', 'draft/title')
    .not(q => q.match($.self, "collection/articles", $.article))
    .render(EmptyState)
    .commit(),

  listArticlesView: queryDefault(Model, 'title', 'draft/title', 'font-family')
    .select({
      article: [{
        id: $.article,
        title: $.articleTitle,
      }]
    })
    .match($.self, "collection/articles", $.article)
    .match($.article, "title", $.articleTitle)
    .not(q => q.match($.article, "deleted", true))
    .render(ArticleList)
    .commit(),

  onChangeTitle: event('change-title')
    .update(({ self, event }) => {
      return upsert(self, { 'draft/title': Session.resolve(event).detail.value })
    })
    .commit(),

  onAddItem: queryDefault(Model, 'draft/title')
    .event('add-item')
    .update(({ self, event, 'draft/title': draftTitle }) => {
      return [
        // bf: we should probably say the name of the collection here
        // currently it just adds it to ANY collection that listens for `NEW`
        make(self, { title: draftTitle }),
        ...retract(self, { 'draft/title': draftTitle })
      ]
    })
    .commit(),
})

console.log(readingList)
console.log(readingListItem)

export const spawn = (input: {} = source) => readingList.spawn(input);
