import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { isFabricValue } from "@/type-check.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { BaseCodecEngine } from "@/codec-common/BaseCodecEngine.ts";
import type { ReconstructionContext } from "@/codec-interface/interface.ts";
import { type RealmCodecValue, type RealmTaggedValue } from "./interface.ts";

/**
 * Whole-value codec engine for the realm-crossing wire format: the form a
 * fabric value takes when it is handed to `structuredClone()` or
 * `postMessage()` to reach another realm.
 *
 * The counterpart to `JsonCodecEngine`, and the two divide along what their
 * transports carry. JSON reaches a `string`, so every type JavaScript has and
 * JSON lacks -- `bigint`, `undefined`, the special numbers, bytes, patterns --
 * is spelled out as tagged text, and a `/`-prefixed key in user data has to be
 * escaped clear of the tags. Cloning carries all of those but `symbol`, and
 * carries them with their types intact, so most of a value passes through
 * untouched and tagging is reserved for what genuinely needs it.
 *
 * **This format assumes both ends are the same build**, and that assumption is
 * load-bearing rather than incidental. It is what allows the absence of a
 * format tag: JSON's `fvj1:` earns its keep because JSON text is persisted and
 * read back by a build that did not write it, whereas a value in this form is
 * constructed, cloned across, decoded, and gone. The boundary it exists for is
 * worker IPC within one process.
 *
 * Nothing here enforces that. `postMessage()` also spans tabs, windows and
 * frames, any of which could pair two different deployments -- and this format
 * would not detect it, having nothing that identifies itself. Carrying fabric
 * values across such a boundary needs a format tag reintroduced, or JSON,
 * rather than this as it stands.
 *
 * Three pieces of `JsonCodecEngine` have no counterpart here, each because the
 * transport does the work directly:
 *
 * * **No escaping.** `/quote` and `/object` exist because a JSON object is the
 *   only container JSON has, so a tag and a user's data compete for the same
 *   shape. A tag here is a `Map`, which no payload can present (see
 *   {@link RealmTaggedValue}).
 * * **No `/hole`.** Cloning preserves a sparse array's length and its absent
 *   indices, so a hole crosses as a hole.
 * * **No stringify step.** The tree is the wire, which is why `Encoded` and
 *   `SerializedForm` are the same type here where JSON's differ.
 *
 * Both walks are copy-on-write: a subtree in which nothing changed is returned
 * by identity rather than rebuilt. A payload holding no `FabricSpecialObject`
 * and no symbol is therefore handed to the transport exactly as it arrived --
 * the same object, not a reconstruction of it -- and copied once by the
 * transport instead of twice. Emitting no envelope is what lets that reach the
 * outermost value rather than stopping one layer in. That is the ordinary case
 * for plain data, and it makes the walk's cost proportional to what actually
 * needs encoding rather than to the size of the value. `JsonCodecEngine` never
 * faces the choice, having to reach text.
 *
 * TODO(danfuzz): Cycles. `JsonCodecEngine` throws on one, having no way to
 * spell it; this throws too, which is a choice rather than a necessity, since
 * cloning reproduces a cyclic graph faithfully. Allowing one costs a memo from
 * each visited object to its encoded counterpart, so that a repeat visit
 * yields the same node instead of recursing -- and that memo would also
 * preserve shared acyclic structure, which a rebuild currently duplicates.
 */
export class RealmCodecEngine extends BaseCodecEngine<RealmCodecValue> {
  //
  // Instance members
  //

  /**
   * @inheritDoc
   *
   * The walked tree is what crosses: no envelope, and no further reduction.
   * Copy-on-write therefore reaches all the way out, a payload needing no
   * encoding being returned by identity rather than wrapped in a fresh
   * container.
   */
  override encode(value: FabricValue): RealmCodecValue {
    return this.encodeValue(value);
  }

