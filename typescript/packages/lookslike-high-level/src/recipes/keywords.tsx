import { h, behavior, $, Reference, View, refer } from "@commontools/common-system";
import { Instruction } from "synopsys";
import { Collection } from "../sugar/collections.js";

export const source = { keywords: { v: 1 } };

function render<T extends { self: Reference }>(props: T, view: (props: T) => View<T>): Instruction {
  const vnode = view(props)
  return {
    Assert: [(props as any).self, "~/common/ui", vnode as any] as const,
  }
}

export const keywords = behavior({
  // bf: trying to create collection and add an initial item to trigger the rest
  init: {
    select: {
      self: $.self,
    },
    where: [
      { Not: { Case: [$.self, 'keywords', $.keywords] } }
    ],
    update: ({ self }) => {
      // bf: I suspect this is incoherent
      const id = refer({ collection: 'keywords', of: [] })
      const collection = new Collection({ collection: id, of: [] })

      // I can't provide before or after because there's nothing... but I have to give an `at`?
      return [
        { Assert: [self, 'keywords', id] },
        ...collection.insert({ title: "hello world" }, { before: collection.first })
      ]
    }
  },

  // bf: this doesn't trigger because the collection has nothing in it
  example: {
    select: {
      keywords: Collection.select($.keywords)
    },
    where: [
      { Case: [$.self, 'keywords', $.keywords] },
      Collection.includes($.keywords, $.keyword)
    ],
    update: ({ keywords }) => {
      const collection = Collection.from(keywords)

      const [...elements] = collection

      return [
        // Create assertions ofr inserting an element
        ...collection.insert({ title: "hello world" }, {
          before: collection.first,
        })
      ]
    }
  },

  // bf: this doesn't trigger because the collection has nothing in it
  view: {
    select: {
      self: $.self,
      keywords: Collection.select($.keywords)
    },
    where: [
      { Case: [$.self, 'keywords', $.keywords] },
      Collection.includes($.keywords, $.keyword)
    ],
    update: ({ self, keywords }) => {
      const collection = Collection.from(keywords)

      const [...elements] = collection

      return [
        render(self, ({ self }) => <div entity={self} title='Keywords'>keywords</div>)
      ]
    }
  },
})

console.log(keywords)

export const spawn = (input: {} = source) => keywords.spawn(input);
