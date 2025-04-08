import {
  Charm,
  CharmManager,
  extendCharm as charmExtendCharm,
} from "@commontools/charm";
import { Cell } from "@commontools/runner";

/**
 * @deprecated Use the extendCharm function from @commontools/charm instead
 * This function is kept for backward compatibility but will be removed in a future version
 */
export function extendCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  goal: string,
  cells?: Record<string, Cell<any>>,
): Promise<Cell<Charm>> {
  // Use the unified implementation from the charm package
  return charmExtendCharm(charmManager, focusedCharmId, goal, cells);
}
