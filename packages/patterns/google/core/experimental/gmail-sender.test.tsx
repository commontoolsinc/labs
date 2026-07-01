/**
 * Test Pattern: GmailSender
 *
 * Verifies that sending stays unavailable until Google auth is ready.
 *
 * Run: deno task cf test packages/patterns/google/core/experimental/gmail-sender.test.tsx --root packages/patterns --verbose
 */
import { action, computed, pattern, UI } from "commonfabric";
import {
  findElementByText,
  propsOf,
  readValue,
} from "../../../test/vnode-helpers.ts";
import GmailSender from "./gmail-sender.tsx";

export default pattern(() => {
  const sender = GmailSender({
    draft: {
      to: "recipient@example.com",
      subject: "Status update",
      body: "Hello from a test.",
      cc: "",
      bcc: "",
      replyToMessageId: "",
      replyToThreadId: "",
    },
  });

  const action_open_confirmation = action(() => {
    const reviewButton = findElementByText(
      sender[UI],
      "button",
      "Review & Send",
    );
    const onClick = propsOf(reviewButton)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_result_initially_empty = computed(() => sender.result === null);

  const assert_review_button_disabled_without_auth = computed(() => {
    const reviewButton = findElementByText(
      sender[UI],
      "button",
      "Review & Send",
    );
    return readValue(propsOf(reviewButton)?.disabled) === true;
  });

  const assert_confirmation_explains_missing_auth = computed(() =>
    findElementByText(sender[UI], "div", "Google connection required") !==
      undefined &&
    findElementByText(
        sender[UI],
        "div",
        "Reconnect Google before sending this email.",
      ) !==
      undefined
  );

  const assert_send_button_disabled_without_auth = computed(() => {
    const sendButton = findElementByText(sender[UI], "button", "Send Email");
    return readValue(propsOf(sendButton)?.disabled) === true;
  });

  return {
    tests: [
      { assertion: assert_result_initially_empty },
      { assertion: assert_review_button_disabled_without_auth },
      { action: action_open_confirmation },
      { assertion: assert_confirmation_explains_missing_auth },
      { assertion: assert_send_button_disabled_without_auth },
    ],
    sender,
  };
});
