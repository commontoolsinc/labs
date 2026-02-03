/**
 * FormFieldController - Reactive controller for form field buffering
 *
 * This controller implements the "write gate" pattern where form fields
 * buffer writes locally when inside a ct-form, and flush atomically on submit.
 *
 * When NOT in a form context, getValue/setValue delegate directly to the
 * cell controller for immediate writes (existing behavior).
 *
 * When IN a form context, getValue returns buffered value (falling back to cell),
 * and setValue updates the buffer. The form coordinates flush/reset across fields.
 *
 * @example
 * ```typescript
 * class MyFormField extends BaseElement {
 *   private _cellController = createStringCellController(this, { ... });
 *   private _formField = new FormFieldController(this, {
 *     cellController: this._cellController,
 *     validate: () => ({
 *       valid: this.checkValidity(),
 *       message: this.validationMessage,
 *     }),
 *   });
 *
 *   private getValue(): string {
 *     return this._formField.getValue();
 *   }
 *
 *   private setValue(value: string): void {
 *     this._formField.setValue(value);
 *   }
 *
 *   override firstUpdated() {
 *     this._cellController.bind(this.value, stringSchema);
 *     this._formField.register(this.name);
 *   }
 * }
 * ```
 */
import { ReactiveController, ReactiveControllerHost } from "lit";
import { ContextConsumer } from "@lit/context";
import {
  type FormContext,
  formContext,
  type ValidationResult,
} from "../components/form/form-context.ts";

/**
 * Interface for cell controller compatibility
 * FormFieldController works with any controller that has getValue/setValue
 */
export interface CellControllerLike<T> {
  getValue(): T;
  setValue(value: T): void;
}

/**
 * Options for FormFieldController
 */
export interface FormFieldControllerOptions<T> {
  /**
   * The cell controller managing the underlying reactive value.
   * FormFieldController delegates to this when not buffering.
   */
  cellController: CellControllerLike<T>;

  /**
   * Validation function for this field.
   * Called by the form before submit to check all fields.
   * @default () => ({ valid: true })
   */
  validate?: () => ValidationResult;
}

/**
 * A reactive controller that manages form field buffering.
 *
 * Handles the "write gate" pattern: when in a form context, values are
 * buffered locally until the form flushes them. When not in a form,
 * values pass through to the cell controller directly.
 */
export class FormFieldController<T> implements ReactiveController {
  private _host: ReactiveControllerHost & HTMLElement;
  private _cellController: CellControllerLike<T>;
  private _validate: () => ValidationResult;

  // Form context consumer - automatically subscribes to context
  private _formContextConsumer: ContextConsumer<
    typeof formContext,
    ReactiveControllerHost & HTMLElement
  >;

  // Buffer state (only used when in form context)
  private _buffer: T | undefined;
  private _lastCellValue: T | undefined;

  // Form registration cleanup function
  private _formUnregister?: () => void;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    options: FormFieldControllerOptions<T>,
  ) {
    this._host = host;
    this._cellController = options.cellController;
    this._validate = options.validate ?? (() => ({ valid: true }));

    // Set up context consumer to access FormContext from ancestor ct-form
    this._formContextConsumer = new ContextConsumer(host, {
      context: formContext,
      subscribe: false, // Don't need updates, just initial value
    });

    host.addController(this);
  }

  /**
   * Get the form context (if we're inside a ct-form)
   */
  private get _formContext(): FormContext | undefined {
    return this._formContextConsumer.value;
  }

  /**
   * Check if this field is participating in a form
   */
  get inFormContext(): boolean {
    return this._formContext !== undefined;
  }

  /**
   * Get the current value.
   * Returns buffer if in form context and buffer is set, otherwise cell value.
   */
  getValue(): T {
    if (this._formContext && this._buffer !== undefined) {
      return this._buffer;
    }
    return this._cellController.getValue();
  }

  /**
   * Set the value.
   * Updates buffer if in form context, otherwise writes directly to cell.
   */
  setValue(value: T): void {
    if (this._formContext) {
      this._buffer = value;
      this._host.requestUpdate();
    } else {
      this._cellController.setValue(value);
    }
  }

  /**
   * Register this field with the form.
   * Call this in firstUpdated() after the cell controller is bound.
   *
   * @param name - Field name for form submission (e.g., "email", "username")
   */
  register(name?: string): void {
    // Only register once
    if (this._formUnregister) return;

    // Only register if we have a form context
    if (!this._formContext) return;

    this._formUnregister = this._formContext.registerField({
      element: this._host,
      name,
      // Return buffer if set, otherwise fall back to cell value
      getValue: () => this._buffer ?? this._cellController.getValue(),
      setValue: (v) => {
        this._buffer = v as T;
        this._host.requestUpdate();
      },
      flush: () => {
        const valueToFlush = this._buffer ?? this._cellController.getValue();
        this._cellController.setValue(valueToFlush);
        this._lastCellValue = valueToFlush;
      },
      reset: () => {
        // Clear buffer - getValue will fall back to cell value
        this._buffer = undefined;
        this._lastCellValue = undefined;
        this._host.requestUpdate();
      },
      validate: this._validate,
    });
  }

  /**
   * Unregister from the form.
   * Called automatically in hostDisconnected, but can be called manually.
   */
  unregister(): void {
    this._formUnregister?.();
    this._formUnregister = undefined;
  }

  // ReactiveController lifecycle

  hostConnected(): void {
    // Context consumer is set up in constructor
    // Registration happens in register() called by component's firstUpdated
  }

  hostDisconnected(): void {
    this.unregister();
  }
}

/**
 * Factory function for creating FormFieldController instances
 */
export function createFormFieldController<T>(
  host: ReactiveControllerHost & HTMLElement,
  options: FormFieldControllerOptions<T>,
): FormFieldController<T> {
  return new FormFieldController(host, options);
}
