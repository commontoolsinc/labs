import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFSubmitInput } from "./index.ts";

// The unit runner uses Lit's SSR DOM shim: instances and direct method/lifecycle
// calls work, but there is no real shadow-DOM rendering. These tests exercise
// the component's logic by constructing an instance and driving its handlers
// with realistic mock events, asserting the observable value / clear behavior.
// Full rendered-DOM interaction is covered by the browser integration tests
// (home-profile / shared-profile).

type Internals = {
  _onInput(event: Event): void;
  _onContainerClick(event: Event): void;
  _onSubmit(event: Event): void;
  _submitting: boolean;
  _seeded: boolean;
  willUpdate(changed: Map<string, unknown>): void;
  render(): unknown;
};

function internals(el: CFSubmitInput): Internals {
  return el as unknown as Internals;
}

// A click event whose composed path optionally runs through a CF-BUTTON, with a
// stopPropagation spy.
function clickEvent(throughButton: boolean): Event & { stopped: boolean } {
  const path = throughButton
    ? [{ tagName: "INPUT" }, { tagName: "CF-BUTTON" }]
    : [{ tagName: "INPUT" }, { tagName: "DIV" }];
  const event = {
    stopped: false,
    composedPath: () => path,
    stopPropagation() {
      (this as { stopped: boolean }).stopped = true;
    },
  };
  return event as unknown as Event & { stopped: boolean };
}

// Lets a pending setTimeout(0) callback run.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("CFSubmitInput", () => {
  it("is defined and registered", () => {
    expect(CFSubmitInput).toBeDefined();
    expect(customElements.get("cf-submit-input")).toBe(CFSubmitInput);
  });

  it("has the expected property defaults", () => {
    const el = new CFSubmitInput();
    expect(el.placeholder).toBe("");
    expect(el.buttonText).toBe("Submit");
    expect(el.inputId).toBe("");
    expect(el.disabled).toBe(false);
    expect(el.initialValue).toBe("");
    expect(el.value).toBe("");
  });

  describe("willUpdate / initialValue seeding", () => {
    it("seeds value from initialValue once on first update", () => {
      const el = new CFSubmitInput();
      el.initialValue = "Ada";
      internals(el).willUpdate(new Map());
      expect(el.value).toBe("Ada");
      expect(internals(el)._seeded).toBe(true);
    });

    it("does not re-seed after the first time", () => {
      const el = new CFSubmitInput();
      el.initialValue = "Ada";
      internals(el).willUpdate(new Map());
      // A later initialValue change is ignored; the field is uncontrolled.
      el.initialValue = "Bob";
      internals(el).willUpdate(new Map());
      expect(el.value).toBe("Ada");
    });

    it("does not seed when initialValue is empty", () => {
      const el = new CFSubmitInput();
      internals(el).willUpdate(new Map());
      expect(el.value).toBe("");
      expect(internals(el)._seeded).toBe(false);
    });
  });

  it("_onInput mirrors the inner input value into `value`", () => {
    const el = new CFSubmitInput();
    internals(el)._onInput({ target: { value: "typed" } } as unknown as Event);
    expect(el.value).toBe("typed");
  });

  describe("_onContainerClick", () => {
    it("stops a click that does not run through the submit button", () => {
      const el = new CFSubmitInput();
      const event = clickEvent(false);
      internals(el)._onContainerClick(event);
      expect(event.stopped).toBe(true);
    });

    it("lets a click through the submit button reach the host", () => {
      const el = new CFSubmitInput();
      const event = clickEvent(true);
      internals(el)._onContainerClick(event);
      expect(event.stopped).toBe(false);
    });
  });

  describe("_onSubmit", () => {
    it("ignores an empty submit", async () => {
      const el = new CFSubmitInput();
      el.value = "   ";
      internals(el)._onSubmit(clickEvent(true));
      expect(internals(el)._submitting).toBe(false);
      await tick();
      expect(el.value).toBe("   ");
    });

    it("clears the field after the submit click is handled", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      internals(el)._onSubmit(clickEvent(true));
      // In-flight immediately after the click, before the deferred clear.
      expect(internals(el)._submitting).toBe(true);
      expect(el.value).toBe("Ada");
      await tick();
      expect(el.value).toBe("");
      expect(internals(el)._submitting).toBe(false);
    });

    it("stops a re-entrant click and does not schedule a second clear", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      internals(el)._onSubmit(clickEvent(true));
      const second = clickEvent(true);
      internals(el)._onSubmit(second);
      expect(second.stopped).toBe(true);
      await tick();
      // The first submit's clear still runs.
      expect(el.value).toBe("");
    });

    it("does not wipe a value the user retyped before the clear runs", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      internals(el)._onSubmit(clickEvent(true));
      // A new name typed before the deferred clear fires must survive.
      el.value = "Alan";
      await tick();
      expect(el.value).toBe("Alan");
      // The in-flight flag still resets, so a later submit is not blocked.
      expect(internals(el)._submitting).toBe(false);
    });

    it("clears the inner input element when present", async () => {
      const el = new CFSubmitInput();
      const fakeInput = { value: "Ada" } as HTMLInputElement;
      Object.defineProperty(el, "_input", {
        configurable: true,
        get: () => fakeInput,
      });
      el.value = "Ada";
      internals(el)._onSubmit(clickEvent(true));
      await tick();
      expect(el.value).toBe("");
      expect(fakeInput.value).toBe("");
    });
  });

  it("render() produces a template", () => {
    const el = new CFSubmitInput();
    el.inputId = "name";
    el.value = "Ada";
    el.placeholder = "Your name...";
    el.buttonText = "Create profile";
    expect(internals(el).render()).toBeDefined();
  });
});