  /**
   * @inheritDoc
   *
   * Walks the tree as it arrived. There is no envelope to check first: a
   * receiver on this format's one boundary knows what it asked for, both ends
   * being the same engine from the same build. What cloning carries but this
   * format never emits is refused where it is met, by `decodeValue()`.
   */
  override decode(
    data: RealmCodecValue,
    context: ReconstructionContext,
  ): FabricValue {
    return this.decodeValue(data, context);
  }

  /** @inheritDoc */
  protected override wrapTag(
    tag: string,
    state: RealmCodecValue,
  ): RealmTaggedValue {
    return new Map([[tag, state]]);
  }

  /**
   * @inheritDoc
   *
   * Holes need no representation: cloning carries a sparse array's length and
   * its absent indices directly, so skipping an absent index here leaves it
   * absent in the result.
   */
  protected override encodeArray(
    value: readonly FabricValue[],
    seen: Set<object>,
  ): RealmCodecValue {
    RealmCodecEngine.enterOrThrow(seen, value);

    const length = value.length;
    let result: RealmCodecValue[] | undefined;

    for (let i = 0; i < length; i++) {
      if (!(i in value)) {
        continue;
      }

      const original = value[i]!;
      const encoded = this.encodeValue(original, seen);

      if (result !== undefined) {
        result[i] = encoded;
      } else if (!Object.is(encoded, original)) {
        // The first element that changed: copy what came before it, holes and
        // all, and write into the copy from here on.
        result = new Array<RealmCodecValue>(length);
        for (let j = 0; j < i; j++) {
          if (j in value) {
            result[j] = value[j] as RealmCodecValue;
          }
        }
        result[i] = encoded;
      }
    }

    seen.delete(value);
    return result ?? (value as RealmCodecValue);
  }

