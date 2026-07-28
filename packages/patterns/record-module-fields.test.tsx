/**
 * Test: the Record reads its modules' own fields.
 *
 * A Record shows things that live on the modules it holds rather than on its
 * own list: the icon a record-icon module carries, the aliases the nickname
 * modules carry, and each module's instance label. Reading them means reaching
 * through `SubPieceEntry.piece`, which is typed `unknown`; that schema is the
 * one the runner reads back as undefined instead of materializing the value, so
 * every such read saw nothing. The reads now go through `readDisplayFields`,
 * whose operand names the fields, and the runner materializes them by following
 * the entry's link into the module.
 *
 * The icon and the aliases are visible in the Record's [NAME], which this file
 * drives: `[NAME]` is `${recordIcon} ${displayNameWithAlias}`, so a
 * record-icon module's emoji replaces the type-inferred icon and each nickname
 * module's value joins the "(aka ...)" suffix. Both start empty and are set
 * through updateModule, so the assertions also pin that the reads are live: the
 * Record follows an edit made after the module was added, rather than a copy
 * taken when it was created.
 *
 * The same reads supply each module's header label, which the second half of
 * this file checks by walking the rendered [UI] for its text. Those assertions
 * also cover the module list being rendered at all: `allEntriesWithIndex` gates
 * on reading `seedRecord`'s result, and while that lift's result type was
 * inferred the capture was left out of the reading lift's input schema, so the
 * read came back undefined and every module was hidden. Counting the cards is
 * what catches that, though not what pins the fix: declaring the result type is
 * one of two things that put the capture back in the schema, and the reading
 * lift's other captures currently do it too, so the count passes with the
 * annotation removed. It fails on the version of the pattern that had
 * neither.
 *
 * The settings dialog reads the same way and can only be seen in a browser;
 * `integration/record-module-chrome.test.ts` covers it, together with the
 * dialog's controls staying bound to the module they came from.
 * `record-llm-streams.test.tsx` covers the module field data that getSummary
 * reports.
 *
 * The first Record is never rendered, so its seeder never runs and its module
 * list starts empty, which makes the module indices the add order.
 *
 * Run: deno task cf test packages/patterns/record-module-fields.test.tsx --root packages/patterns --verbose
 */
import { action, assert, NAME, pattern, UI, Writable } from "commonfabric";
import RecordPattern from "./record.tsx";

interface AddResult {
  success?: boolean;
  moduleIndex?: number;
}
interface UpdateResult {
  success?: boolean;
  error?: string;
}

// ===== Reading the rendered module list =====
// The module headers are only in the Record's [UI], so the header assertions
// walk the rendered tree and collect its text. A reactive value in the tree is
// read through `get()` where it has one.

const isNode = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const readNode = (value: unknown): unknown => {
  if (!isNode(value) || typeof value.get !== "function") return value;
  return (value.get as () => unknown)();
};

const childNodesOf = (node: unknown): unknown[] => {
  const value = readNode(node);
  if (Array.isArray(value)) return value;
  if (!isNode(value)) return [];
  const children = readNode(value.children);
  if (Array.isArray(children)) return children;
  return children === undefined || children === null ? [] : [children];
};

/** Every text node in `root`, in tree order. */
const collectText = (root: unknown, out: string[], depth = 0): string[] => {
  // A cycle would otherwise walk forever. Thrown rather than returned, so a
  // tree that outgrows this never turns an assertion on absent text into a
  // silent pass.
  if (depth > 100) throw new Error(`vdom walk exceeded ${depth} levels`);
  const value = readNode(root);
  if (typeof value === "string") {
    const text = value.trim();
    if (text) out.push(text);
    return out;
  }
  for (const child of childNodesOf(value)) collectText(child, out, depth + 1);
  return out;
};

