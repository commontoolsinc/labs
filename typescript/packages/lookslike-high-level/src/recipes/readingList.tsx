import { h, behavior, $, Reference, select, View, refer, Instruction } from "@commontools/common-system";
import { Selector } from 'datalogia'
import { collection, make, view } from "../sugar.jsx";
import { analyzeRuleDependencies } from "../viz.js";

export const source = { readingList: { v: 1 } };

const event = (name: string, selectors?: Record<string, any>) => select({
  self: $.self,
  event: $.event,
  ...selectors
}).match($.self, `~/on/${name}`, $.event);

const init = <T extends Selector>(
  collectionName: string,
  matchQuery: T,
  additionalMatches: (builder: any) => any,
  propsGen: (queryVars: any) => Instruction[]
) => {
  let builder = select({ ...matchQuery, self: $.self, item: $.item })
    .match($.self, collectionName, $.item)
    .not.match($.item, "instance/initialized", true);

  additionalMatches(builder);

  return builder.update(vars => [
    ...propsGen(vars),
    { Assert: [vars.item, "instance/initialized", true] }
  ]);
};

export const readingList = behavior({
  // set the title of this list if it has none
  defaultTitle: select({ self: $.self })
    .not.match($.self, "title", $._)
    .assert(({ self }) => [self, "title", "Ben's Reading List"])
    .commit(),

  // declare collection of articles + init behaviour
  articles: collection("collection/articles"),
  initArticle: init('collection/articles',
    { draftTitle: $.draftTitle },
    (builder) => {
      builder.match($.self, 'draft/title', $.draftTitle);
    },
    ({ self, item, draftTitle }) => [
      { Assert: [item, 'title', draftTitle] },
      { Upsert: [self, 'draft/title', ""] }
    ]
  ),

  // initial value for input field
  titleInput: select({ self: $.self })
    .not.match($.self, "draft/title", $._)
    .assert(({ self }) => [self, 'draft/title', ""])
    .commit(),

  // list articles view
  view: select({
    self: $.self,
    draftTitle: $.draftTitle,
    article: [{
      id: $.article,
      title: $.title,
    }]
  })
    .match($.self, "collection/articles", $.article)
    .match($.article, "title", $.title)
    .match($.self, "draft/title", $.draftTitle)
    .render(({ article, self, draftTitle }) => <div title={`Reading List`} entity={self}>
      <pre>{JSON.stringify(article, null, 2)}</pre>
      <hr />
      <common-input value={draftTitle} oncommon-input="~/on/change-title" />
      <button onclick="~/on/add-item">Add</button>
    </div>),

  // empty state view
  noArticlesView: select({
    self: $.self,
    draftTitle: $.draftTitle
  })
    .match($.self, "draft/title", $.draftTitle)
    .not.match($.self, "collection/articles", $._)
    .render(({ self, draftTitle }) => <div title={`Empty Reading List`} entity={self}>
      <span>Empty!</span>
      <hr />
      <common-input value={draftTitle} oncommon-input="~/on/change-title" />
      <button onclick="~/on/add-item">Add</button>
    </div>),

  // event handlers
  onAddItem: event('add-item')
    .update(({ self, event }) => [
      make(self, 'collection/articles'),
    ]),

  onChangeTitle: event('change-title')
    .upsert(({ self, event }) => {
      // common-input gives us events with easy to read values
      return [self, 'draft/title', event.detail.value]
    })
    .commit(),
})

export const spawn = (input: {} = source) => readingList.spawn(input);
