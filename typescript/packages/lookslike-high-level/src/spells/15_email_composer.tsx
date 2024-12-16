import {
  h,
  behavior,
  $,
  select,
  Session,
  Instruction,
  Select,
} from "@commontools/common-system";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { event, field, Transact } from "../sugar.js";
import { makeEmail, sendMessage } from "../effects/gmail.jsx";
import { init, initRules } from "./spell.jsx";
import { z } from "zod";
import { resolve } from "../sugar/sugar.jsx";

const GMAIL_REQUEST = "~/gmail";
const EmailComposer = z.object({
  to: z.string().default(""),
  subject: z.string().default(""),
  body: z.string().default(""),
});

export const resolveDraft = resolve(EmailComposer).with(init);

const styles = {
  formContainer: `
    padding: 20px;
    background: #f0f0f0;
    border: 2px solid #ccc;
    border-radius: 8px;
    font-family: monospace;
    max-width: 600px;
    margin: 0 auto;
  `,

  inputGroup: `
    display: flex;
    flex-direction: column;
    gap: 15px;
    margin-bottom: 20px;
  `,

  inputLabel: `
    font-size: 12px;
    color: #666;
    font-weight: bold;
    text-transform: uppercase;
  `,

  textArea: `
    min-height: 200px;
    width: 100%;
    padding: 10px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
  `,

  input: `
    width: 100%;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
  `,
};

export const emailComposer = behavior({
  ...initRules,

  render: resolve(EmailComposer)
    .render(({ self, body, subject, to }) => (
      <div entity={self} style={styles.formContainer}>
        <div style={styles.inputGroup}>
          <div>
            <div style={styles.inputLabel}>To</div>
            <common-input
              value={to}
              style={styles.input}
              oncommon-blur="~/on/change-to"
            />
          </div>
          <div>
            <div style={styles.inputLabel}>Subject</div>
            <common-input
              value={subject}
              style={styles.input}
              oncommon-blur="~/on/change-subject"
            />
          </div>
          <div>
            <div style={styles.inputLabel}>Message</div>
            <common-input
              value={body}
              style={styles.textArea}
              multiline={true}
              oncommon-blur="~/on/change-body"
            />
          </div>
          <common-button onclick="~/on/send-email">Send</common-button>
        </div>
      </div>
    ))
    .commit(),

  onChangeTo: event("~/on/change-to")
    .with(resolve(EmailComposer.pick({ to: true })))
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "to", val] }];
    })
    .commit(),

  onChangeSubject: event("~/on/change-subject")
    .with(resolve(EmailComposer.pick({ subject: true })))
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "subject", val] }];
    })
    .commit(),

  onChangeBody: event("~/on/change-body")
    .with(resolve(EmailComposer.pick({ body: true })))
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "body", val] }];
    })
    .commit(),

  onSendEmail: event("~/on/send-email")
    .with(resolve(EmailComposer))
    .transact(({ self, body, subject, to }, cmd) => {
      cmd.add(
        sendMessage(self, GMAIL_REQUEST, "me", makeEmail(to, subject, body)),
      );

      cmd.add(
        ...Transact.set(self, {
          subject: "",
          body: "",
          status: "sending...",
        }),
      );
    }),
});