export default pattern(() => {
  const subject = RecordPattern({
    title: "Elizabeth",
    subPieces: [],
    trashedSubPieces: [],
  });

  const addIcon = new Writable<AddResult>();
  const addFirstNickname = new Writable<AddResult>();
  const addSecondNickname = new Writable<AddResult>();
  const setIcon = new Writable<UpdateResult>();
  const clearIcon = new Writable<UpdateResult>();
  const setFirstNickname = new Writable<UpdateResult>();
  const setSecondNickname = new Writable<UpdateResult>();

  const action_add_icon_module = action(() => {
    subject.addModule!.send({ type: "record-icon", result: addIcon });
  });
  const action_add_first_nickname = action(() => {
    subject.addModule!.send({ type: "nickname", result: addFirstNickname });
  });
  const action_add_second_nickname = action(() => {
    subject.addModule!.send({ type: "nickname", result: addSecondNickname });
  });
  const action_set_icon = action(() => {
    subject.updateModule!.send({
      index: 0,
      field: "icon",
      value: "\u{1F419}",
      result: setIcon,
    });
  });
  const action_clear_icon = action(() => {
    subject.updateModule!.send({
      index: 0,
      field: "icon",
      value: "   ",
      result: clearIcon,
    });
  });
  const action_set_first_nickname = action(() => {
    subject.updateModule!.send({
      index: 1,
      field: "nickname",
      value: "Liz",
      result: setFirstNickname,
    });
  });
  const action_set_second_nickname = action(() => {
    subject.updateModule!.send({
      index: 2,
      field: "nickname",
      value: "Beth",
      result: setSecondNickname,
    });
  });

  // A record with no modules falls back to the type-inferred icon (the generic
  // clipboard, since nothing indicates a more specific type) and shows its
  // title alone.
  const assert_plain_name = assert(() =>
    subject[NAME] === "\u{1F4CB} Elizabeth"
  );

  // An empty record-icon module does not override the inferred icon.
  const assert_empty_icon_module_ignored = assert(() =>
    subject[NAME] === "\u{1F4CB} Elizabeth"
  );

  // Setting the module's icon replaces the inferred one.
  const assert_icon_override = assert(() =>
    subject[NAME] === "\u{1F419} Elizabeth"
  );

  // A whitespace-only icon is not an override, so the inferred icon returns.
  const assert_blank_icon_falls_back = assert(() =>
    subject[NAME] === "\u{1F4CB} Elizabeth"
  );

  const assert_writes_accepted = assert(() =>
    setIcon.get()?.success === true &&
    setFirstNickname.get()?.success === true &&
    setSecondNickname.get()?.success === true
  );

  // An empty nickname module contributes no alias.
  const assert_empty_nickname_ignored = assert(() =>
    subject[NAME] === "\u{1F4CB} Elizabeth"
  );

  // One nickname module shows its value as an alias.
  const assert_single_alias = assert(() =>
    subject[NAME] === "\u{1F4CB} Elizabeth (aka Liz)"
  );

  // Every nickname module contributes, in list order.
  const assert_both_aliases = assert(() =>
    subject[NAME] === "\u{1F4CB} Elizabeth (aka Liz, Beth)"
  );

  // The modules are where the values live: an entry carries none of them, only
  // the module type and the Record's own bookkeeping, so a Record that could
  // not read through to its modules would show none of the above.
  const assert_entry_types = assert(() => {
    const types = [...(subject.subPieces ?? [])].map((entry) => entry.type);
    return types.length === 3 &&
      types[0] === "record-icon" &&
      types[1] === "nickname" &&
      types[2] === "nickname";
  });

  // ===== The rendered module list =====
  // A second Record, driven through a render step, to read what the module
  // headers say. Its modules are added before it is rendered, so its list is
  // not empty when the UI first asks for it and the seeder leaves it alone:
  // the cards below are exactly the email and the photo.
  const renderedSubject = RecordPattern({
    title: "Rendered",
    subPieces: [],
    trashedSubPieces: [],
  });
  const renderedEmail = new Writable<AddResult>();
  const renderedPhoto = new Writable<AddResult>();
  const action_render_add_email = action(() => {
    renderedSubject.addModule!.send({ type: "email", result: renderedEmail });
  });
  const action_render_add_photo = action(() => {
    renderedSubject.addModule!.send({ type: "photo", result: renderedPhoto });
  });

  // One card per module. The collapse toggle is per card, so counting those
  // counts the cards: a module list that renders nothing has none of them.
  // Each assertion reads `[UI]` itself, which demands the tree it walks; the
  // render step before them is what first drives the Record's own seeding.
  const assert_two_cards_rendered = assert(() => {
    const texts = collectText(renderedSubject[UI], []);
    return texts.filter((text) => text === "▶").length === 2;
  });

  // The email module took the "Personal" standard label, and its header shows
  // that rather than the type name "Email". The photo module has no label of
  // its own, so its header falls back to the type name.
  const assert_header_shows_instance_label = assert(() => {
    const rendered = collectText(renderedSubject[UI], []).join(" ");
    return rendered.includes("\u{1F4E7} Personal") &&
      !rendered.includes("\u{1F4E7} Email");
  });
  const assert_header_falls_back_to_type = assert(() => {
    const rendered = collectText(renderedSubject[UI], []).join(" ");
    return rendered.includes("\u{1F4F7} Photo");
  });

  return {
    tests: [
      { assertion: assert_plain_name },

      { action: action_add_icon_module },
      { assertion: assert_empty_icon_module_ignored },
      { action: action_set_icon },
      { assertion: assert_icon_override },
      { action: action_clear_icon },
      { assertion: assert_blank_icon_falls_back },
      { action: action_set_icon },
      { assertion: assert_icon_override },

      { action: action_add_first_nickname },
      { action: action_add_second_nickname },
      { assertion: assert_entry_types },

      { action: action_clear_icon },
      { assertion: assert_empty_nickname_ignored },

      { action: action_set_first_nickname },
      { assertion: assert_single_alias },
      { action: action_set_second_nickname },
      { assertion: assert_both_aliases },
      { assertion: assert_writes_accepted },

      { action: action_render_add_email },
      { action: action_render_add_photo },
      { render: renderedSubject[UI] },
      { assertion: assert_two_cards_rendered },
      { assertion: assert_header_shows_instance_label },
      { assertion: assert_header_falls_back_to_type },
    ],
    subject,
    renderedSubject,
  };
});
