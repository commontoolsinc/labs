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

const dispatch = createDispatch([
  'add-item',
  'change-title'
]);

const Model = {
  'title': "Ben's Reading List",
  'draft/title': '',
  'collection/articles': []
};

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

export const readingList = behavior({
  ...defaults(Model),

  // add item on click
  onAddItem: event('add-item', { draftTitle: $.draftTitle })
    .match($.self, "draft/title", $.draftTitle)
    .update(({ self, event, draftTitle }) => [
      // Q: we should probably say the name of the collection here
      // currently it just adds it to ANY collection that listens for `NEW`
      make(self, { title: draftTitle }),
      // reset input field
      { Retract: [self, "draft/title", draftTitle] }
    ])
    .commit(),

  test2: query(Model, 'title', 'draft/title')
    .update(({ self, title, 'draft/title': draftTitle }) => {
      console.log('wat', self, title, draftTitle)
      return []
    })
    .commit(),

  //  list articles view
  view: select({
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
    .render(({ article, self, draftTitle, title }) => <div title={title} entity={self}>
      <ul>
        {/* naughty, we can't do this with IFC but working around a temp view fragment limitation */}
        {...article.map(a => <li><a href={`charm://${a.id}`}>{a.title}</a></li>)}
      </ul>
      <hr />
      <common-input value={draftTitle} oncommon-input={dispatch('change-title')} />
      <button onclick={dispatch('add-item')}>Add</button>
    </div>)
    .commit(),

  // empty state view
  noArticlesView: select({
    self: $.self,
    draftTitle: $.draftTitle,
    title: $.title
  })
    .match($.self, "draft/title", $.draftTitle)
    .match($.self, "title", $.title)
    .not(q => q.match($.self, "collection/articles", $._))
    .render(({ self, draftTitle, title }) => <div title={title} entity={self}>
      <span>Empty!</span>
      <hr />
      <common-input value={draftTitle} oncommon-input={dispatch('change-title')} />
      <button onclick={dispatch('add-item')}>Add</button>
    </div>)
    .commit(),

  onChangeTitle: event('change-title')
    .upsert(({ self, event }) => {
      return [self, 'draft/title', event.detail.value]
    })
    .commit(),
})

console.log(readingList)

export const spawn = (input: {} = source) => readingList.spawn(input);
