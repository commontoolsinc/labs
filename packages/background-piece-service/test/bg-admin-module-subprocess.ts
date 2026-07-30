import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import type { BGPieceEntry } from "../bgAdmin.tsx";
import adminPattern, {
  deletePiece,
  DISABLED_VIA_UI,
  fromNow,
  pieceRowPattern,
  removePieceFromList,
  renderDataForPiece,
  statusIndicator,
  statusIndicatorData,
  toggledPiece,
  togglePiece,
} from "../bgAdmin.tsx";

const TEST_DID = "did:key:z6Mktestspace";
const OTHER_DID = "did:key:z6Mkotherspace";
const PIECE_ID = `fid1:${"a".repeat(54)}`;
const OTHER_PIECE_ID = `fid1:${"b".repeat(54)}`;

class FakeEntryCell {
  constructor(public value: BGPieceEntry) {}

  get(): BGPieceEntry {
    return this.value;
  }

  set(value: BGPieceEntry) {
    this.value = value;
  }
}

function pieceEntry(
  overrides: Partial<BGPieceEntry> = {},
): BGPieceEntry {
  return {
    space: TEST_DID,
    pieceId: PIECE_ID,
    integration: "gmail",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    disabledAt: 0,
    lastRun: 0,
    status: "Initializing",
    ...overrides,
  };
}

const now = new Date("2026-06-23T12:00:00Z");
assertEquals(fromNow(new Date("2026-06-23T12:00:01Z"), now), "in the future");
assertEquals(fromNow(now, now), "now");
assertEquals(fromNow(new Date("2026-06-23T11:59:45Z"), now), "15 seconds ago");
assertEquals(fromNow(new Date("2026-06-23T11:30:00Z"), now), "30 minutes ago");
assertEquals(fromNow(new Date("2026-06-23T08:00:00Z"), now), "4 hours ago");
assertEquals(fromNow(new Date("2026-06-20T12:00:00Z"), now), "3 days ago");
assertEquals(fromNow(new Date("2024-06-23T12:00:00Z"), now), "2 years ago");

const first = pieceEntry();
const second = pieceEntry({ space: OTHER_DID, pieceId: OTHER_PIECE_ID });
const list = [first, second];
assertEquals(removePieceFromList(list, first), [second]);
assertEquals(list, [first, second]);
assertStrictEquals(
  removePieceFromList(list, { space: "missing", pieceId: "missing" }),
  list,
);

const disabled = toggledPiece(first);
assert(disabled.disabledAt > 0);
assertEquals(disabled.status, DISABLED_VIA_UI);
assertEquals(
  toggledPiece({ ...first, disabledAt: Date.now(), status: "Failed" }),
  { ...first, disabledAt: 0, status: "Initializing..." },
);

const renderNow = new Date(1_700_000_005_000);
const success = renderDataForPiece(
  { ...pieceEntry(), status: "Success", lastRun: 1_700_000_004_000 },
  renderNow,
);
assertEquals(success.name, "#pace/#aaaa");
assertEquals(success.integration, "gmail");
assertEquals(success.statusDisplay, "");
assertStringIncludes(success.details, "Last run 1 seconds ago");

const failed = renderDataForPiece(pieceEntry({ status: "Failed" }), renderNow);
assertEquals(failed.statusDisplay, "Failed");
assertStringIncludes(failed.details, "Last run never");

assertEquals(statusIndicatorData("Success", 0), {
  statusColor: "#4CAF50",
  statusTitle: "Running",
});
assertEquals(statusIndicatorData("Initializing", 0), {
  statusColor: "#FFC107",
  statusTitle: "Initializing",
});
assertEquals(statusIndicatorData(DISABLED_VIA_UI, 1), {
  statusColor: "#9E9E9E",
  statusTitle: DISABLED_VIA_UI,
});
assertEquals(statusIndicatorData("Failed", 1), {
  statusColor: "#F44336",
  statusTitle: "Failed",
});
assert(statusIndicator("Success", 0));

const piece = new FakeEntryCell(pieceEntry());
const pieces = {
  value: [piece.value],
  setCount: 0,
  get() {
    return this.value;
  },
  set(value: BGPieceEntry[]) {
    this.setCount++;
    this.value = value;
  },
};
(togglePiece as never as {
  implementation: (
    event: never,
    state: { piece: FakeEntryCell },
  ) => void;
}).implementation(undefined as never, { piece });
assertEquals(piece.value.status, DISABLED_VIA_UI);
(deletePiece as never as {
  implementation: (
    event: never,
    state: {
      piece: FakeEntryCell;
      pieces: typeof pieces;
    },
  ) => void;
}).implementation(undefined as never, { piece, pieces });
assertEquals(pieces.value, []);
assertEquals(pieces.setCount, 1);

(deletePiece as never as {
  implementation: (
    event: never,
    state: {
      piece: FakeEntryCell;
      pieces: typeof pieces;
    },
  ) => void;
}).implementation(undefined as never, { piece, pieces });
assertEquals(pieces.setCount, 1);

const patternPieces = {
  map(row: (piece: BGPieceEntry) => unknown) {
    return [row(pieceEntry({ status: "Success", lastRun: 1_700_000_004_000 }))];
  },
};
const rendered = (adminPattern as never as (
  input: { pieces: typeof patternPieces },
) => Record<string, unknown>)({ pieces: patternPieces });
assertEquals(rendered["$NAME"], "BG Updater Management New");
assert(rendered["$UI"]);
assertEquals(rendered.pieces, patternPieces);
assert(
  (pieceRowPattern as never as (
    input: { piece: BGPieceEntry; pieces: typeof patternPieces },
  ) => unknown)({
    piece: pieceEntry(),
    pieces: patternPieces,
  }),
);
