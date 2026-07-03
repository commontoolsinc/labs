/**
 * Tests for VDOM event serialization.
 */

import { assertEquals } from "@std/assert";
import {
  type DomEventMessage,
  isDomEventMessage,
  serializeEvent,
} from "../src/main/events.ts";

// Mock Event class for testing.
class MockEvent implements Event {
  type: string;
  target: EventTarget | null;
  isTrusted: boolean;
  bubbles = false;
  cancelBubble = false;
  cancelable = false;
  composed = false;
  currentTarget: EventTarget | null = null;
  defaultPrevented = false;
  eventPhase = Event.NONE;
  returnValue = true;
  srcElement: EventTarget | null = null;
  timeStamp = 0;
  NONE = Event.NONE;
  CAPTURING_PHASE = Event.CAPTURING_PHASE;
  AT_TARGET = Event.AT_TARGET;
  BUBBLING_PHASE = Event.BUBBLING_PHASE;

  constructor(
    type: string,
    init?: { target?: EventTarget | null; isTrusted?: boolean },
  ) {
    this.type = type;
    this.target = init?.target ?? null;
    this.isTrusted = init?.isTrusted ?? false;
  }

  composedPath(): EventTarget[] {
    return [];
  }

  initEvent(): void {}

  preventDefault(): void {}

  stopImmediatePropagation(): void {}

  stopPropagation(): void {}
}

class MockKeyboardEvent extends MockEvent {
  key: string;
  code: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;

  constructor(
    type: string,
    init: {
      key?: string;
      code?: string;
      repeat?: boolean;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      target?: EventTarget | null;
    } = {},
  ) {
    super(type, init);
    this.key = init.key ?? "";
    this.code = init.code ?? "";
    this.repeat = init.repeat ?? false;
    this.altKey = init.altKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}

class MockMouseEvent extends MockEvent {
  button: number;
  buttons: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;

  constructor(
    type: string,
    init: {
      button?: number;
      buttons?: number;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      target?: EventTarget | null;
    } = {},
  ) {
    super(type, init);
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.altKey = init.altKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}

class MockInputEvent extends MockEvent {
  inputType: string;
  data: string | null;

  constructor(
    type: string,
    init: {
      inputType?: string;
      data?: string | null;
      target?: EventTarget | null;
    } = {},
  ) {
    super(type, init);
    this.inputType = init.inputType ?? "";
    this.data = init.data ?? null;
  }
}

class MockCustomEvent extends MockEvent {
  detail: unknown;

