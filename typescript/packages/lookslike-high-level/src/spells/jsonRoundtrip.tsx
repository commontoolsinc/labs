import { h, behavior, $, Reference, select } from "@commontools/common-system";
import { refer } from "synopsys";

export const source = { readingList: { v: 1 } };

function EmptyState({ self, document }: { self: Reference, document: { id: Reference, title: string } }) {
  return <div title={"Roundtrip"} entity={self}>
    <h1>Document?</h1>
    <pre>{JSON.stringify(document, null, 2)}</pre>
  </div>
}

const exampleDoc = {
  title: "My Document",
  version: 1,
  meta: {
    draft: true,
    published: false
  },
  authors: [
    { name: "Edger Dean", email: "edgar@test.com" },
    { name: "Sarah Jacobs", email: "sarah@test.com" }
  ],
  content: {
    sections: [
      { title: "Introduction", body: "This is the introduction" },
      { title: "Body", body: "This is the body" },
      { title: "Conclusion", body: "This is the conclusion" }
    ]
  }
}

export const roundTrip = behavior({
  importDoc: select({ self: $.self })
    .not(q => q.match($.self, 'document', $._))
    .update(({ self }) => {
      const id = refer(exampleDoc)
      return [
        { Import: exampleDoc },
        { Upsert: [self, 'document', id] }
      ]
    })
    .commit(),

  // empty state view
  emptyStateView: select({
    self: $.self,
    document: {
      id: $.document,
      title: $['document.title'],
      authors: [$['document.authors']],
    }
  })
    .match($.self, 'document', $.document)
    .match($.document, 'title', $['document.title'])
    .match($.document, 'authors', $['document.authors'])
    .match($.document, 'authors', $['document.authors'])
    .render(EmptyState)
    .commit(),
})

console.log(roundTrip)

export const spawn = (input: {} = source) => roundTrip.spawn(input, "Roundtrip Demo");
