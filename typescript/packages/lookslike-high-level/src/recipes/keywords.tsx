import {
  h,
  behavior,
  $,
  Reference,
  View,
  Instruction,
} from "@commontools/common-system";
import * as Collection from "../sugar/collections.js";

export const source = { keywords: { v: 1 } };

function render<T extends { self: Reference }>(
  props: T,
  view: (props: T) => View<T>,
): Instruction {
  const vnode = view(props);
  return {
    Assert: [(props as any).self, "~/common/ui", vnode as any] as const,
  };
}

const Keywords = Collection.of({ title: $.title });

export const keywords = behavior({
  init: {
    select: {
      self: $.self,
    },
    where: [{ Not: { Case: [$.self, "keywords", $._] } }],
    update: ({ self }) => {
      return Keywords.new({ keywords: self }).push({ title: "hello world" });
    },
  },

  // bf: this doesn't trigger because the collection has nothing in it
  // example: {
  //   select: {
  //     keywords: Keywords,
  //   },
  //   where: [
  //     { Case: [$.self, "keywords", $.keywords] },
  //     Keywords.match($.keywords),
  //   ],
  //   update: ({ keywords }) => {
  //     const collection = Keywords.from(keywords);

  //     return [
  //       // Create assertions ofr inserting an element
  //       ...collection.insert(
  //         { title: "hello world" },
  //         {
  //           before: collection.first,
  //         },
  //       ),
  //     ];
  //   },
  // },

  // bf: this doesn't trigger because the collection has nothing in it
  view: {
    select: {
      self: $.self,
      keywords: Keywords,
    },
    where: [
      { Case: [$.self, "keywords", $.keywords] },
      Keywords.match($.keywords),
    ],
    update: ({ self, keywords }) => {
      console.log(keywords);
      const collection = Keywords.from(keywords);

      return [
        render({ self }, ({ self }) => (
          <div title="Keywords">
            <ul>{...[...collection].map(item => <li>{item.title}</li>)}</ul>
          </div>
        )),
      ];
    },
  },
});

export const spawn = (input: {} = source) => keywords.spawn(input);
