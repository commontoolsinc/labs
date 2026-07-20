/**
 * Test: adding a module reports the position the module actually occupies.
 *
 * handleAddModule reads the sub-piece list once and depends on that read twice:
 * getNextUnusedLabel derives the new module's label by scanning the existing
 * entries of the same type, and the handler reports the new module's position
 * to its caller. The append has to land at the position the handler reports, so
 * these tests drive successive adds and check each reported index against the
 * entry sitting at it.
 *
 * The label half is not asserted. An entry holds its module as a piece typed
 * `unknown`, which carries no schema, so the runner reads a module's label back
 * as undefined and a test cannot see which label the handler chose. Replacing
 * getNextUnusedLabel's body with `return undefined` still passes these tests.
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

      { action: action_add_unknown },
      { assertion: assert_unknown_type_rejected },
      { action: action_add_missing_type },
      { assertion: assert_missing_type_rejected },
      { action: action_add_notes },
      { assertion: assert_notes_type_rejected },
      { assertion: assert_rejections_appended_nothing },
    ],
    subject,
  };
});
