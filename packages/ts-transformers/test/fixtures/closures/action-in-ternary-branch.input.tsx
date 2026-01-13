/// <cts-enable />
/**
 * Regression test: action() result used in same ternary branch as computed()
 *
 * When a ternary branch contains both a computed() value and an action() reference,
 * the action must be captured in the derive wrapper along with the computed value.
 * Previously, action() results were incorrectly classified as "function declarations"
 * and skipped by CaptureCollector.
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

  const hasDescription = computed(() => {
    const desc = card.description;
    return desc && desc.length > 0;
  });

  return {
    [UI]: (
      <ct-card>
        {isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{card.title}</span>
            {/* Nested ternary with computed - triggers derive wrapper */}
            {hasDescription ? <span>{card.description}</span> : null}
            {/* Action in SAME branch - must be captured by the derive! */}
            <ct-button onClick={startEditing}>Edit</ct-button>
          </div>
        )}
      </ct-card>
    ),
    card,
  };
});
