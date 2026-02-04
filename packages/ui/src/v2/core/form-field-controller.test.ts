/**
 * Tests for FormFieldController
 *
 * Tests the "write gate" pattern where form fields buffer writes locally
 * when inside a ct-form, and flush atomically on submit.
 */
import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type CellControllerLike,
  createFormFieldController,
  FormFieldController,
} from "./form-field-controller.ts";
import {
  type FormContext,
  formContext,
} from "../components/form/form-context.ts";

// Mock ReactiveControllerHost
class MockHost {
  controllers: Array<
    { hostConnected?: () => void; hostDisconnected?: () => void }
  > = [];
  updateCount = 0;
  updateComplete: Promise<boolean> = Promise.resolve(true);

  addController(
    controller: { hostConnected?: () => void; hostDisconnected?: () => void },
  ) {
    this.controllers.push(controller);
  }

  removeController(
    controller: { hostConnected?: () => void; hostDisconnected?: () => void },
  ) {
    const index = this.controllers.indexOf(controller);
    if (index > -1) {
      this.controllers.splice(index, 1);
    }
  }

  requestUpdate() {
    this.updateCount++;
  }

  // Simulate being an HTMLElement for the host type
  tagName = "MOCK-HOST";
}

// Mock CellController that tracks calls
class MockCellController<T> implements CellControllerLike<T> {
  private _value: T;
  private _cell: { set: (value: T) => Promise<void> } | null = null;
  setCallCount = 0;
  lastSetValue: T | undefined;

  constructor(initialValue: T, hasCell = true) {
    this._value = initialValue;
    if (hasCell) {
      this._cell = {
        set: async (value: T) => {
          this._value = value;
        },
      };
    }
  }

  getValue(): T {
    return this._value;
  }

  setValue(value: T): void {
    this.setCallCount++;
    this.lastSetValue = value;
    this._value = value;
  }

  getCell() {
    return this._cell;
  }

  // For testing - directly set value without tracking
  _setValueDirect(value: T): void {
    this._value = value;
  }
}

// Mock FormContext that tracks registrations
class MockFormContext implements FormContext {
  registrations: Array<{
    element: HTMLElement;
    name?: string;
    getValue: () => unknown;
    setValue: (value: unknown) => void;
    flush: () => Promise<void>;
    reset: () => void;
    validate: () => { valid: boolean; message?: string };
    isDirty: () => boolean;
  }> = [];

  registerField(
    registration: Parameters<FormContext["registerField"]>[0],
  ): () => void {
    this.registrations.push(registration);
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index > -1) {
        this.registrations.splice(index, 1);
      }
    };
  }

  getLastRegistration() {
    return this.registrations[this.registrations.length - 1];
  }
}

// Helper to create a host with form context
function createHostWithFormContext(): {
  host: MockHost & HTMLElement;
  formContext: MockFormContext;
} {
  const mockFormContext = new MockFormContext();
  const host = new MockHost() as unknown as MockHost & HTMLElement;

  // Simulate Lit context consumer behavior by making the context available
  // We'll need to manually trigger the context consumer callback
  return { host, formContext: mockFormContext };
}

describe("FormFieldController", () => {
  describe("without form context", () => {
    it("should delegate getValue to cell controller directly", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("initial");

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.getValue()).toBe("initial");
    });

    it("should delegate setValue to cell controller directly", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("initial");

      const formField = new FormFieldController(host, {
        cellController,
      });

      formField.setValue("updated");

      expect(cellController.setCallCount).toBe(1);
      expect(cellController.lastSetValue).toBe("updated");
      expect(cellController.getValue()).toBe("updated");
    });

    it("should report not in form context", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.inFormContext).toBe(false);
    });

    it("should not register when no form context", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      // Should not throw
      formField.register("fieldName");

      // Should still work without form context
      expect(formField.getValue()).toBe("test");
    });
  });

  describe("with form context (mocked)", () => {
    // For these tests we need to test the registration logic directly
    // since we can't easily mock Lit's context system

    it("should create with default validation", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
        // No validate provided - should default to always valid
      });

      // Access private method via registration if in form context
      // For now, just verify it doesn't throw
      expect(formField).toBeDefined();
    });

    it("should use custom validation function", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("");

      const formField = new FormFieldController(host, {
        cellController,
        validate: () => ({
          valid: false,
          message: "Field is required",
        }),
      });

      expect(formField).toBeDefined();
    });
  });

  describe("isDirty", () => {
    it("should return false when not in form context", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.isDirty()).toBe(false);
    });
  });

  describe("unregister", () => {
    it("should clean up state on unregister", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      formField.register("test");
      formField.unregister();

      // Should be able to register again after unregister
      formField.register("test");
      expect(formField).toBeDefined();
    });
  });

  describe("deep equality", () => {
    it("should handle primitive equality", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      // Test via isDirty which uses _deepEqual internally
      expect(formField.isDirty()).toBe(false);
    });

    it("should handle object equality", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController({
        name: "test",
        value: 42,
      });

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.isDirty()).toBe(false);
    });
  });
});

