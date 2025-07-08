import { CharmManager } from "../manager.ts";
import type { Cell } from "@commontools/runner";

// Domain types for cell operations
export type CellPath = readonly (string | number)[];
export type CellValue = unknown;

// Error types for better error handling
export type CellOperationErrorType = 
  | "CHARM_NOT_FOUND" 
  | "INVALID_PATH" 
  | "NULL_VALUE" 
  | "NON_OBJECT";

export interface CellOperationError {
  type: CellOperationErrorType;
  message: string;
  charmId?: string;
  path?: CellPath;
  segment?: string | number;
}

// Result types for functional approach
export type GetCellResult = 
  | { success: true; value: CellValue; path: CellPath }
  | { success: false; error: CellOperationError };

export type SetCellResult = 
  | { success: true }
  | { success: false; error: CellOperationError };

// Custom error class for backward compatibility
export class CellOperationException extends Error {
  constructor(public readonly error: CellOperationError) {
    super(error.message);
    this.name = "CellOperationException";
  }
}

// Pure helper functions
function createError(
  type: CellOperationErrorType, 
  message: string, 
  details?: Partial<CellOperationError>
): CellOperationError {
  return { type, message, ...details };
}

/**
 * Pure function to validate if a value can be navigated with a given segment
 */
export function validateNavigable(
  value: unknown, 
  segment: string | number
): CellOperationError | null {
  if (value == null) {
    return createError(
      "NULL_VALUE",
      `Cannot navigate through null/undefined value at segment "${segment}"`,
      { segment }
    );
  }
  if (typeof value !== "object") {
    return createError(
      "NON_OBJECT",
      `Cannot navigate through non-object value at segment "${segment}"`,
      { segment }
    );
  }
  return null;
}

/**
 * Pure function to navigate a path through a value
 */
export function navigatePath(
  value: unknown, 
  path: CellPath
): GetCellResult {
  let currentValue = value;
  
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const error = validateNavigable(currentValue, segment);
    
    if (error) {
      return {
        success: false,
        error: { ...error, path: path.slice(0, i + 1) }
      };
    }
    
    currentValue = (currentValue as any)[segment];
  }
  
  return { success: true, value: currentValue, path };
}

/**
 * Pure functional version of getCellValue
 */
export async function getCellValue(
  manager: CharmManager,
  charmId: string,
  path: CellPath
): Promise<GetCellResult> {
  const charmCell = await manager.get(charmId);
  
  if (!charmCell) {
    return {
      success: false,
      error: createError(
        "CHARM_NOT_FOUND",
        `Charm with ID "${charmId}" not found`,
        { charmId, path }
      )
    };
  }
  
  const cellValue = charmCell.get();
  return navigatePath(cellValue, path);
}

/**
 * Pure functional version of setCellValue
 */
export async function setCellValue(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: CellValue
): Promise<SetCellResult> {
  const charmCell = await manager.get(charmId);
  
  if (!charmCell) {
    return {
      success: false,
      error: createError(
        "CHARM_NOT_FOUND",
        `Charm with ID "${charmId}" not found`,
        { charmId, path }
      )
    };
  }
  
  try {
    // Get the input cell (arguments) for the charm
    const inputCell = manager.getArgument(charmCell);
    
    // Navigate to the path and set the value
    let targetCell = inputCell;
    for (const segment of path) {
      targetCell = targetCell.key(segment);
    }
    
    targetCell.set(value as any);
    
    // Wait for the operation to complete
    await manager.runtime.idle();
    await manager.synced();
    
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: createError(
        "INVALID_PATH",
        error instanceof Error ? error.message : "Failed to set cell value",
        { charmId, path }
      )
    };
  }
}

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
   * @throws {CellOperationException} If charm not found or path is invalid
   */
  async getCellValue(charmId: string, path: (string | number)[]): Promise<any> {
    const result = await getCellValue(this.#manager, charmId, path);
    
    if (!result.success) {
      throw new CellOperationException(result.error);
    }
    
    return result.value;
  }

  /**
   * Sets the value at a specific path within a charm's input cell.
   * @param charmId - The ID of the charm
   * @param path - Array of path segments (strings or numbers for array indices)
   * @param value - The value to set
   * @throws {CellOperationException} If charm not found or path is invalid
   */
  async setCellValue(
    charmId: string,
    path: (string | number)[],
    value: any,
  ): Promise<void> {
    const result = await setCellValue(this.#manager, charmId, path, value);
    
    if (!result.success) {
      throw new CellOperationException(result.error);
    }
  }
}
