/**
 * Test: the LLM-callable streams a Record exposes for Omnibot's invoke() tool.
 *
 * Record's body returns six streams under the "LLM-callable streams" comment;
 * addModule has its own positioning-and-labels test in record.test.tsx, and
 * this file covers the other five: getSummary, updateModule, removeModule,
 * setTitle, and listModuleTypes. Reaching any of them needs it declared in
 * RecordOutput, because the pattern's Output type decides what the result
 * schema materializes on the instance; a stream returned from the body but
 * absent from the Output reads back as undefined and cannot be invoked. Each
 * case below sends the stream and asserts on what the handler writes, so
 * removing a stream's declaration turns its `subject.<stream>!.send(...)` into
 * a call on undefined and fails the case.
 *
 * A handler returns its payload to the caller by writing the injected `result`
 * cell (its return value is ignored). A `Writable<unknown>` reads back as
 * undefined, so every result cell here is typed with the concrete shape its
 * handler writes.
 *
 * getSummary and updateModule reach the module pieces the list holds. The piece
 * is declared `unknown` on SubPieceEntry, and a field typed `unknown` reads
 * back across a handler boundary as undefined, so both handlers type the piece
 * as a live Cell to keep the handle. getSummary's per-module `data` therefore
 * carries the real field values (the email module's smart-default label reads
 * "Personal"), and updateModule's write is visible in the next getSummary.
 *
 * The Record is never rendered, so its seeder never runs and its module list
 * starts empty — the headless path an invoke() caller takes. Modules are added
 * with addModule before the cases that read or mutate them, so the indices are
 * known.
 *
 * Run: deno task cf test packages/patterns/record-llm-streams.test.tsx --root packages/patterns --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import RecordPattern from "./record.tsx";

interface ModuleTypeInfo {
  type?: string;
  label?: string;
  icon?: string;
  allowMultiple?: boolean;
}
interface ListTypesResult {
  types?: ModuleTypeInfo[];
}
interface SummaryModule {
  index?: number;
  type?: string;
  label?: string;
  pinned?: boolean;
  data?: { label?: string; number?: string };
}
interface SummaryResult {
  title?: string;
  moduleCount?: number;
  modules?: SummaryModule[];
}
interface OpResult {
  success?: boolean;
  message?: string;
  error?: string;
  title?: string;
}
interface AddResult {
  success?: boolean;
  moduleIndex?: number;
  type?: string;
}

export default pattern(() => {
  const subject = RecordPattern({
    title: "Test Record",
    subPieces: [],
    trashedSubPieces: [],
  });

  // Each invocation reports into its own cell so the assertions read the value
  // its own send produced rather than whichever handler wrote last.
  const typesResult = new Writable<ListTypesResult>();
  const setTitleResult = new Writable<OpResult>();
  const emailAdd = new Writable<AddResult>();
  const phoneAdd = new Writable<AddResult>();
  const summaryBefore = new Writable<SummaryResult>();
  const summaryAfter = new Writable<SummaryResult>();
  const updateOk = new Writable<OpResult>();
  const updateBadIndex = new Writable<OpResult>();
  const updateBadField = new Writable<OpResult>();
  const updateInherited = new Writable<OpResult>();
  const removeOk = new Writable<OpResult>();
  const removeBadIndex = new Writable<OpResult>();

  // listModuleTypes — read-only. Lists the types addModule accepts.
  const action_list_types = action(() => {
    subject.listModuleTypes!.send({ result: typesResult });
  });
  const assert_list_types = assert(() => {
    const types = typesResult.get()?.types ?? [];
    return types.length > 0 &&
      types.every((t) =>
        typeof t.type === "string" && typeof t.label === "string" &&
        typeof t.icon === "string"
      ) &&
      types.some((t) => t.type === "email");
  });

  // setTitle — sets the record title and echoes it back.
  const action_set_title = action(() => {
    subject.setTitle!.send({
      newTitle: "Renamed Record",
      result: setTitleResult,
    });
  });
  const assert_title_updated = assert(() => subject.title === "Renamed Record");
  const assert_set_title_result = assert(() => {
    const r = setTitleResult.get();
    return r?.success === true && r?.title === "Renamed Record";
  });

  // Two modules so the summary, update, and remove cases have known indices.
  const action_add_email = action(() => {
    subject.addModule!.send({ type: "email", result: emailAdd });
  });
  const action_add_phone = action(() => {
    subject.addModule!.send({ type: "phone", result: phoneAdd });
  });
  const assert_two_modules = assert(() => {
    const entries = [...(subject.subPieces ?? [])];
    return entries.length === 2 &&
      entries[0].type === "email" && entries[1].type === "phone";
  });

  // getSummary — read-only. Reports the title, module count, and per-module
  // type and field values in list order. The field values come from the live
  // piece, so each module's smart-default label reads back (email "Personal",
  // phone "Mobile").
  const action_summary_before = action(() => {
    subject.getSummary!.send({ result: summaryBefore });
  });
  const assert_summary = assert(() => {
    const s = summaryBefore.get();
    const modules = s?.modules ?? [];
    return s?.title === "Renamed Record" && s?.moduleCount === 2 &&
      modules.length === 2 &&
      modules[0].type === "email" && modules[0].data?.label === "Personal" &&
      modules[1].type === "phone" && modules[1].data?.label === "Mobile";
  });

  // updateModule — sets a directly-settable field on a module, and reports the
  // reason when the index is out of range or the field is not on the module.
  const action_update_label = action(() => {
    subject.updateModule!.send({
      index: 0,
      field: "label",
      value: "Updated",
      result: updateOk,
    });
  });
  const action_update_bad_index = action(() => {
    subject.updateModule!.send({
      index: 9,
      field: "label",
      value: "x",
      result: updateBadIndex,
    });
  });
  const action_update_bad_field = action(() => {
    subject.updateModule!.send({
      index: 0,
      field: "nonesuch",
      value: "x",
      result: updateBadField,
    });
  });
  // An inherited name is not an own field, so the guard rejects it rather than
  // writing a stray key onto the piece.
  const action_update_inherited = action(() => {
    subject.updateModule!.send({
      index: 0,
      field: "constructor",
      value: "x",
      result: updateInherited,
    });
  });
  const assert_update_ok = assert(() => {
    const r = updateOk.get();
    return r?.success === true &&
      typeof r?.message === "string" && r.message.includes("label");
  });
  const assert_update_bad_index = assert(() => {
    const r = updateBadIndex.get();
    return r?.success === false &&
      typeof r?.error === "string" && r.error.includes("Invalid module index");
  });
  const assert_update_bad_field = assert(() => {
    const r = updateBadField.get();
    return r?.success === false &&
      typeof r?.error === "string" &&
      r.error.includes("not a settable field");
  });
  const assert_update_inherited_rejected = assert(() => {
    const r = updateInherited.get();
    return r?.success === false &&
      typeof r?.error === "string" &&
      r.error.includes("not a settable field");
  });

  // The write updateModule made is visible: the next summary reads the new
  // label off the same piece.
  const action_summary_after = action(() => {
    subject.getSummary!.send({ result: summaryAfter });
  });
  const assert_update_took_effect = assert(() =>
    summaryAfter.get()?.modules?.[0]?.data?.label === "Updated"
  );

  // removeModule — moves a module to the trash (a soft delete) and reports the
  // reason when the index is out of range.
  const action_remove_email = action(() => {
    subject.removeModule!.send({ index: 0, result: removeOk });
  });
  const action_remove_bad_index = action(() => {
    subject.removeModule!.send({ index: 9, result: removeBadIndex });
  });
  const assert_remove_ok = assert(() => {
    const r = removeOk.get();
    const entries = [...(subject.subPieces ?? [])];
    const trashed = [...(subject.trashedSubPieces ?? [])];
    return r?.success === true &&
      entries.length === 1 && entries[0].type === "phone" &&
      trashed.length === 1 && trashed[0].type === "email";
  });
  const assert_remove_bad_index = assert(() => {
    const r = removeBadIndex.get();
    return r?.success === false &&
      typeof r?.error === "string" &&
      r.error.includes("Invalid module index") &&
      [...(subject.subPieces ?? [])].length === 1;
  });

  return {
    [TESTS]: [
      { action: action_list_types },
      { assertion: assert_list_types },

      { action: action_set_title },
      { assertion: assert_title_updated },
      { assertion: assert_set_title_result },

      { action: action_add_email },
      { action: action_add_phone },
      { assertion: assert_two_modules },

      { action: action_summary_before },
      { assertion: assert_summary },

      { action: action_update_label },
      { assertion: assert_update_ok },
      { action: action_update_bad_index },
      { assertion: assert_update_bad_index },
      { action: action_update_bad_field },
      { assertion: assert_update_bad_field },
      { action: action_update_inherited },
      { assertion: assert_update_inherited_rejected },

      { action: action_summary_after },
      { assertion: assert_update_took_effect },

      { action: action_remove_email },
      { assertion: assert_remove_ok },
      { action: action_remove_bad_index },
      { assertion: assert_remove_bad_index },
    ],
    subject,
  };
});
