import {
  h,
  Session,
  refer,
} from "@commontools/common-system";
import { event, Transact } from "../sugar.js";
import { initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";

const Contact = z.object({
  name: z.string().min(1).max(255).describe("The name of the contact"),
  email: z.string().email().describe("The email address of the contact"),
  phone: z.string().min(10).max(20).describe("The phone number of the contact"),
});

const AddressBook = z.object({
  contacts: z.array(Contact).describe("The contacts that have been added"),
})

type SubmitEvent = {
  detail: { value: z.infer<typeof Contact> }
};

export const addressBook = typedBehavior(AddressBook, {
  render: ({ self, contacts }) => (
    <div entity={self} >
      <common-form
        schema={Contact}
        onsubmit="~/on/add-contact"
      />
      <br />
      <br />
      <common-table schema={Contact} data={contacts} />
    </div>
  ),
  rules: schema => ({
    init: initRules.init,

    onAddContact: event("~/on/add-contact")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const contact = ev.detail.value;

        // bf: this is sugarable, but how should we leverage schema in the process?
        cmd.add({ Import: contact })
        cmd.add(...Transact.assert(self, { contacts: refer(contact) }))
      }),
  }),
});
