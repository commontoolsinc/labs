import { describe as stdDescribe, it as stdIt, beforeEach, afterEach } from "@std/testing/bdd";

export { beforeEach, afterEach };

/**
 * Configuration for transaction tests
 */
export interface TxConfig {
  useStorageManagerTransactions: boolean;
}

// Global variable to track current test mode and nesting level
let currentTxConfig: TxConfig | null = null;
let isInTxDescribe = false;

/**
 * Enhanced describe that runs test suite with both transaction modes
 * If called while already inside a tx-bdd describe, behaves as regular describe
 */
export function describe(name: string, fn: (config: TxConfig) => void): void;
export function describe(name: string, fn: () => void): void;
export function describe(name: string, fn: ((config: TxConfig) => void) | (() => void)): void {
  // If we're already inside a tx-bdd describe, behave as regular describe
  if (isInTxDescribe) {
    stdDescribe(name, fn as () => void);
    return;
  }

  // Top-level tx-bdd describe - run with both configurations
  const txFn = fn as (config: TxConfig) => void;
  
  stdDescribe(`${name} (with transaction shim)`, () => {
    isInTxDescribe = true;
    currentTxConfig = { useStorageManagerTransactions: false };
    try {
      txFn({ useStorageManagerTransactions: false });
    } finally {
      isInTxDescribe = false;
    }
  });
  
  stdDescribe(`${name} (with StorageManager transactions)`, () => {
    isInTxDescribe = true;
    currentTxConfig = { useStorageManagerTransactions: true };
    try {
      txFn({ useStorageManagerTransactions: true });
    } finally {
      isInTxDescribe = false;
    }
  });
}

/**
 * Enhanced describe.skip that skips the entire test suite
 */
(describe as any).skip = function(name: string, fn: ((config: TxConfig) => void) | (() => void)): void {
  stdDescribe.skip(name, fn as () => void);
};

/**
 * Standard it function
 */
export function it(name: string, fn: () => void | Promise<void>) {
  return stdIt(name, fn);
}

/**
 * Enhanced it.skip that can conditionally skip based on transaction mode
 */
it.skip = function(
  nameOrConfig: string | { useStorageManagerTransactions: boolean },
  nameOrFn?: string | (() => void | Promise<void>),
  fn?: () => void | Promise<void>
) {
  // Check if first argument is a config object
  if (typeof nameOrConfig === "object" && nameOrConfig !== null) {
    const config = nameOrConfig;
    const name = nameOrFn as string;
    const testFn = fn!;
    
    // Skip if current mode matches the skip condition
    if (currentTxConfig?.useStorageManagerTransactions === config.useStorageManagerTransactions) {
      return stdIt.skip(`${name} (skipped: fails with StorageManager transactions)`, testFn);
    } else {
      return stdIt(name, testFn);
    }
  } else {
    // Standard skip call
    const name = nameOrConfig as string;
    const testFn = nameOrFn as () => void | Promise<void>;
    return stdIt.skip(name, testFn);
  }
};