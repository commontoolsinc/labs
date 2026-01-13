/// <cts-enable />
/**
 * Regression test: action() with explicit computed() in same ternary branch
 *
 * Variation where the pattern author uses computed() explicitly inside JSX
 * (not encouraged, but should still work). The action must be captured in
 * the derive wrapper created for the computed.
 */
import { action, Cell, computed, pattern, UI } from "commontools";

interface Card {
  title: string;
  description: string;
}

interface Input {
  card: Card;
}

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
            {/* Explicit computed() in JSX - not encouraged but should work */}
            {computed(() => card.description.length > 0) ? (
              <span>{card.description}</span>
            ) : null}
            {/* Action in SAME branch - must be captured */}
            <ct-button onClick={startEditing}>Edit</ct-button>
          </div>
        )}
      </ct-card>
    ),
    card,
  };
});
