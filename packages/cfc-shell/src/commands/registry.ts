/**
 * Command registry for CFC shell
 */

import type { CommandFn } from "./context.ts";

/**
 * Registry of shell commands
 */
export class CommandRegistry {
  private commands = new Map<string, CommandFn>();

  /**
   * Register a command
   */
  register(name: string, fn: CommandFn): void {
    this.commands.set(name, fn);
  }

  /**
   * Get a command by name
   */
  get(name: string): CommandFn | null {
    return this.commands.get(name) ?? null;
  }

  /**
   * Check if a command exists
   */
  has(name: string): boolean {
    return this.commands.has(name);
  }

  /**
   * List all registered commands
   */
  list(): string[] {
    return Array.from(this.commands.keys()).sort();
  }
}

/**
 * Create a registry with all built-in commands
 * The actual implementation is in mod.ts to avoid circular dependencies
 */
export function createDefaultRegistry(): CommandRegistry {
  // Placeholder - actual implementation in mod.ts
  return new CommandRegistry();
}
