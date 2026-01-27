/**
 * Tests for VDOM event serialization.
 */

import { assertEquals } from "@std/assert";
import {
  type DomEventMessage,
  isDomEventMessage,
  serializeEvent,
} from "@commontools/runtime-client";

// Mock Event class for testing (Deno doesn't have full DOM by default)
class MockEvent {
  type: string;
  target: unknown;

  constructor(
    type: string,
    init?: { target?: unknown },
  ) {
    this.type = type;
    this.target = init?.target;
  }
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
      target?: unknown;
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
      target?: unknown;
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
      target?: unknown;
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
      target?: unknown;
    } = {},
  ) {
    super(type, init);
    this.detail = init.detail;
  }
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
    const event = new MockEvent("click") as unknown as Event;
    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "click");
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
    }) as unknown as Event;

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
    }) as unknown as Event;

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
    }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "input");
    assertEquals(serialized.inputType, "insertText");
    assertEquals(serialized.data, "a");
  });

  await t.step("serializes target properties", () => {
    const target = {
      name: "myInput",
      value: "hello",
      checked: true,
      selected: false,
      selectedIndex: 2,
    };
    const event = new MockEvent("change", { target }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.target?.name, "myInput");
    assertEquals(serialized.target?.value, "hello");
    assertEquals(serialized.target?.checked, true);
    assertEquals(serialized.target?.selected, false);
    assertEquals(serialized.target?.selectedIndex, 2);
  });

  await t.step("serializes dataset", () => {
    const target = {
      dataset: { foo: "bar", baz: "qux" },
    };
    const event = new MockEvent("click", { target }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.target?.dataset?.foo, "bar");
    assertEquals(serialized.target?.dataset?.baz, "qux");
  });

  await t.step("serializes custom event detail", () => {
    const event = new MockCustomEvent("custom", {
      detail: { message: "hello", count: 42 },
    }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "custom");
    assertEquals((serialized.detail as { message: string }).message, "hello");
    assertEquals((serialized.detail as { count: number }).count, 42);
  });

  await t.step("omits undefined properties", () => {
    const event = new MockEvent("click") as unknown as Event;
    const serialized = serializeEvent(event);

    // Should only have type
    assertEquals(Object.keys(serialized), ["type"]);
  });
});
