/// <cts-enable />
/**
 * Regression test: inline arrow function action in ternary branch with computed
 *
 * Variation where the action is defined as an inline arrow function in the
 * onClick handler. The transformer will convert this to a handler, and the
 * Cell reference (state.isEditing) must be properly captured in the derive
 * wrapper alongside the computed value (hasDescription).
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
  const hasDescription = computed(() => {
    const desc = state.card.description;
    return desc && desc.length > 0;
  });

  return {
    [UI]: (
      <ct-card>
        {state.isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{state.card.title}</span>
            {/* Nested ternary with computed - triggers derive wrapper */}
            {hasDescription ? <span>{state.card.description}</span> : null}
            {/* Inline arrow function - gets transformed to handler */}
            {/* state.isEditing Cell must be captured in the derive for the branch */}
            <ct-button onClick={() => state.isEditing.set(true)}>Edit</ct-button>
          </div>
        )}
      </ct-card>
    ),
    card: state.card,
  };
});
