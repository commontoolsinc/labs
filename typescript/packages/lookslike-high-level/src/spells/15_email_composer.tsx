import { h, Session, refer } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { makeEmail, sendMessage } from "../effects/gmail.jsx";
import { initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { resolve } from "../sugar/sugar.jsx";
import { UiFragment } from "../sugar/zod.js";

const GMAIL_REQUEST = "~/gmail";
const ComposedMessage = z.object({
  to: z.string().email().describe("The email address to send to"),
  subject: z.string().min(1).max(255).describe("The subject of the email"),
  body: z.string().min(10).max(8096).describe("The body of the email"),
});

const Composer = z.object({
  sent: z.array(ComposedMessage).describe("The emails that have been sent"),
  status: z.string().default("init"),
  "~/common/ui/list": UiFragment.describe(
    "The UI fragment for the sent emails list",
  ),
});

type SubmitEvent = {
  detail: { value: z.infer<typeof ComposedMessage> };
};

export const emailComposer = typedBehavior(
  Composer.pick({
    status: true,
    "~/common/ui/list": true,
  }),
  {
    render: ({ self, status, "~/common/ui/list": sentList }) => (
      <div entity={self}>
        <common-form
          schema={ComposedMessage}
          reset
          onsubmit="~/on/send-email"
        />
        {subview(sentList)}
      </div>
    ),
    rules: schema => ({
      init: initRules.init,

      onSendEmail: event("~/on/send-email").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent>(event);
        const msg = ev.detail.value;

        debugger;
        cmd.add(
          sendMessage(
            self,
            GMAIL_REQUEST,
            "me",
            makeEmail(msg.to, msg.subject, msg.body),
          ),
        );

        cmd.add(...Transact.set(self, { status: "sending" }));

        cmd.add({ Import: msg });
        cmd.add(...Transact.assert(self, { sent: refer(msg) }));
      }),

      renderSentList: resolve(Composer.pick({ sent: true }))
        .update(({ self, sent }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/list",
                (
                  <common-table schema={ComposedMessage} preview data={sent} />
                ) as any,
              ],
            },
          ];
        })
        .commit(),
    }),
  },
);
