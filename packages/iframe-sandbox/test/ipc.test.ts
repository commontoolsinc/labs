import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type GuestError,
  GuestMessageType,
  IPCGuestMessageType,
  isGuestError,
  isGuestMessage,
  isIPCGuestMessage,
} from "../src/ipc.ts";

const ERROR: GuestError = {
  description: "d",
  source: "s",
  lineno: 1,
  colno: 2,
  stacktrace: "st",
};

describe("ipc", () => {
  describe("isIPCGuestMessage", () => {
    it("returns true for a message the outer frame writes", () => {
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.Ready })).toBe(true);
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.Load })).toBe(true);
      expect(
        isIPCGuestMessage({
          type: IPCGuestMessageType.OuterError,
          data: ERROR,
        }),
      ).toBe(true);
      expect(
        isIPCGuestMessage({
          type: IPCGuestMessageType.GuestError,
          data: "anything at all",
        }),
      ).toBe(true);
    });

    it("returns false for an error arm carrying nothing", () => {
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.OuterError }))
        .toBe(false);
      expect(
        isIPCGuestMessage({
          type: IPCGuestMessageType.GuestError,
          data: null,
        }),
      ).toBe(false);
    });

    it("returns false for anything that is not one of the arms", () => {
      expect(isIPCGuestMessage(undefined)).toBe(false);
      expect(isIPCGuestMessage(null)).toBe(false);
      expect(isIPCGuestMessage("ready")).toBe(false);
      expect(isIPCGuestMessage({})).toBe(false);
      expect(isIPCGuestMessage({ type: "load-document" })).toBe(false);
    });
  });

  describe("isGuestMessage", () => {
    it("returns true for each arm the protocol has", () => {
      expect(isGuestMessage({ type: GuestMessageType.Error, data: ERROR }))
        .toBe(true);
      expect(isGuestMessage({ type: GuestMessageType.Read, data: "k" }))
        .toBe(true);
      expect(isGuestMessage({ type: GuestMessageType.Subscribe, data: "k" }))
        .toBe(true);
      expect(
        isGuestMessage({
          type: GuestMessageType.Unsubscribe,
          data: ["a", "b"],
        }),
      ).toBe(true);
      expect(isGuestMessage({ type: GuestMessageType.Write, data: ["k", 1] }))
        .toBe(true);
    });

    it("returns false for an arm whose payload is the wrong shape", () => {
      expect(isGuestMessage({ type: GuestMessageType.Error, data: {} }))
        .toBe(false);
      expect(isGuestMessage({ type: GuestMessageType.Read, data: 1 }))
        .toBe(false);
      expect(isGuestMessage({ type: GuestMessageType.Subscribe, data: [1] }))
        .toBe(false);
      expect(isGuestMessage({ type: GuestMessageType.Write, data: ["k"] }))
        .toBe(false);
      expect(isGuestMessage({ type: GuestMessageType.Write, data: [1, 1] }))
        .toBe(false);
    });

    it("returns false for anything that names no arm", () => {
      expect(isGuestMessage(undefined)).toBe(false);
      expect(isGuestMessage(null)).toBe(false);
      expect(isGuestMessage({ type: "update", data: ["k", 1] })).toBe(false);
      expect(isGuestMessage({ data: ["k", 1] })).toBe(false);
      expect(isGuestMessage({ type: GuestMessageType.Write })).toBe(false);
    });
  });

  describe("isGuestError", () => {
    it("returns true for a report carrying every field", () => {
      expect(isGuestError(ERROR)).toBe(true);
    });

    it("returns false when a field is missing or mistyped", () => {
      expect(isGuestError({ ...ERROR, description: 1 })).toBe(false);
      expect(isGuestError({ ...ERROR, lineno: "1" })).toBe(false);
      const { stacktrace: _dropped, ...missing } = ERROR;
      expect(isGuestError(missing)).toBe(false);
    });
  });
});
