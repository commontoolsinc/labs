/// <cts-enable />
/**
 * Regression test: action() referenced inside explicit computed() in JSX
 *
 * Variation where the pattern author uses computed() explicitly inside JSX
 * (not encouraged, but should still work). The action is referenced INSIDE
 * the computed expression, so it must be captured in the derive wrapper.
 */
import { action, Cell, computed, pattern, UI } from "commontools";

interface Card {
  title: string;
  description: string;
}

interface Input {
  card: Card;
}

// FIXTURE: action-in-ternary-with-explicit-computed
// Verifies: action() referenced inside an explicit computed() in JSX is captured in the derive wrapper
//   action(() => ...) → handler(...)({ isEditing })
//   computed(() => JSX with action ref) → derive(captureSchema, ..., { card, startEditing }, fn)
// Context: Action referenced inside computed expression must appear in the derive's capture object
export default pattern<Input>(({ card }) => {
  const isEditing = Cell.of(false);

  const startEditing = action(() => {
    isEditing.set(true);
  });

  return {
    [UI]: (
      <ct-card>
        {isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{card.title}</span>
            {/* Explicit computed() wrapping JSX that references the action */}
            {/* The action must be captured in the derive created for this computed */}
            {computed(() => (
              <div>
                <span>{card.description}</span>
                <ct-button onClick={startEditing}>Edit</ct-button>
              </div>
            ))}
          </div>
        )}
      </ct-card>
    ),
    card,
  };
});
