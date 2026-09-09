import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ClientNotificationType,
  NotificationType,
  RequestType,
} from "@/protocol/types.ts";

// The runtime the rest of the repository describes has pieces, not pages. The
// protocol enums are the one place a wire value can drift away from that
// vocabulary without a compile error, because a value is a string and a member
// name is only read by people.
const PAGE = /page/i;

// Every operation addressed to one piece. Their wire values share the `piece:`
// namespace, so a member renamed without its value shows up here.
const PIECE_OPERATIONS = [
  RequestType.PieceCreate,
  RequestType.PieceGet,
  RequestType.PieceGetSlug,
  RequestType.PieceRemove,
  RequestType.PieceStart,
  RequestType.PieceStop,
  RequestType.PieceGetAll,
  RequestType.PieceSynced,
  RequestType.PieceGetSource,
  RequestType.PieceGetSourceRevision,
  RequestType.PieceClone,
  RequestType.PieceUpdateSource,
];

describe("types", () => {
  describe("RequestType", () => {
    it("declares no member named after a page", () => {
      expect(Object.keys(RequestType).filter((name) => PAGE.test(name)))
        .toEqual([]);
    });

    it("declares no wire value named after a page", () => {
      expect(Object.values(RequestType).filter((value) => PAGE.test(value)))
        .toEqual([]);
    });

    it("gives every piece operation a wire value in the `piece:` namespace", () => {
      expect(PIECE_OPERATIONS.filter((value) => !value.startsWith("piece:")))
        .toEqual([]);
    });
  });

  describe("NotificationType", () => {
    it("declares no member named after a page", () => {
      expect(Object.keys(NotificationType).filter((name) => PAGE.test(name)))
        .toEqual([]);
    });

    it("declares no wire value named after a page", () => {
      expect(
        Object.values(NotificationType).filter((value) => PAGE.test(value)),
      ).toEqual([]);
    });
  });

  describe("ClientNotificationType", () => {
    it("declares no member named after a page", () => {
      expect(
        Object.keys(ClientNotificationType).filter((name) => PAGE.test(name)),
      ).toEqual([]);
    });

    it("declares no wire value named after a page", () => {
      expect(
        Object.values(ClientNotificationType).filter((value) =>
          PAGE.test(value)
        ),
      ).toEqual([]);
    });
  });
});
