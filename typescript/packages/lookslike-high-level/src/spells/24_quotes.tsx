import { h, Session, refer } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, initState, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { log } from "../sugar/activity.js";

const Quote = z
  .object({
    quote: z
      .string()
      .max(1024 * 16)
      .describe("The quote text"),
    source: z.string().max(255).describe("The source of the quote"),
  })
  .describe("Quote");

const QuoteDB = z.object({
  focused: Ref.describe("The quote that is currently being edited"),
  quotes: z.array(Quote).describe("The quotes that have been added"),
  "~/common/ui/list": UiFragment.describe(
    "The UI fragment for the quotes list, if present",
  ),
});

type EditEvent = {
  detail: { item: Reference };
};

type SubmitEvent = {
  detail: { value: z.infer<typeof Quote> };
};

type ImportEvent = {
  detail: { items: z.infer<typeof Quote>[] };
};

const quoteEditor = typedBehavior(Quote, {
  render: ({ self, quote, source }) => (
    <div entity={self}>
      <common-form
        schema={Quote}
        value={{ quote, source }}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ quote, source }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent>(event);
      let quote = ev.detail.value;
      if (!quote.source) {
        quote.source = "Unknown";
      }

      cmd.add(...Transact.set(self, quote));
    }),
  }),
});

export const quotedb = typedBehavior(
  QuoteDB.pick({
    focused: true,
    "~/common/ui/list": true,
  }),
  {
    render: ({ self, "~/common/ui/list": quoteList, focused }) => (
      <div entity={self} title="Quotes">
        {focused ? (
          <div>
            <h3>Edit Quote</h3>
            <button onclick="~/on/close-quote">Close</button>
            <Charm self={focused} spell={quoteEditor as any} />
          </div>
        ) : (
          <div>
            <common-form schema={Quote} reset onsubmit="~/on/add-quote" />
          </div>
        )}
        <br />
        <br />
        {subview(quoteList)}
      </div>
    ),
    rules: schema => ({
      init: initState({ focused: false }),

      renderQuoteList: resolve(QuoteDB.pick({ quotes: true }))
        .update(({ self, quotes }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/list",
                (
                  <common-table
                    schema={Quote}
                    data={quotes}
                    preview
                    edit
                    download
                    delete
                    copy
                    onedit="~/on/focus-quote"
                    ondelete="~/on/delete-quote"
                    onimport="~/on/import-quotes"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      onAddQuote: event("~/on/add-quote").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        let quote = ev.detail.value;
        if (!quote.source) {
          quote.source = "Unknown";
        }

        const { self: id, instructions } = importEntity(quote, Quote);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { quotes: id }));
        cmd.add(...log(self, "Added quote"));
      }),

      onEditQuote: event("~/on/edit-quote").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...tagWithSchema(self, Quote));
      }),

      onFocusQuote: event("~/on/focus-quote").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.set(self, { focused: ev.detail.item }));
        },
      ),

      onCloseQuote: event("~/on/close-quote")
        .with(resolve(QuoteDB.pick({ focused: true })))
        .transact(({ self, focused }, cmd) => {
          cmd.add(...Transact.set(self, { focused: false }));
        }),

      onDeleteQuote: event("~/on/delete-quote").transact(
        ({ self, event }, cmd) => {
          debugger;
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { quotes: ev.detail.item }));
        },
      ),

      onCloseEditor: event("~/on/close-editor")
        .with(resolve(QuoteDB.pick({ focused: true })))
        .transact(({ self, focused }, cmd) => {
          cmd.add(...Transact.remove(self, { focused }));
        }),

      onImportQuotes: event("~/on/import-quotes").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<ImportEvent>(event);
          const quotes = ev.detail.items;

          for (let quote of quotes) {
            const { self: id, instructions } = importEntity(quote, Quote);
            cmd.add(...instructions);
            cmd.add(...Transact.assert(self, { quotes: id }));
          }
          cmd.add(...log(self, `Imported ${quotes.length} quotes`));
        },
      ),
    }),
  },
);
