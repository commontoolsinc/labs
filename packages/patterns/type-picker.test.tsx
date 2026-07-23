import { action, computed, pattern, UI, Writable } from "commonfabric";
import TypePickerModule from "./type-picker.tsx";
import type { SubPieceEntry, TrashedSubPieceEntry } from "./record/types.ts";
import { findElementByText, propsOf } from "./test/vnode-helpers.ts";
import { getNextUnusedLabel } from "./record/standard-labels.ts";

// The picker renders the template list and passes its dismissed state through.
// Its dismiss handler is bound to a button in the UI rather than exposed as a
// result stream, so a headless test drives the state cell for that. Its apply
// handler is reached the other way: walk the rendered tree to the template
// button and send the stream on its onClick, the same event a click delivers.
export default pattern(() => {
  const entries = new Writable<SubPieceEntry[]>([
    { type: "notes", pinned: false, piece: null },
    { type: "type-picker", pinned: false, piece: null },
  ]);
  const trashedEntries = new Writable<TrashedSubPieceEntry[]>([]);
  const dismissed = new Writable(false);

  const picker = TypePickerModule({ entries, trashedEntries, dismissed });

  const assert_starts_undismissed = computed(() => picker.dismissed === false);

  // `dismissed` is passed straight through, so the output follows the cell
  // rather than a value snapshotted at instantiation.
  const action_dismiss = action(() => {
    dismissed.set(true);
  });
  const assert_dismissed_follows_the_cell = computed(() =>
    picker.dismissed === true
  );

  // Apply the Person template by sending the stream bound to its button.
  const action_apply_person = action(() => {
    const button = findElementByText(picker[UI], "button", "Person");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  // The Person template creates an email and a phone. Each is recorded on its
  // entry with its standard default label, so a later add of the same type can
  // see it. Without that, the added module would default to the same label.
  const assert_template_email_label = computed(() =>
    (entries.get() ?? []).find((e) => e.type === "email")?.label === "Personal"
  );
  const assert_template_phone_label = computed(() =>
    (entries.get() ?? []).find((e) => e.type === "phone")?.label === "Mobile"
  );

  // The consequence the recorded label buys: the next email add reads the
  // template's email label and picks the next unused one rather than "Personal".
  const assert_next_email_label_is_work = computed(() =>
    getNextUnusedLabel("email", entries.get() ?? []) === "Work"
  );

  return {
    tests: [
      { assertion: assert_starts_undismissed },
      { action: action_dismiss },
      { assertion: assert_dismissed_follows_the_cell },
      { action: action_apply_person },
      { assertion: assert_template_email_label },
      { assertion: assert_template_phone_label },
      { assertion: assert_next_email_label_is_work },
    ],
    picker,
  };
});
