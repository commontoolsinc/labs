/**
 * Stub for the nascent "modern cell representation" classes.
 */

//
// Configuration flags
//

/**
 * Module-level flag for the modern cell representation.
 */
let modernCellRepEnabled = false;

/** Activates or deactivates the modern cell representation flag. */
export function setCellRepConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    modernCellRepEnabled = enabled ?? false;
  }
}

/** Returns whether the modern cell representation flag is currently enabled. */
export function getCellRepConfig(): boolean {
  return modernCellRepEnabled;
}

/** Restores the modern cell representation flag to its default. */
export function resetCellRepConfig(): void {
  modernCellRepEnabled = false;
}
