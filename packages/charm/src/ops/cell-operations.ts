import { CharmManager } from "../manager.ts";

export class CellOperations {
  #manager: CharmManager;

  constructor(manager: CharmManager) {
    this.#manager = manager;
  }

  /**
   * Gets the value at a specific path within a charm's result cell.
   * @param charmId - The ID of the charm
   * @param path - Array of path segments (strings or numbers for array indices)
   * @returns The value at the specified path
   */
  async getCellValue(charmId: string, path: (string | number)[]): Promise<any> {
    const charmCell = await this.#manager.get(charmId);
    if (!charmCell) {
      throw new Error(`Charm with ID "${charmId}" not found`);
    }
    
    // Start with the result data
    let currentValue = charmCell.get();
    
    // Navigate the path within the data
    for (const segment of path) {
      if (currentValue == null) {
        throw new Error(`Cannot access path "${path.join("/")}" - encountered null/undefined at "${segment}"`);
      }
      if (typeof currentValue !== 'object') {
        throw new Error(`Cannot access path "${path.join("/")}" - encountered non-object at "${segment}"`);
      }
      currentValue = currentValue[segment];
    }
    
    return currentValue;
  }

  /**
   * Sets the value at a specific path within a charm's input cell.
   * @param charmId - The ID of the charm
   * @param path - Array of path segments (strings or numbers for array indices)
   * @param value - The value to set
   */
  async setCellValue(
    charmId: string,
    path: (string | number)[],
    value: any,
  ): Promise<void> {
    const charmCell = await this.#manager.get(charmId);
    if (!charmCell) {
      throw new Error(`Charm with ID "${charmId}" not found`);
    }
    
    // Get the input cell (arguments) for the charm
    const inputCell = this.#manager.getArgument(charmCell);
    
    // Navigate to the path and set the value
    let targetCell = inputCell;
    for (const segment of path) {
      targetCell = targetCell.key(segment);
    }
    
    targetCell.set(value);
    
    // Wait for the operation to complete
    await this.#manager.runtime.idle();
    await this.#manager.synced();
  }

}