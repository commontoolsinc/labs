/**
 * Test Pattern: GmailLabelManager
 *
 * Verifies that label changes are blocked until Google auth is ready, and that
 * the confirmation path reports a user-visible auth error when invoked.
 *
 * Run: deno task cf test packages/patterns/google/core/experimental/gmail-label-manager.test.tsx --root packages/patterns --verbose
 */
import { action, computed, pattern, UI } from "commonfabric";
import {
  findElementByExactText,
  findElementByText,
  hasText,
  propsOf,
  readValue,
} from "../../../test/vnode-helpers.ts";
import GmailLabelManager from "./gmail-label-manager.tsx";

export default pattern(() => {
  const manager = GmailLabelManager({
    messageIds: ["msg-1"],
    labelsToAdd: ["Label_1"],
    labelsToRemove: [],
  });

  const action_open_confirmation = action(() => {
    const button = findElementByText(
      manager[UI],
      "button",
      "Review & Apply Changes",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_confirm_without_auth = action(() => {
    const button = findElementByExactText(
      manager[UI],
      "button",
      "Apply Changes",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_waiting_message_is_rendered = computed(() =>
    hasText(manager[UI], "Waiting for Google connection") &&
    hasText(
      manager[UI],
      "Connect Google with Gmail label access before refreshing or editing labels.",
    )
  );

  const assert_refresh_control_is_hidden = computed(() =>
    !hasText(manager[UI], "Refresh Labels")
  );

  const assert_apply_button_disabled_without_auth = computed(() => {
    const button = findElementByText(
      manager[UI],
      "button",
      "Review & Apply Changes",
    );
    return readValue(propsOf(button)?.disabled) === true;
  });

  const assert_confirmation_uses_label_ids_when_names_unloaded = computed(() =>
    hasText(manager[UI], "Confirm Label Changes") &&
    hasText(manager[UI], "Label_1")
  );

  const assert_auth_error_result_is_reported = computed(() =>
    manager.result?.success === false &&
    manager.result.messageCount === 1 &&
    manager.result.error === "Connect Google before applying label changes."
  );

  return {
    tests: [
      { assertion: assert_waiting_message_is_rendered },
      { assertion: assert_refresh_control_is_hidden },
      { assertion: assert_apply_button_disabled_without_auth },
      { action: action_open_confirmation },
      { assertion: assert_confirmation_uses_label_ids_when_names_unloaded },
      { action: action_confirm_without_auth },
      { assertion: assert_auth_error_result_is_reported },
    ],
    manager,
  };
});
