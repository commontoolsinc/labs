/// <cts-enable />
/**
 * BUG REPRO: .map() after || [] or ?? [] fallback is not transformed to mapWithPattern
 *
 * ISSUE SUMMARY:
 * When an expression with a fallback (|| [] or ?? []) is followed by .map(),
 * the fallback gets transformed to a derive(), but the subsequent .map() is NOT
 * transformed to mapWithPattern. This causes runtime errors when the inner
 * callback accesses variables from outer scopes.
 *
 * STEPS TO REPRODUCE:
 * 1. Outer .map() on a reactive array: messages.map((msg) => ...)
 * 2. Inside, use fallback: (msg.reactions || []).map(...) or via computed variable
 * 3. Access outer variable in inner callback: ... msg.id ...
 *
 * EXPECTED:
 * - The .map() after fallback should be transformed to mapWithPattern
 * - msg.id should be captured and passed through params
 *
 * ACTUAL:
 * - The fallback (msg.reactions || []) becomes derive({ msg }, ({ msg }) => msg.reactions || [])
 * - But .map() on that derive result is NOT transformed to mapWithPattern
 * - Runtime error: "Cell with parent cell not found in current frame.
 *   Likely a closure that should have been transformed."
 *
 * ROOT CAUSE (in map-strategy.ts):
 * When checking if .map() needs transformation:
 * 1. isDeriveCall(target) - The target is the derive result IDENTIFIER, not a derive CALL
 * 2. isOpaqueRefType(targetType) - The type registry has the unwrapped type, not OpaqueRef<T>
 *
 * The type flow:
 * - derive(..., ({ msg }) => msg.reactions || []) returns OpaqueRef<Reaction[] | never[]>
 * - But the type registry stores the callback return type (Reaction[] | never[]), not OpaqueRef
 * - So isOpaqueRefType() fails and the .map() is not transformed
 *
 * WORKAROUND:
 * Use direct property access WITHOUT fallback:
 *   {msg.reactions.map((r) => ...)}  // Works - msg.reactions is OpaqueRef<Reaction[]>
 * Instead of:
 *   {(msg.reactions || []).map((r) => ...)}  // Fails - fallback breaks type detection
 *
 * This requires making the property non-optional in the interface.
 */
import { computed, pattern, UI } from "commontools";

interface Reaction {
  emoji: string;
  userNames: string[];
}

interface Message {
  id: string;
  author: string;
  content: string;
  reactions?: Reaction[];  // Optional property requiring fallback
}

interface Input {
  messages: Message[];
}

export default pattern<Input>(({ messages }) => {
  return {
    [UI]: (
      <div>
        {messages.map((msg) => {
          // Method 1: computed variable with fallback - FAILS
          const messageReactions = computed(() =>
            (msg && msg.reactions) || []
          );

          return (
            <div>
              <p>{msg.content}</p>
              <div>
                {/* BUG: This .map() is NOT transformed to mapWithPattern.
                    The derive result doesn't pass the OpaqueRef type check.
                    Accessing msg.id causes runtime error. */}
                {messageReactions.map((reaction) => (
                  <button data-msg-id={msg.id}>
                    {reaction.emoji} ({reaction.userNames.length})
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    ),
  };
});

/**
 * NOTE: The following inline patterns also fail for the same reason:
 *
 * {(msg.reactions || []).map((r) => ...)}  // FAILS - || creates derive
 * {(msg.reactions ?? []).map((r) => ...)}  // FAILS - ?? creates derive
 *
 * Only direct property access works:
 * {msg.reactions.map((r) => ...)}  // WORKS - direct OpaqueRef property
 */
