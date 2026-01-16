/// <cts-enable />
/**
 * Regression test: inline arrow function inside explicit computed() in JSX
 *
 * Variation where an inline arrow function handler is wrapped inside an
 * explicit computed() in JSX. The transformer will convert the arrow function
 * to a handler, and the Cell reference (state.isEditing) must be properly
 * captured in the derive wrapper created for the computed.
 */
import { Cell, computed, pattern, UI } from "commontools";

interface Card {
  title: string;
  description: string;
}

interface State {
  card: Card;
  isEditing: Cell<boolean>;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ct-card>
        {state.isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{state.card.title}</span>
            {/* Explicit computed() wrapping a button with inline handler */}
            {/* The Cell ref in the handler must be captured in the derive */}
            {computed(() => (
              <ct-button onClick={() => state.isEditing.set(true)}>Edit</ct-button>
            ))}
          </div>
        )}
      </ct-card>
    ),
    card: state.card,
  };
});
