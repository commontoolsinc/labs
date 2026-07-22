/**
 * Test: adding a module reports the position the module actually occupies and
 * assigns the next unused standard label.
 *
 * handleAddModule reads the sub-piece list once and depends on that read twice:
 * getNextUnusedLabel derives the new module's label by scanning the existing
 * entries of the same type, and the handler reports the new module's position
 * to its caller. The append has to land at the position the handler reports, so
 * these tests drive successive adds and check each reported index against the
 * entry sitting at it.
 *
 * The label half is asserted through the entry's own `label` field. The chosen
 * label is recorded on the SubPieceEntry at creation time; the label on the
 * sub-piece itself is not readable, because SubPieceEntry.piece is typed
 * `unknown`, whose schema the runner reads back as undefined. Successive adds of
 * the same type walk the standard label list (email: Personal, Work, School,
 * Other), a different type starts its own sequence, and an explicit label in
 * initialData overrides the default. Replacing getNextUnusedLabel's body with
 * `return undefined` now fails the label assertions.
 *
 * The list starts empty. The lift that seeds a notes module and a type picker
 * assigns its result to a variable nothing reads, and an unconsumed lift does
 * not run; the list stays empty here even with `$UI` mounted.
 *
 * Run: deno task cf test packages/patterns/record.test.tsx --root packages/patterns --verbose
 */
import { action, computed, pattern, Writable } from "commonfabric";
import RecordPattern from "./record.tsx";

interface AddResult {
  success?: boolean;
  moduleIndex?: number;
  type?: string;
  error?: string;
  message?: string;
}

