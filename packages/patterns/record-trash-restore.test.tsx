/**
 * Test: a module survives a trash-and-restore round trip with its field data.
 *
 * A Record holds each module as a sub-piece, referenced through
 * `SubPieceEntry.piece`. That field is declared `unknown`, and a field typed
 * `unknown` reads back across a handler boundary as undefined rather than as the
 * live handle. Trashing a module reads the active list and pushes the entry into
 * the trash; restoring reads the trash and pushes the entry back. While those
 * handlers read the lists through the declared `unknown` typing, each read drops
 * the piece, so a trashed-then-restored module came back with no piece and
 * rendered empty, its field values gone.
 *
 * The handlers now read both lists through a handle view that types the piece as
 * a live Cell, so the handle survives into the trash and back. This test adds an
 * email module (whose smart-default label is "Personal"), trashes it through the
 * exposed `removeModule` stream, restores it through the trash section's restore
 * button in the rendered UI, and reads the restored module's fields back through
 * `getSummary`. The label reads "Personal" only if the piece survived the round
 * trip.
 *
 * `removeModule` is a stream on the Output, so trashing is reachable headlessly.
 * `restoreSubPiece` is a JSX button handler with no stream of its own, so the
 * restore step walks the rendered tree to the trash section's restore control
 * and sends the stream bound to its onClick, the way `map-demo.test.tsx` reaches
 * an unexported handler. Reading a piece's own fields needs a handler read that
 * types the piece as a Cell; a plain spread of the list materializes via the
 * schema and strips the piece to undefined, so the restored field values are
 * read through `getSummary` rather than a spread.
 *
 * The email module is added and the Record rendered once before it is trashed,
 * so the auto-seeder latches on a non-empty list and never seeds its default
 * modules. The active list is then just the email throughout, and after the
 * round trip it holds exactly the restored module.
 *
 * Run: deno task cf test packages/patterns/record-trash-restore.test.tsx --root packages/patterns --verbose
 */
import { action, assert, pattern, UI, Writable } from "commonfabric";
import { findElementByText, propsOf } from "./test/vnode-helpers.ts";
import RecordPattern from "./record.tsx";

interface AddResult {
  success?: boolean;
  moduleIndex?: number;
}
interface RemoveResult {
  success?: boolean;
}
interface SummaryModule {
  index?: number;
  type?: string;
  data?: { label?: string };
}
interface SummaryResult {
  moduleCount?: number;
  modules?: SummaryModule[];
}

// Send the stream bound to the first `<button>` whose text contains `text`, and
// report whether such a button was found. The step that calls this records the
// result so an assertion can pin that the control it depends on was in the tree
// rather than pass vacuously when the button is missing.
const clickButton = (root: unknown, text: string): boolean => {
  const button = findElementByText(root, "button", text);
  const onClick = propsOf(button)?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as { send: (event: Record<string, never>) => void }).send({});
    return true;
  }
  return false;
};

export default pattern(() => {
  const subject = RecordPattern({
    title: "Contact",
    subPieces: [],
    trashedSubPieces: [],
  });

  const emailAdd = new Writable<AddResult>();
  const removeResult = new Writable<RemoveResult>();
  const trashToggleFound = new Writable<boolean>();
  const restoreFound = new Writable<boolean>();
  const summary = new Writable<SummaryResult>();

  // Add an email module. Its smart-default label is "Personal", stored on the
  // module's own piece.
  const action_add_email = action(() => {
    subject.addModule!.send({ type: "email", result: emailAdd });
  });
  const assert_email_added = assert(() => {
    const entries = [...(subject.subPieces ?? [])];
    return entries.length === 1 && entries[0].type === "email";
  });

  // Trash the email through the exposed stream.
  const action_remove_email = action(() => {
    subject.removeModule!.send({ index: 0, result: removeResult });
  });
  const assert_email_trashed = assert(() => {
    const entries = [...(subject.subPieces ?? [])];
    const trashed = [...(subject.trashedSubPieces ?? [])];
    return removeResult.get()?.success === true &&
      entries.length === 0 &&
      trashed.length === 1 && trashed[0].type === "email";
  });

  // Expand the trash section so its restore control renders, then restore.
  // Both steps walk the rendered tree; the boolean each records lets the
  // assertions pin that the control was present.
  const action_expand_trash = action(() => {
    trashToggleFound.set(clickButton(subject[UI], "Trash"));
  });
  const action_restore = action(() => {
    restoreFound.set(clickButton(subject[UI], "\u{21A9}"));
  });
  const assert_trash_control_present = assert(() =>
    trashToggleFound.get() === true
  );
  const assert_restore_control_present = assert(() =>
    restoreFound.get() === true
  );

  // The module is back in the active list and gone from the trash.
  const assert_email_restored = assert(() => {
    const entries = [...(subject.subPieces ?? [])];
    const trashed = [...(subject.trashedSubPieces ?? [])];
    return entries.length === 1 && entries[0].type === "email" &&
      trashed.length === 0;
  });

  // ...and it kept its piece: getSummary reads the restored module's own fields,
  // and its smart-default label is still there. Before the fix, the round trip
  // dropped the piece and this read came back with empty data.
  const action_summary = action(() => {
    subject.getSummary!.send({ result: summary });
  });
  const assert_restored_kept_data = assert(() => {
    const modules = summary.get()?.modules ?? [];
    const email = modules.find((m) => m.type === "email");
    return !!email && email.data?.label === "Personal";
  });

  return {
    tests: [
      { action: action_add_email },
      { assertion: assert_email_added },
      { render: subject[UI] },

      { action: action_remove_email },
      { assertion: assert_email_trashed },

      { action: action_expand_trash },
      { assertion: assert_trash_control_present },
      { action: action_restore },
      { assertion: assert_restore_control_present },
      { assertion: assert_email_restored },

      { action: action_summary },
      { assertion: assert_restored_kept_data },
    ],
    subject,
  };
});