  constructor(
    type: string,
    init: {
      detail?: unknown;
      target?: EventTarget | null;
    } = {},
  ) {
    super(type, init);
    this.detail = init.detail;
  }
}

function eventTarget<T extends object>(fields: T): EventTarget & T {
  return Object.assign(fields, {
    addEventListener: () => {},
    dispatchEvent: () => true,
    removeEventListener: () => {},
  });
}

Deno.test("events - isDomEventMessage", async (t) => {
  await t.step("returns true for valid DomEventMessage", () => {
    const message: DomEventMessage = {
      type: "dom-event",
      handlerId: 1,
      event: { type: "click" },
      nodeId: 42,
    };
    assertEquals(isDomEventMessage(message), true);
  });

  await t.step("returns false for null", () => {
    assertEquals(isDomEventMessage(null), false);
  });

  await t.step("returns false for non-object", () => {
    assertEquals(isDomEventMessage("string"), false);
    assertEquals(isDomEventMessage(42), false);
  });

  await t.step("returns false for wrong type", () => {
    assertEquals(isDomEventMessage({ type: "other" }), false);
  });

  await t.step("returns false for missing handlerId", () => {
    assertEquals(
      isDomEventMessage({ type: "dom-event", event: {}, nodeId: 1 }),
      false,
    );
  });

  await t.step("returns false for missing event", () => {
    assertEquals(
      isDomEventMessage({ type: "dom-event", handlerId: 1, nodeId: 1 }),
      false,
    );
  });

  await t.step("returns false for missing nodeId", () => {
    assertEquals(
      isDomEventMessage({ type: "dom-event", handlerId: 1, event: {} }),
      false,
    );
  });
});

Deno.test("events - serializeEvent", async (t) => {
  await t.step("serializes basic event type", () => {
    const event = new MockEvent("click");
    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "click");
  });

  await t.step("captures trusted provenance", () => {
    const event = new MockEvent("click", {
      isTrusted: true,
    });
    const serialized = serializeEvent(event);
    assertEquals(serialized.provenance, {
      origin: "dom",
      trusted: true,
    });
  });

  await t.step("captures data-ui markers from composed event paths", () => {
    const event = new MockEvent("click", {
      isTrusted: true,
      target: eventTarget({
        dataset: { ordinaryHandlerData: "preserved" },
      }),
    });
    event.composedPath = () => [
      eventTarget({ dataset: { cfButton: "" } }),
      eventTarget({ dataset: { uiAction: "TrustedSaveTitle" } }),
      eventTarget({
        dataset: {
          uiPattern: "TrustedSaveSurface",
          uiEventIntegrity: "TrustedSaveSurface",
        },
      }),
      event.target!,
    ];

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.dataset, {
      ordinaryHandlerData: "preserved",
    });
    assertEquals(serialized.provenance, {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "TrustedSaveSurface",
        eventIntegrity: ["TrustedSaveSurface"],
        uiContractDataset: {
          uiAction: "TrustedSaveTitle",
        },
      },
    });
  });

  await t.step("serializes keyboard event properties", () => {
    const event = new MockKeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      repeat: false,
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    });

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "keydown");
    assertEquals(serialized.key, "Enter");
    assertEquals(serialized.code, "Enter");
    assertEquals(serialized.repeat, false);
    assertEquals(serialized.altKey, true);
    assertEquals(serialized.ctrlKey, false);
    assertEquals(serialized.metaKey, true);
    assertEquals(serialized.shiftKey, false);
  });

  await t.step("serializes mouse event properties", () => {
    const event = new MockMouseEvent("click", {
      button: 0,
      buttons: 1,
      shiftKey: true,
    });

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "click");
    assertEquals(serialized.button, 0);
    assertEquals(serialized.buttons, 1);
    assertEquals(serialized.shiftKey, true);
  });

  await t.step("serializes input event properties", () => {
    const event = new MockInputEvent("input", {
      inputType: "insertText",
      data: "a",
    });

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "input");
    assertEquals(serialized.inputType, "insertText");
    assertEquals(serialized.data, "a");
  });

  await t.step("serializes target properties", () => {
    const target = eventTarget({
      name: "myInput",
      value: "hello",
      checked: true,
      selected: false,
      selectedIndex: 2,
    });
    const event = new MockEvent("change", { target });

    const serialized = serializeEvent(event);
    assertEquals(serialized.target?.name, "myInput");
    assertEquals(serialized.target?.value, "hello");
    assertEquals(serialized.target?.checked, true);
    assertEquals(serialized.target?.selected, false);
    assertEquals(serialized.target?.selectedIndex, 2);
  });

  await t.step("serializes dataset", () => {
    const target = eventTarget({
      dataset: { foo: "bar", baz: "qux" },
    });
    const event = new MockEvent("click", { target });

    const serialized = serializeEvent(event);
    assertEquals(serialized.target?.dataset?.foo, "bar");
    assertEquals(serialized.target?.dataset?.baz, "qux");
  });

  await t.step("serializes custom event detail", () => {
    const event = new MockCustomEvent("custom", {
      detail: { message: "hello", count: 42 },
    });

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "custom");
    assertEquals((serialized.detail as { message: string }).message, "hello");
    assertEquals((serialized.detail as { count: number }).count, 42);
  });

  await t.step("omits undefined properties", () => {
    const event = new MockEvent("click");
    const serialized = serializeEvent(event);

    // Should only have type
    assertEquals(Object.keys(serialized), ["type"]);
  });
});
