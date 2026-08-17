import { EncodeContext } from "@/codec-common/EncodeContext.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { REALM_FORMAT_VERSION, type RealmFormatMarker } from "./interface.ts";

/**
 * The state of one act of realm encoding: the walk's own bookkeeping, plus the
 * marker this call's output is recognized by.
 *
 * The marker is minted here, which is to say once per `encode()` and after the
 * value to be encoded already exists -- what Section 2.2 of the realm spec
 * requires of it, and why a payload cannot forge one. Being per act is the
 * whole of its correctness: two acts must not share a marker, or one act's
 * data becomes another's structure.
 */
export class RealmEncodeContext extends EncodeContext {
  readonly #marker: RealmFormatMarker;

  /** Constructs an instance, minting this act's marker. */
  constructor(env: LiveEnvironment) {
    super(env);
    this.#marker = Object.freeze([REALM_FORMAT_VERSION] as const);
  }

  /** The marker at slot zero of this act's envelope and every tagged form. */
  get marker(): RealmFormatMarker {
    return this.#marker;
  }
}
