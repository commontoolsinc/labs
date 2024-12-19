import {
  h,
  Session,
  refer,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { resolve } from "../sugar/sugar.jsx";
const Ref = z.object({}).nullable().default(null);

const Contact = z.object({
  name: z.string().min(1).max(255).describe("The name of the contact"),
  email: z.string().email().describe("The email address of the contact"),
  phone: z.string().min(10).max(20).describe("The phone number of the contact"),
});

const AddressBook = z.object({
  focused: Ref.describe("The contact that is currently being edited"),
  contacts: z.array(Contact).describe("The contacts that have been added"),
  '~/common/ui/list': z.any().nullable().default(null).describe("The UI fragment for the contacts list, if present")
})

type EditEvent = {
  detail: { item: Reference }
};

type SubmitEvent = {
  detail: { value: z.infer<typeof Contact> }
};

const contactEditor = typedBehavior(Contact, {
  render: ({ self, email, name, phone }) => (
    <div entity={self}>
      <common-form
        schema={Contact}
        value={{ email, name, phone }}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ email, name, phone }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const contact = ev.detail.value;

        cmd.add(...Transact.set(self, contact))
      }),
  })
})

export const addressBook = typedBehavior(
  AddressBook.pick({
    focused: true,
    '~/common/ui/list': true
  }), {
  render: ({ self, focused, '~/common/ui/list': contactList }) => (
    <div entity={self} >
      <div>
        {focused ? (
          <div>
            <button onclick="~/on/close-editor">Close</button>
            <Charm self={focused} spell={contactEditor as any} />
          </div>
        ) : <common-form
          schema={Contact}
          reset
          onsubmit="~/on/add-contact"
        />}
      </div>

      <br />
      <br />
      {subview(contactList)}
    </div>
  ),
  rules: schema => ({
    init: initRules.init,

    onAddContact: event("~/on/add-contact")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const contact = ev.detail.value;

        cmd.add({ Import: contact })
        cmd.add(...Transact.assert(self, { contacts: refer(contact) }))
      }),

    onEditContact: event("~/on/edit-contact")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { focused: ev.detail.item }))
      }),

    onDeleteContact: event("~/on/delete-contact")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { contacts: ev.detail.item }))
      }),

    onCloseEditor: event("~/on/close-editor")
      .with(resolve(AddressBook.pick({ focused: true })))
      .transact(({ self, focused }, cmd) => {
        cmd.add(...Transact.remove(self, { focused }))
      }),

    // bf: could sugar this
    renderContactList: resolve(AddressBook.pick({ contacts: true }))
      .update(({ self, contacts }) => {
        return [
          {
            Upsert: [self, '~/common/ui/list', <common-table
              schema={Contact}
              data={contacts}
              onedit="~/on/edit-contact"
              ondelete="~/on/delete-contact"
            /> as any]
          }
        ]
      }).commit(),

  }),
});
