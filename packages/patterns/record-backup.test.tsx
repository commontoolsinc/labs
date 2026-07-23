import {
  action,
  assert,
  handler,
  pattern,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { findElementByText, hasText, propsOf } from "./test/vnode-helpers.ts";
import RecordBackup, { type RecordPiece } from "./record-backup.tsx";

const BACKUP_JSON = JSON.stringify({
  version: "1.0",
  exportDate: "2026-07-22T12:00:00.000Z",
  records: [{
    localId: "record-001",
    title: "Imported Record",
    modules: [],
    trashedModules: [],
  }],
});

const PARTIAL_BACKUP_JSON = JSON.stringify({
  version: "1.0",
  exportDate: "2026-07-22T12:00:00.000Z",
  records: [{
    localId: "record-002",
    title: "Partially Imported Record",
    modules: [{
      type: "unknown-module",
      pinned: false,
      data: {},
    }],
    trashedModules: [],
  }],
});

type ImportClick = { send: (event: Record<string, never>) => void };
type WithUI = { [UI]: unknown };

const registerPiece = handler<
  { piece: Writable<RecordPiece> },
  {
    pieceRegistry: Writable<RecordPiece[]>;
    registrationCount: Writable<number>;
  }
>(({ piece }, { pieceRegistry, registrationCount }) => {
  registrationCount.set(registrationCount.get() + 1);
  const title = piece.key("title").get();
  if (pieceRegistry.get().some((candidate) => candidate.title === title)) {
    return;
  }
  pieceRegistry.addUnique(piece);
});

const clickImport = (backup: WithUI) => {
  const button = findElementByText(
    backup[UI],
    "cf-button",
    "Import Records",
  );
  const onClick = propsOf(button)?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as ImportClick).send({});
  }
};

export default pattern(() => {
  const importJson = new Writable(BACKUP_JSON);
  const pieceRegistry = wish<Writable<RecordPiece[]>>({
    query: "#pieceRegistry",
  }).result!;
  const registrationCount = new Writable(0);
  const backup = RecordBackup({
    importJson,
    addPiece: registerPiece({ pieceRegistry, registrationCount }),
  });

  const action_import = action(() => clickImport(backup));
  const action_import_again = action(() => {
    importJson.set(BACKUP_JSON);
    clickImport(backup);
  });
  const action_import_with_unknown_module = action(() => {
    importJson.set(PARTIAL_BACKUP_JSON);
    clickImport(backup);
  });

  const assert_starts_empty = assert(() => pieceRegistry.get().length === 0);
  const assert_first_import_registers_record = assert(() =>
    pieceRegistry.get().length === 1 &&
    pieceRegistry.get()[0].title === "Imported Record" &&
    registrationCount.get() === 1
  );
  const assert_repeat_import_obeys_registration_policy = assert(() =>
    pieceRegistry.get().length === 1 && registrationCount.get() === 2
  );
  const assert_partial_import_reports_failed_module = assert(() =>
    pieceRegistry.get().length === 2 &&
    registrationCount.get() === 3 &&
    hasText(backup[UI], "Imported 1 record(s), 1 module(s) failed")
  );

  return {
    tests: [
      { assertion: assert_starts_empty },
      { action: action_import },
      { assertion: assert_first_import_registers_record },
      { action: action_import_again },
      { assertion: assert_repeat_import_obeys_registration_policy },
      { action: action_import_with_unknown_module },
      { assertion: assert_partial_import_reports_failed_module },
    ],
    backup,
  };
});
