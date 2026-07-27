import { action, assert, pattern, UI, wish, Writable } from "commonfabric";
import { findElementByText, hasText, propsOf } from "./test/vnode-helpers.ts";
import RecordBackup, { type RecordPiece } from "./record-backup.tsx";

const BACKUP_JSON = JSON.stringify({
  version: "1.0",
  exportDate: "2026-07-22T12:00:00.000Z",
  records: [
    {
      localId: "record-001",
      title: "Imported Record",
      modules: [],
      trashedModules: [],
    },
    {
      localId: "record-002",
      title: "Second Imported Record",
      modules: [],
      trashedModules: [],
    },
  ],
});

const PARTIAL_BACKUP_JSON = JSON.stringify({
  version: "1.0",
  exportDate: "2026-07-22T12:00:00.000Z",
  records: [{
    localId: "record-003",
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
  const registrationCount = wish<Writable<number>>({
    query: "#default",
    path: ["testPieceRegistrationCount"],
  }).result!;
  const backup = RecordBackup({ importJson });

  const action_import = action(() => clickImport(backup));
  const action_import_with_unknown_module = action(() => {
    importJson.set(PARTIAL_BACKUP_JSON);
    clickImport(backup);
  });

  const assert_starts_empty = assert(() => pieceRegistry.get().length === 0);
  const assert_each_imported_record_is_registered = assert(() =>
    pieceRegistry.get().length === 2 &&
    pieceRegistry.get()[0].title === "Imported Record" &&
    pieceRegistry.get()[1].title === "Second Imported Record" &&
    registrationCount.get() === 2 &&
    importJson.get() === ""
  );
  const assert_partial_import_reports_failed_module = assert(() =>
    pieceRegistry.get().length === 3 &&
    registrationCount.get() === 3 &&
    hasText(backup[UI], "Imported 1 record(s), 1 module(s) failed")
  );

  return {
    tests: [
      { assertion: assert_starts_empty },
      { action: action_import },
      { assertion: assert_each_imported_record_is_registered },
      { action: action_import_with_unknown_module },
      { assertion: assert_partial_import_reports_failed_module },
    ],
    backup,
  };
});
