/**
 * Tests for VDOM event serialization.
 */

import { assertEquals } from "@std/assert";
import {
  $conn,
  CellHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  type DomEventMessage,
  isDomEventMessage,
  serializeEvent,
} from "../src/main/events.ts";

/** A handle standing in for a bound one; only its ref and class are read. */
function makeHandle(): CellHandle {
  return new CellHandle(
    { [$conn]: () => ({}) } as unknown as RuntimeClient,
    { id: "of:fid1:abc", space: "did:key:z6Mk", scope: "space", path: [] },
  );
}

// Mock Event class for testing (Deno doesn't have full DOM by default)
class MockEvent {
  type: string;
  target: unknown;
  isTrusted: boolean;

  constructor(
    type: string,
    init?: { target?: unknown; isTrusted?: boolean },
  ) {
    this.type = type;
    this.target = init?.target;
    this.isTrusted = init?.isTrusted ?? false;
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

  await t.step("carries a bound `value` as the link to its cell", () => {
    // The case this arm exists for: `cf-input`, `cf-tabs` and `cf-calendar`
    // each declare `value` as `CellHandle<string> | string`, and a bound one
    // holds the handle the applicator installed.
    const handle = makeHandle();
    const event = new MockEvent("input", {
      target: { value: handle },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, handle.toJSON());
  });

  await t.step("resolves a `toJSON()` on a target's `value`", () => {
    // `value` is the one target property no scalar covers, so what is neither a
    // cell nor a scalar still reaches the general conversion -- which resolves
    // a `toJSON()`. The other four judge such a value by their own scalar and
    // leave it out instead.
    const link = { "/": { "link@1": { id: "of:fid1:abc" } } };
    const speaksForItself = new (class {
      toJSON() {
        return link;
      }
    })();
    const event = new MockEvent("input", {
      target: { value: speaksForItself },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, link);
  });

  await t.step("describes a target value with no JSON form", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const event = new MockEvent("input", {
      target: { value: circular },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, "[object Object]");
  });

  await t.step("describes a target value that refuses coercion too", () => {
    // `String()` reaches for `toString` and `valueOf`; a null-prototype object
    // has neither, and a circular one has no JSON form either, so both routes
    // out of the conversion throw. The event still has to reach the worker.
    const bare = Object.create(null);
    bare.self = bare;
    const event = new MockEvent("input", {
      target: { value: bare },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, "/unconvertible");
  });

  await t.step("captures trusted provenance", () => {
    const event = new MockEvent("click", {
      isTrusted: true,
    }) as unknown as Event;
    const serialized = serializeEvent(event);
    assertEquals(serialized.provenance, {
      origin: "dom",
      trusted: true,
    });
  });

  await t.step("captures data-ui markers from composed event paths", () => {
    const event = new MockEvent("click", {
      isTrusted: true,
      target: { dataset: { ordinaryHandlerData: "preserved" } },
    }) as MockEvent & { composedPath: () => unknown[] };
    event.composedPath = () => [
      { dataset: { cfButton: "" } },
      { dataset: { uiAction: "TrustedSaveTitle" } },
      {
        dataset: {
          uiPattern: "TrustedSaveSurface",
          uiEventIntegrity: "TrustedSaveSurface",
        },
      },
      event.target,
    ];

    const serialized = serializeEvent(event as unknown as Event);

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

  await t.step("serializes a multiple-select target's chosen options", () => {
    // `serializeEvent` recognizes the option list by its DOM type, so the test
    // has to supply that type: Deno has no DOM, and the global is what the
    // production check reads.
    class TestHTMLCollection extends Array<{ value: string }> {}
    const globals = globalThis as { HTMLCollection?: unknown };
    const savedHTMLCollection = globals.HTMLCollection;
    globals.HTMLCollection = TestHTMLCollection;
    try {
      const selectedOptions = TestHTMLCollection.from([
        { value: "a" },
        { value: "c" },
      ]);
      const target = { value: "a", selectedOptions };
      const event = new MockEvent("change", { target }) as unknown as Event;

      const serialized = serializeEvent(event);
      assertEquals(serialized.target?.selectedOptions, [
        { value: "a" },
        { value: "c" },
      ]);
    } finally {
      globals.HTMLCollection = savedHTMLCollection;
    }
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

  await t.step("omits an event property whose type is not the DOM's", () => {
    // `SerializedEvent` declares `key` a `string`. What is read is a property of
    // whatever object was dispatched, so the copy checks rather than trusts, and
    // a value of some other type is left out instead of landing in a field that
    // cannot hold it.
    const event = new MockEvent("keydown") as unknown as Event;
    (event as unknown as Record<string, unknown>).key = { not: "a string" };

    const serialized = serializeEvent(event);

    assertEquals("key" in serialized, false);
  });

  await t.step("carries a cell-bound target property as the link to it", () => {
    // A bound property holds the handle the applicator installed, and what
    // crosses is the link that reaches the cell. `cf-tab` declares `selected` a
    // `boolean` and can still be handed a cell for it, which is why every
    // target property is `T | SigilLink` rather than `T`.
    const handle = makeHandle();
    const event = new MockEvent("cf-tab-select", {
      target: { selected: handle },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.selected, handle.toJSON());
  });

  await t.step("does not take a `toJSON()` of its own for a cell", () => {
    // The recognition is by class. Something merely offering a `toJSON()` is
    // not a cell, so `selected` is judged by its scalar, which it fails.
    const notAHandle = new (class {
      toJSON() {
        return { "/": { "link@1": { id: "of:fid1:abc" } } };
      }
    })();
    const event = new MockEvent("cf-tab-select", {
      target: { selected: notAHandle },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.selected, undefined);
  });

  await t.step("omits a target property that fails its own scalar", () => {
    const event = new MockEvent("input", {
      target: { name: 42, value: "kept" },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.name, undefined);
    assertEquals(serialized.target?.value, "kept");
  });

  await t.step("omits undefined properties", () => {
    const event = new MockEvent("click") as unknown as Event;
    const serialized = serializeEvent(event);

    // Should only have type
    assertEquals(Object.keys(serialized), ["type"]);
  });
});
