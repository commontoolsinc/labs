import {
  h,
  behavior,
  $,
  select,
  Session,
  Instruction,
  Select,
  refer,
} from "@commontools/common-system";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { event, Transact } from "../sugar.js";
import { makeEmail, sendMessage } from "../effects/gmail.jsx";
import { Charm, init, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { resolve } from "../sugar/sugar.jsx";

const GMAIL_REQUEST = "~/gmail";
const ComposedMessage = z.object({
  to: z.string().email().describe("The email address to send to"),
  subject: z.string().min(1).max(255).describe("The subject of the email"),
  body: z.string().min(10).max(8096).describe("The body of the email"),
});

const Composer = z.object({
  sent: z.array(ComposedMessage).describe("The emails that have been sent"),
  status: z.string().default('init')
})

const FormTest = z.object({
  to: z.string().email().describe("The email address to send to"),
  subject: z.string().min(1).max(255).describe("The subject of the email"),
  body: z.string().min(10).max(8096).describe("The body of the email"),
  count: z.number().describe("A number!"),
  done: z.boolean().describe("Done?"),
  category: z.enum(["work", "personal", "family"]).describe("The category of the email"),
  tags: z.array(z.string()).describe("The tags of the email"),
  cc: z.array(z.object({
    email: z.string().email().describe("The email address to cc to"),
    name: z.string().describe("The name of the person to cc"),
  })).describe("The cc of the email"),
});

type SubmitEvent = {
  detail: { value: z.infer<typeof ComposedMessage> }
};

export const emailComposer = typedBehavior(Composer, {
  render: ({ self, sent }) => (
    <div entity={self} >
      <common-form
        schema={ComposedMessage}
        onsubmit="~/on/send-email"
      />
      <common-table schema={ComposedMessage} data={sent} />
    </div>
  ),
  rules: schema => ({
    init: initRules.init,

    onSendEmail: event("~/on/send-email")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const msg = ev.detail.value;

        debugger
        cmd.add(
          sendMessage(self, GMAIL_REQUEST, "me", makeEmail(msg.to, msg.subject, msg.body)),
        );

        cmd.add(...Transact.set(self, { status: "sending", }));

        // bf: this is sugarable, but how should we leverage schema in the process?
        cmd.add({ Import: msg })
        cmd.add(...Transact.assert(self, { sent: refer(msg) }))
      }),
  }),
});
