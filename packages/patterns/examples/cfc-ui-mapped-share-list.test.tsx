/// <cts-enable />
import { computed, pattern, UI } from "commontools";
import ShareList, {
  MESSAGE_SHARE_ROW_OUTPUT_SCHEMA,
  MessageShareRow,
  SHARE_LIST_OUTPUT_SCHEMA,
} from "./cfc-ui-mapped-share-list.tsx";

const messageRowPlacementAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPlacement",
  surface: "InboxList",
  slot: "message-row",
} as const;

const shareActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "ShareReviewedMessage",
} as const;

export default pattern(() => {
  const row = MessageShareRow({
    messageId: "m-row",
    subject: "Escalation summary",
    sender: "ops@example.com",
    shareTarget: "did:key:reviewer",
    shared: false,
  });

  const list = ShareList({
    shareTarget: "did:key:reviewer",
    messages: [
      {
        id: "m-1",
        sender: "ops@example.com",
        subject: "Escalation summary",
        shared: false,
      },
      {
        id: "m-2",
        sender: "ceo@example.com",
        subject: "Board deck draft",
        shared: false,
      },
    ],
  });

  const assert_row_initially_not_shared = computed(() => row.shared === false);
  const assert_row_still_not_shared_after_untrusted = computed(() =>
    row.shared === false
  );
  const assert_row_shared_after_trusted = computed(() => row.shared === true);
  const assert_list_initially_empty = computed(() => list.sharedCount === 0);

  return {
    allowRuntimeErrors: true,
    tests: [
      { assertion: assert_row_initially_not_shared },
      { assertion: assert_list_initially_empty },
      {
        labelAssertion: {
          target: "row",
          schema: MESSAGE_SHARE_ROW_OUTPUT_SCHEMA,
          path: `/${UI}/children/2`,
          op: "shape",
          integrityIncludes: [shareActionContractAtom],
        },
      },
      {
        labelAssertion: {
          target: "list",
          schema: SHARE_LIST_OUTPUT_SCHEMA,
          path: `/${UI}/children/2/children/0`,
          op: "shape",
          integrityIncludes: [messageRowPlacementAtom],
        },
      },
      {
        uiEvent: {
          target: "row",
          schema: MESSAGE_SHARE_ROW_OUTPUT_SCHEMA,
          attr: {
            name: "data-ui-action",
            value: "ShareReviewedMessageUntrusted",
          },
          expectedNodePath: `/${UI}/children/3`,
          sourceGestureId: "gesture-mapped-share-list-pattern-test-untrusted",
        },
      },
      { assertion: assert_row_still_not_shared_after_untrusted },
      {
        runtimeErrorAssertion: {
          includes: [
            "CfcEventIntegrityViolationError",
            "ShareReviewedMessage",
          ],
        },
      },
      {
        uiEvent: {
          target: "row",
          schema: MESSAGE_SHARE_ROW_OUTPUT_SCHEMA,
          attr: {
            name: "data-ui-action",
            value: "ShareReviewedMessage",
          },
          expectedNodePath: `/${UI}/children/2`,
          integrityIncludes: [shareActionContractAtom],
          sourceGestureId: "gesture-mapped-share-list-pattern-test-trusted",
        },
      },
      { assertion: assert_row_shared_after_trusted },
    ],
    row,
    list,
  };
});