  /**
   * @inheritDoc
   *
   * Keys are visited in their own order rather than sorted. JSON sorts to make
   * its text canonical, which is what lets an encoding be hashed and compared
   * as bytes; cloning preserves key order and nothing here is compared that
   * way, so sorting would buy nothing and would force a rebuild of every
   * object.
   *
   * A `/`-prefixed key needs no escaping either, this format reserving no key
   * at all. A name this runtime reserves is still refused: the rebuild below
   * cannot reproduce one, and a silent reshaping is worse than a refusal.
   */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
    seen: Set<object>,
  ): RealmCodecValue {
    RealmCodecEngine.enterOrThrow(seen, value);

    const keys = Object.keys(value);
    let result: Record<string, RealmCodecValue> | undefined;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;

      // Checked on every object, not just the ones that get rebuilt, so that
      // the answer does not depend on whether some sibling happened to change.
      if (isUnsafeObjectKey(key)) {
        throw new Error(
          `Cannot encode an object with a key this runtime reserves: ${
            backtickQuote(key)
          }`,
        );
      }

      const original = value[key]!;
      const encoded = this.encodeValue(original, seen);

      if (result !== undefined) {
        result[key] = encoded;
      } else if (!Object.is(encoded, original)) {
        result = {};
        for (let j = 0; j < i; j++) {
          result[keys[j]!] = value[keys[j]!] as RealmCodecValue;
        }
        result[key] = encoded;
      }
    }

    seen.delete(value);
    return result ?? (value as RealmCodecValue);
  }

  /** @inheritDoc */
  protected override decodeValue(
    data: RealmCodecValue,
    context: ReconstructionContext,
  ): FabricValue {
    const unwrapped = RealmCodecEngine.#unwrapTag(data);

    if (unwrapped !== null) {
      return this.decodeTagged(unwrapped.tag, unwrapped.state, context);
    }

    // Self-representing primitives pass straight through. That is every
    // primitive but `symbol`, which cannot have arrived untagged: cloning
    // refuses one, so the only way a symbol crosses is under a tag, handled
    // above.
    if ((data === null) || (typeof data !== "object")) {
      return data as FabricValue;
    }

    if (Array.isArray(data)) {
      return this.#decodeArray(data, context);
    } else if (isPlainObject(data)) {
      return this.#decodePlainObject(data, context);
    }

    // Wire data is untrusted, and cloning carries a good deal this format
    // never emits -- a bare `Uint8Array`, a `Date`, a multi-entry `Map` --
    // all of which reach here.
    return this.reportMalformed(
      "",
      RealmCodecEngine.#reportable(data),
      `Cannot decode ${
        backtickQuote(toCompactDebugString(data, 50))
      }: not a form this format emits.`,
    );
  }

  /**
   * Decodes an array. Holes arrive as holes and are left alone, so there is no
   * run-length form to validate, and so no count off the wire that could name
   * a length an array cannot hold.
   */
  #decodeArray(
    data: readonly RealmCodecValue[],
    context: ReconstructionContext,
  ): FabricValue {
    const length = data.length;
    let result: FabricValue[] | undefined;

    for (let i = 0; i < length; i++) {
      if (!(i in data)) {
        continue;
      }

      const original = data[i]!;
      const decoded = this.decodeValue(original, context);

      if (result !== undefined) {
        result[i] = decoded;
      } else if (!Object.is(decoded, original)) {
        result = new Array<FabricValue>(length);
        for (let j = 0; j < i; j++) {
          if (j in data) {
            result[j] = data[j] as FabricValue;
          }
        }
        result[i] = decoded;
      }
    }

    return Object.freeze(result ?? (data as FabricValue));
  }

  /**
   * Decodes a plain object. A `/`-prefixed key needs no attention, unlike
   * under JSON: this format reserves no key at all, its tags living in a
   * container a payload cannot produce.
   */
  #decodePlainObject(
    data: Record<string, RealmCodecValue>,
    context: ReconstructionContext,
  ): FabricValue {
    const keys = Object.keys(data);
    let result: Record<string, FabricValue> | undefined;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;

      if (isUnsafeObjectKey(key)) {
        return this.reportMalformed(
          key,
          RealmCodecEngine.#reportable(data),
          `object contains a key this runtime reserves: "${key}"`,
        );
      }

      const original = data[key]!;
      const decoded = this.decodeValue(original, context);

      if (result !== undefined) {
        result[key] = decoded;
      } else if (!Object.is(decoded, original)) {
        result = {};
        for (let j = 0; j < i; j++) {
          result[keys[j]!] = data[keys[j]!] as FabricValue;
        }
        result[key] = decoded;
      }
    }

    return Object.freeze(result ?? (data as FabricValue));
  }

  //
  // Static members
  //

  /**
   * Renders a state for reporting, since `reportMalformed()` preserves what it
   * is given and so wants a `FabricValue`.
   *
   * JSON's engine hands one over directly, every `JsonCodecValue` being a
   * `FabricValue` too. This format's are not so lucky: `RealmCodecValue`
   * admits `Uint8Array`, `RegExp` and `Map`, none of which is a `FabricValue`,
   * and a container can hold any of the three at any depth. Handing one over
   * anyway would not merely mistype it -- a `ProblematicValue` deep-freezes
   * its state, and `Object.freeze()` throws outright on a typed array with
   * elements. So a state that is not a fabric value is described instead,
   * which loses the ability to reproduce it and keeps everything else working.
   */
  static #reportable(state: RealmCodecValue): FabricValue {
    return isFabricValue(state) ? state : toCompactDebugString(state, 200);
  }

  /**
   * Unwraps a tagged wire representation. Returns `{ tag, state }`, or `null`
   * if `data` is not a tagged value. The `state` is extracted directly from
   * `data`.
   */
  static #unwrapTag(
    data: RealmCodecValue,
  ): { tag: string; state: RealmCodecValue } | null {
    if (!((data instanceof Map) && (data.size === 1))) {
      return null;
    }

    const [tag, state] = data.entries().next().value!;
    return { tag, state };
  }
}
