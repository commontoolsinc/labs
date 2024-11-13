import { h, behavior, $, Reference, select, View, refer, Instruction, Select } from "@commontools/common-system";
import { Selector, Variable } from 'datalogia'
import { analyzeRuleDependencies } from "../viz.js";
import { build, make } from "../sugar/build.js";

export const source = { readingList: { v: 1 } };

const event = <T extends Record<string, any>>(name: string) => {
  const baseSelect = select({
    self: $.self,
    event: $.event
  }) as Select<{
    self: Variable<any>,
    event: Variable<any>
  }>;

  const builder = {
    select: (additionalSelectors: T) => {
      return select({
        self: $.self,
        event: $.event,
        ...additionalSelectors
      }) as Select<{
        self: Variable<any>,
        event: Variable<any>
      } & {
        [K in keyof T]: Variable<any>
      }>;
    },
    match: (...args: any[]) => baseSelect.match($.self, `~/on/${name}`, $.event),
    upsert: baseSelect.upsert,
    assert: baseSelect.assert,
    retract: baseSelect.retract,
    update: baseSelect.update,
    commit: baseSelect.commit,
  };

  return builder;
};

const defaultTo = (field: string, defaultValue: any) => select({ self: $.self })
  .not.match($.self, field, $._)
  .assert(({ self }) => [self, field, defaultValue])
  .commit();

export const readingList = behavior({
  defaultTitle: defaultTo("title", "Ben's Reading List"),

  // enter name of item
  titleInput: defaultTo('draft/title', ""),

  // declare collection of articles
  articles: build("collection/articles"),

  // add item on click
  onAddItem: event('add-item')
    .select({ draftTitle: $.draftTitle })
    .match($.self, "draft/title", $.draftTitle)
    .update(({ self, event, draftTitle }) => [
      // Q: we should probably say the name of the collection here
      // currently it just adds it to ANY collection that listens for `NEW`
      make(self, { title: draftTitle }),
      // reset input field
      { Retract: [self, "draft/title", draftTitle] }
    ]),

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

  onChangeTitle: event('change-title')
    .upsert(({ self, event }) => {
      return [self, 'draft/title', event.detail.value]
    })
    .commit(),
})

export const spawn = (input: {} = source) => readingList.spawn(input);
