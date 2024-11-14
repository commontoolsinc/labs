import { h, behavior, $, Reference, select, View, refer, Instruction, Select } from "@commontools/common-system";
import { Selector, Variable } from 'datalogia'
import { analyzeRuleDependencies } from "../viz.js";
import { build, make } from "../sugar/build.js";

export const source = { readingList: { v: 1 } };

const event = <T extends Record<string, any>, D extends (name: string) => `~/on/${string}`>(name: Parameters<D>[0], additionalTerms?: T) => {
  return (select({
    self: $.self,
    event: $.event,
    ...additionalTerms || {}
  }) as Select<{
    self: Variable<any>,
    event: Variable<any>
  } & {
    [K in keyof T]: Variable<any>
  }>).match($.self, `~/on/${name}`, $.event);
};
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
  spell={() => behaviour}
  entity={() => a.id}
></common-charm>);

// bf: exploring typesafe event names
const dispatch = createDispatch([
  'add-item',
  'delete-item',
  'change-title'
]);

const Model = {
  'title': "Ben's Reading List",
  'draft/title': '',
  'collection/articles': []
};

const ItemModel = {
  title: ''
}

const query = <M extends Record<string, string | number | boolean | any[]>, T extends keyof M>(model: M, ...fields: T[]) => {
  const selection = { self: $.self, ...Object.fromEntries(fields.map(name => [name, $[name]])) };
  type Bindings = {
    self: Variable<any>;
  } & {
    [K in T]: Variable<any>;
  };
  const selectParams = select(selection) as Select<Bindings>;
  return fields.reduce((acc, field) => {
    return acc.match($.self, field as any, $[field]);
  }, selectParams);
};

const readingListItem = behavior({
  view: query(ItemModel, 'title')
    .render(({ self, title }) =>
      <li title={title} entity={self}>
        {title}
        <button onclick={dispatch('delete-item')} style="margin-left: 8px">Delete</button>
      </li>
    )
    .commit(),

  onDeleteItem: event('delete-item')
    .upsert(({ self }) => [self, 'deleted', true])
    .commit()
})

export const readingList = behavior({
  // bf: we would be better served baking this behaviour into the query, rather than spamming writes on spawn
  ...defaults(Model),

  // empty state view
  emptyStateView: query(Model, 'title', 'draft/title')
    .not(q => q.match($.self, "collection/articles", $.article))
    .render(({ self, 'draft/title': draftTitle, title }) =>
      <div title={title} entity={self}>
        <span>Empty!</span>
        <hr />
        <common-input value={draftTitle} oncommon-input={dispatch('change-title')} />
        <button onclick={dispatch('add-item')}>Add</button>
      </div>
    )
    .commit(),

  listArticlesView: select({
    self: $.self,
    draftTitle: $.draftTitle,
    title: $.title,
    article: [{
      id: $.article,
      title: $.articleTitle,
    }]
  })
    .match($.self, "title", $.title)
    .match($.self, "draft/title", $.draftTitle)
    .match($.self, "collection/articles", $.article)
    .match($.article, "title", $.articleTitle)
    .not(q => q.match($.article, "deleted", true))
    .render(({ article, self, draftTitle, title }) =>
      <div title={title} entity={self}>
        <h1>Unordered Collection (Set)</h1>
        <ul>
          {...charms(article, readingListItem)}
        </ul>
        <hr />
        <common-input value={draftTitle} oncommon-input={dispatch('change-title')} />
        <button onclick={dispatch('add-item')}>Add</button>
      </div>
    )
    .commit(),

  onChangeTitle: event('change-title')
    .upsert(({ self, event }) => {
      return [self, 'draft/title', event.detail.value]
    })
    .commit(),

  onAddItem: event('add-item', { draftTitle: $.draftTitle })
    .match($.self, "draft/title", $.draftTitle)
    .update(({ self, event, draftTitle }) => [
      // bf: we should probably say the name of the collection here
      // currently it just adds it to ANY collection that listens for `NEW`
      make(self, { title: draftTitle }),
      // reset input field
      { Retract: [self, "draft/title", draftTitle] }
    ])
    .commit(),
})

console.log(readingList)
console.log(readingListItem)

export const spawn = (input: {} = source) => readingList.spawn(input);
