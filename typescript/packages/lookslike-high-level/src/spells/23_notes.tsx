import { h, Session, refer } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";

const Memo = z
  .object({
    name: z.string().max(255).describe("The title of the note"),
    content: z
      .string()
      .min(1)
      .max(1024 * 16)
      .describe("The content of the note"),
  })
  .describe("Memo");

const Notebook = z.object({
  focused: Ref.describe("The note that is currently being edited"),
  notes: z.array(Memo).describe("The notes that have been added"),
  "~/common/ui/list": UiFragment.describe(
    "The UI fragment for the notes list, if present",
  ),
});

type EditEvent = {
  detail: { item: Reference };
};

type SubmitEvent = {
  detail: { value: z.infer<typeof Memo> };
};

const noteEditor = typedBehavior(Memo, {
  render: ({ self, title, content }) => (
    <div entity={self}>
      <common-form
        schema={Memo}
        value={{ title, content }}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ title, content }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent>(event);
      let note = ev.detail.value;
      if (!note.title) {
        note.title = "Untitled";
      }

      cmd.add(...Transact.set(self, note));
    }),
  }),
});

export const notebook = typedBehavior(
  Notebook.pick({
    "~/common/ui/list": true,
  }),
  {
    render: ({ self, "~/common/ui/list": noteList }) => (
      <div entity={self} name="Notes">
        <div>
          <common-form schema={Memo} reset onsubmit="~/on/add-note" />
        </div>

        <br />
        <br />
        {subview(noteList)}
      </div>
    ),
    rules: schema => ({
      init: initRules.init,

      onAddNote: event("~/on/add-note").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        let note = ev.detail.value;
        if (!note.name) {
          note.name = "Untitled";
        }

        const { self: id, instructions } = importEntity(note, Memo);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { notes: id }));
      }),

      onEditNote: event("~/on/edit-note").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { focused: ev.detail.item }));
        cmd.add(...tagWithSchema(self, Memo));
      }),

      onDeleteNote: event("~/on/delete-note").transact(
        ({ self, event }, cmd) => {
          debugger;
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { notes: ev.detail.item }));
        },
      ),

      onCloseEditor: event("~/on/close-editor")
        .with(resolve(Notebook.pick({ focused: true })))
        .transact(({ self, focused }, cmd) => {
          cmd.add(...Transact.remove(self, { focused }));
        }),

      renderNoteList: resolve(Notebook.pick({ notes: true }))
        .update(({ self, notes }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/list",
                (
                  <common-table
                    schema={Memo}
                    data={notes}
                    edit
                    delete
                    download
                    preview
                    onedit="~/on/edit-note"
                    ondelete="~/on/delete-note"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),
    }),
  },
);