export default pattern(() => {
  const subject = RecordPattern({
    title: "Test Record",
    subPieces: [],
    trashedSubPieces: [],
  });

  // Each add reports into its own cell so the assertions can tell the adds
  // apart rather than reading whichever one wrote last.
  const firstEmail = new Writable<AddResult>();
  const secondEmail = new Writable<AddResult>();
  const thirdEmail = new Writable<AddResult>();
  const phone = new Writable<AddResult>();
  const withInitialData = new Writable<AddResult>();
  const unknownType = new Writable<AddResult>();
  const missingType = new Writable<AddResult>();
  const notesType = new Writable<AddResult>();

  const action_add_first_email = action(() => {
    subject.addModule!.send({ type: "email", result: firstEmail });
  });
  const action_add_second_email = action(() => {
    subject.addModule!.send({ type: "email", result: secondEmail });
  });
  const action_add_third_email = action(() => {
    subject.addModule!.send({ type: "email", result: thirdEmail });
  });
  const action_add_phone = action(() => {
    subject.addModule!.send({ type: "phone", result: phone });
  });
  const action_add_with_initial_data = action(() => {
    subject.addModule!.send({
      type: "address",
      initialData: { label: "Chosen", street: "1 Main St" },
      result: withInitialData,
    });
  });
  const action_add_unknown = action(() => {
    subject.addModule!.send({
      type: "no-such-type",
      result: unknownType,
    });
  });
  const action_add_missing_type = action(() => {
    subject.addModule!.send({ type: "", result: missingType });
  });
  const action_add_notes = action(() => {
    subject.addModule!.send({ type: "notes", result: notesType });
  });

  const assert_starts_empty = computed(() =>
    [...(subject.subPieces ?? [])].length === 0
  );

  // The first add lands in the empty list and reports slot 0.
  const assert_first_email_appended = computed(() => {
    const current = [...(subject.subPieces ?? [])];
    return current.length === 1 && current[0].type === "email";
  });
  const assert_first_email_result = computed(() => {
    const result = firstEmail.get();
    return result?.success === true &&
      result?.type === "email" &&
      result?.moduleIndex === 0;
  });

  // The second add reads a list that already holds the first, so it has to
  // report the next slot rather than the one it read.
  const assert_second_email_appended = computed(() => {
    const current = [...(subject.subPieces ?? [])];
    return current.length === 2 && current[1].type === "email";
  });
  const assert_second_email_result = computed(() =>
    secondEmail.get()?.moduleIndex === 1
  );

  const assert_phone_appended = computed(() => {
    const current = [...(subject.subPieces ?? [])];
    return current.length === 3 && current[2].type === "phone";
  });
  const assert_phone_result = computed(() => phone.get()?.moduleIndex === 2);

  const assert_initial_data_accepted = computed(() => {
    const result = withInitialData.get();
    return result?.success === true && result?.moduleIndex === 3;
  });

  // Adds land in the order they were sent, and nothing earlier moved.
  const assert_entries_in_add_order = computed(() => {
    const types = [...(subject.subPieces ?? [])].map((entry) => entry.type);
    return types.length === 4 &&
      types[0] === "email" &&
      types[1] === "email" &&
      types[2] === "phone" &&
      types[3] === "address";
  });

  // Every reported index addresses the module that its own add created.
  const assert_reported_indices_address_their_modules = computed(() => {
    const current = [...(subject.subPieces ?? [])];
    const reported = [
      { index: firstEmail.get()?.moduleIndex, type: "email" },
      { index: secondEmail.get()?.moduleIndex, type: "email" },
      { index: phone.get()?.moduleIndex, type: "phone" },
      { index: withInitialData.get()?.moduleIndex, type: "address" },
    ];
    return reported.every(({ index, type }) =>
      typeof index === "number" && current[index]?.type === type
    );
  });

  // The smart-default label walks the standard list as successive modules of
  // the same type are added; a different type starts its own sequence; an
  // explicit label in initialData overrides the default.
  const assert_first_email_label_personal = computed(() =>
    [...(subject.subPieces ?? [])][0]?.label === "Personal"
  );
  const assert_second_email_label_work = computed(() =>
    [...(subject.subPieces ?? [])][1]?.label === "Work"
  );
  const assert_phone_label_mobile = computed(() =>
    [...(subject.subPieces ?? [])][2]?.label === "Mobile"
  );
  const assert_address_label_override = computed(() =>
    [...(subject.subPieces ?? [])][3]?.label === "Chosen"
  );

  // A third email add reads two prior emails (Personal, Work) and picks the
  // next unused standard label. This fails if getNextUnusedLabel cannot see the
  // labels the earlier adds assigned.
  const assert_third_email_appended = computed(() => {
    const current = [...(subject.subPieces ?? [])];
    return current.length === 5 && current[4].type === "email";
  });
  const assert_third_email_label_school = computed(() =>
    [...(subject.subPieces ?? [])][4]?.label === "School"
  );

  // The rejection paths report the reason and leave the list alone.
  const assert_unknown_type_rejected = computed(() => {
    const result = unknownType.get();
    return result?.success === false &&
      typeof result?.error === "string" &&
      result.error.includes("Unknown module type");
  });
  const assert_missing_type_rejected = computed(() => {
    const result = missingType.get();
    return result?.success === false &&
      typeof result?.error === "string" &&
      result.error.includes("Module type is required");
  });
  const assert_notes_type_rejected = computed(() => {
    const result = notesType.get();
    return result?.success === false &&
      typeof result?.error === "string" &&
      result.error.includes("Notes modules must be added via UI");
  });
  const assert_rejections_appended_nothing = computed(() =>
    [...(subject.subPieces ?? [])].length === 4
  );

  return {
    tests: [
      { assertion: assert_starts_empty },

      { action: action_add_first_email },
      { assertion: assert_first_email_appended },
      { assertion: assert_first_email_result },

      { action: action_add_second_email },
      { assertion: assert_second_email_appended },
      { assertion: assert_second_email_result },

      { action: action_add_phone },
      { assertion: assert_phone_appended },
      { assertion: assert_phone_result },

      { action: action_add_with_initial_data },
      { assertion: assert_initial_data_accepted },
      { assertion: assert_entries_in_add_order },
      { assertion: assert_reported_indices_address_their_modules },

      { assertion: assert_first_email_label_personal },
      { assertion: assert_second_email_label_work },
      { assertion: assert_phone_label_mobile },
      { assertion: assert_address_label_override },

      { action: action_add_unknown },
      { assertion: assert_unknown_type_rejected },
      { action: action_add_missing_type },
      { assertion: assert_missing_type_rejected },
      { action: action_add_notes },
      { assertion: assert_notes_type_rejected },
      { assertion: assert_rejections_appended_nothing },

      { action: action_add_third_email },
      { assertion: assert_third_email_appended },
      { assertion: assert_third_email_label_school },
    ],
    subject,
  };
});
