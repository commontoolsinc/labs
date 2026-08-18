/**
 * What an act of encoding or decoding reads off the engine that minted it:
 * the settings an engine holds for its whole lifetime, as against the state
 * one act carries for the length of a single call.
 *
 * An act is constructed around one of these rather than around the engine
 * itself. That keeps what an act may read to a named contract instead of the
 * engine's whole surface, and it keeps the two modules independent of each
 * other: an act never imports an engine. `BaseCodecEngine` satisfies this
 * interface, so an engine hands over itself.
 *
 * Expect this to grow as more of the walk moves onto the acts. Growing it is
 * the intended way to give an act something new to read, in preference to
 * widening what an act is handed.
 */
export interface CodecEngineConfig {
  /**
   * Whether a decode that fails produces a `ProblematicValue` instead of
   * throwing.
   */
  readonly lenient: boolean;
}
