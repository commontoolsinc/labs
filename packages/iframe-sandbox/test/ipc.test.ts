import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  type GuestError,
  IPCGuestMessageType,
  isBridgeHostMessage,
  isBridgeRequest,
  isGuestAlarm,
  isGuestError,
  isIPCGuestMessage,
} from "../src/ipc.ts";

const ERROR: GuestError = {
  description: "description",
  source: "source",
  lineno: 1,
  colno: 2,
  stacktrace: "stack",
};

const HEADER = {
  protocol: BRIDGE_PROTOCOL,
  version: BRIDGE_VERSION,
};

describe("ipc", () => {
  describe("bridge messages", () => {
    it("accepts complete request operations", () => {
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "describe",
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 1,
        operation: "write",
        resource: "count",
        value: 1,
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 2,
        operation: "call",
        resource: "database",
        method: "query",
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 3,
        operation: "subscribe",
        resource: "count",
        subscription: "s1",
      })).toBe(true);
    });

    it("rejects incomplete or foreign requests", () => {
      expect(isBridgeRequest(undefined)).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "call",
        resource: "database",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "read",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "future-version",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        version: BRIDGE_VERSION + 1,
        type: "request",
        id: 0,
        operation: "describe",
      })).toBe(false);
    });

    it("accepts complete responses and subscription events", () => {
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "response",
        id: 0,
        ok: true,
      })).toBe(true);
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "response",
        id: 1,
        ok: false,
        error: { code: "failed", message: "No." },
      })).toBe(true);
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "event",
        subscription: "s1",
      })).toBe(true);
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "response",
        id: 1,
        ok: false,
      })).toBe(false);
    });
  });

  describe("outer-frame messages", () => {
    it("recognizes lifecycle messages and complete errors", () => {
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.Ready })).toBe(true);
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.Load })).toBe(true);
      expect(isIPCGuestMessage({
        type: IPCGuestMessageType.OuterError,
        data: ERROR,
      })).toBe(true);
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.OuterError }))
        .toBe(false);
    });

    it("recognizes only complete guest alarms", () => {
      expect(isGuestError(ERROR)).toBe(true);
      expect(isGuestError({ ...ERROR, lineno: "1" })).toBe(false);
      expect(isGuestAlarm({ type: "error", data: ERROR })).toBe(true);
      expect(isGuestAlarm({ type: "write", data: ERROR })).toBe(false);
    });
  });
});
