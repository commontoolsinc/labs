import { RECONSTRUCT } from "./storable-protocol.ts";
import type {
  ReconstructionContext,
  StorableClass,
  StorableInstance,
} from "./storable-protocol.ts";
import type {
  SerializationContext,
  SerializedForm,
} from "./serialization-context.ts";
import type { StorableValue } from "./interface.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";

/**
 * Reconstructor for `Error@1`. Creates an `Error` (or subclass based on
 * `name`) from the deconstructed state.
 */
const ErrorClass: StorableClass<StorableInstance> = {
  [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableInstance {
    const s = state as Record<string, StorableValue>;
    const name = (s.name as string) ?? "Error";
    const message = (s.message as string) ?? "";

    // Construct the appropriate Error subclass based on name.
    let error: Error;
    switch (name) {
      case "TypeError":
        error = new TypeError(message);
        break;
      case "RangeError":
        error = new RangeError(message);
        break;
      case "SyntaxError":
        error = new SyntaxError(message);
        break;
      case "ReferenceError":
        error = new ReferenceError(message);
        break;
      case "URIError":
        error = new URIError(message);
        break;
      case "EvalError":
        error = new EvalError(message);
        break;
      default:
        error = new Error(message);
        break;
    }

    // Set name explicitly (covers custom names like "MyError").
    if (error.name !== name) {
      error.name = name;
    }

    if (s.stack !== undefined) {
      error.stack = s.stack as string;
    }
    if (s.cause !== undefined) {
      error.cause = s.cause;
    }

    // Copy custom enumerable properties, skipping prototype-sensitive keys.
    for (const key of Object.keys(s)) {
      if (
        key !== "name" && key !== "message" && key !== "stack" &&
        key !== "cause" && key !== "__proto__" && key !== "constructor"
      ) {
        (error as unknown as Record<string, unknown>)[key] = s[key];
      }
    }

    // Error instances aren't StorableInstance per se (they don't have
    // [DECONSTRUCT]), but the serializer handles them via hardcoded branches.
    // Return as unknown cast to satisfy the interface.
    return error as unknown as StorableInstance;
  },
};

/**
 * JSON serialization context implementing the `/<Type>@<Version>` wire format
 * from the formal spec (Section 5). Manages a static type registry for the
 * types in scope and handles encoding/decoding of tagged values.
 * See Section 5.2 of the formal spec.
 */
export class JsonEncodingContext implements SerializationContext {
  /** Tag -> class registry for known types. */
  private readonly registry = new Map<
    string,
    StorableClass<StorableInstance>
  >();

  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. */
  readonly lenient: boolean;

  constructor(options?: { lenient?: boolean }) {
    this.lenient = options?.lenient ?? false;

    // Register built-in types for this scope.
    // Note: Link@1, Stream@1, Map@1, Set@1, Bytes@1, Date@1, BigInt@1
    // are NOT registered -- they belong to future rounds.
    this.registry.set("Error@1", ErrorClass);
    // Undefined@1 and `hole` are handled inline by serialize/deserialize,
    // not through the class registry.
  }

  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string {
    if (value instanceof UnknownStorable) {
      return value.typeTag;
    }
    if (value instanceof ProblematicStorable) {
      return value.typeTag;
    }
    // Shouldn't be reached for the types in scope -- Error, undefined, and
    // Hole are handled by serialize() directly. Future rounds will add
    // Cell/Stream/etc. here.
    throw new Error(
      `JsonEncodingContext: no tag registered for value: ${value}`,
    );
  }

  /** Get the class that can reconstruct instances for a given tag. */
  getClassFor(
    tag: string,
  ): StorableClass<StorableInstance> | undefined {
    return this.registry.get(tag);
  }

  /**
   * Encode a tag and state into the `/<tag>` wire format. Prepends `/` to the
   * tag to produce the JSON key. See Section 5.2 of the formal spec.
   */
  encode(tag: string, state: SerializedForm): SerializedForm {
    return { [`/${tag}`]: state } as SerializedForm;
  }

  /**
   * Decode a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value.
   * See Section 5.4 of the formal spec.
   */
  decode(
    data: SerializedForm,
  ): { tag: string; state: SerializedForm } | null {
    if (
      data === null || typeof data !== "object" || Array.isArray(data)
    ) {
      return null;
    }

    const keys = Object.keys(data);
    if (keys.length !== 1) {
      return null;
    }

    const key = keys[0];
    if (!key.startsWith("/")) {
      return null;
    }

    const tag = key.slice(1);
    const state = (data as Record<string, SerializedForm>)[key];
    return { tag, state };
  }
}
