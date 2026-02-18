import type { StorableClass, StorableInstance } from "./storable-protocol.ts";
import type { SerializationContext } from "./serialization-context.ts";
import type {
  JsonWireValue,
  SerializedForm,
} from "./json-serialization-context.ts";
import { ErrorConverter } from "./type-handlers.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";

/**
 * JSON serialization context implementing the `/<Type>@<Version>` wire format
 * from the formal spec (Section 5). Manages a static type registry for the
 * types in scope and handles encoding/decoding of tagged values.
 * See Section 5.2 of the formal spec.
 */
export class JsonEncodingContext implements SerializationContext<JsonWireValue> {
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

    // Register built-in types for this scope. ErrorConverter is compatible
    // with StorableClass since RECONSTRUCT returns Error (which is acceptable
    // per the widened StorableConverter interface, cast here for the registry).
    // Note: Link@1, Stream@1, Map@1, Set@1, Bytes@1, Date@1, BigInt@1
    // are NOT registered -- they belong to future rounds.
    this.registry.set(
      "Error@1",
      ErrorConverter as unknown as StorableClass<StorableInstance>,
    );
    // Undefined@1 and `hole` are handled by type handlers, not the class
    // registry.
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
    // Hole are handled by type handlers directly. Future rounds will add
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