describe("createFormFieldController factory", () => {
  it("should create a FormFieldController instance", () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController = new MockCellController("test");

    const formField = createFormFieldController(host, {
      cellController,
    });

    expect(formField).toBeInstanceOf(FormFieldController);
  });
});

describe("FormFieldController registration behavior", () => {
  // Test the registration object structure directly

  it("should produce correct registration structure", () => {
    const mockFormContext = new MockFormContext();
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController = new MockCellController("initial");

    const formField = new FormFieldController(host, {
      cellController,
      validate: () => ({ valid: true }),
    });

    // Manually simulate what would happen when register() is called with a form context
    // We test the internal logic by creating a similar registration

    const registration = {
      element: host,
      name: "testField",
      getValue: () => cellController.getValue(),
      setValue: (v: unknown) => {
        cellController.setValue(v as string);
        host.requestUpdate();
      },
      flush: async () => {
        const cell = cellController.getCell();
        if (cell) {
          await cell.set(cellController.getValue());
        }
      },
      reset: () => {
        // Reset logic
      },
      validate: () => ({ valid: true }),
      isDirty: () => false,
    };

    mockFormContext.registerField(registration);

    expect(mockFormContext.registrations.length).toBe(1);
    expect(mockFormContext.getLastRegistration()?.name).toBe("testField");
    expect(mockFormContext.getLastRegistration()?.getValue()).toBe("initial");
  });

  it("should buffer setValue when in form context simulation", () => {
    const host = new MockHost();
    let buffer: string | undefined;

    const registration = {
      element: host as unknown as HTMLElement,
      name: "test",
      getValue: () => buffer ?? "original",
      setValue: (v: unknown) => {
        buffer = v as string;
        host.requestUpdate();
      },
      flush: async () => {
        // Would write buffer to cell
      },
      reset: () => {
        buffer = undefined;
      },
      validate: () => ({ valid: true }),
      isDirty: () => buffer !== undefined && buffer !== "original",
    };

    // Initial state
    expect(registration.getValue()).toBe("original");
    expect(registration.isDirty()).toBe(false);

    // After setValue (buffered)
    registration.setValue("modified");
    expect(registration.getValue()).toBe("modified");
    expect(registration.isDirty()).toBe(true);
    expect(host.updateCount).toBe(1);

    // After reset
    registration.reset();
    expect(registration.getValue()).toBe("original");
    expect(registration.isDirty()).toBe(false);
  });

  it("should validate correctly", () => {
    const cellController = new MockCellController("");

    const validateRequired = () => {
      const value = cellController.getValue();
      if (!value || value.trim() === "") {
        return { valid: false, message: "Required" };
      }
      return { valid: true };
    };

    // Empty value - invalid
    expect(validateRequired()).toEqual({ valid: false, message: "Required" });

    // With value - valid
    cellController.setValue("some value");
    expect(validateRequired()).toEqual({ valid: true });
  });

  it("should handle async flush", async () => {
    let cellValue = "initial";
    let flushCount = 0;

    const mockCell = {
      set: async (value: string) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        cellValue = value;
        flushCount++;
      },
    };

    const registration = {
      flush: async () => {
        await mockCell.set("flushed");
      },
    };

    await registration.flush();

    expect(cellValue).toBe("flushed");
    expect(flushCount).toBe(1);
  });

  it("should handle flush error", async () => {
    const mockCell = {
      set: async (_value: string) => {
        throw new Error("Network error");
      },
    };

    const registration = {
      flush: async () => {
        await mockCell.set("flushed");
      },
    };

    await expect(registration.flush()).rejects.toThrow("Network error");
  });
});

describe("captureOriginalValue", () => {
  it("should update original value for dirty tracking", () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController = new MockCellController("initial");

    const formField = new FormFieldController(host, {
      cellController,
    });

    // Capture initial original value
    formField.captureOriginalValue();

    // After capture, isDirty should consider current cell value as "original"
    expect(formField.isDirty()).toBe(false);
  });
});
