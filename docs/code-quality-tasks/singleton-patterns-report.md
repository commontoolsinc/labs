# Singleton Patterns Report

Based on the analysis of the codebase against AGENTS.md guidelines, the
following singleton patterns were found that should be refactored:

## 1. Module-level Maps and Caches

### `packages/deno-vite-plugin/src/resolver.ts`

- **Line 75**: `const resolverCache = new Map();`
- **Issue**: Global cache that prevents multiple instances and complicates
  testing

### `packages/static/index.ts`

- **Line 5**: `const cache = new StaticCache();`
- **Issue**: Exported singleton cache instance

## 2. Exported Singleton Instances

### `packages/toolshed/lib/otel.ts`

- **Line 20**: `export const otlpExporter = new OTLPTraceExporter(...)`
- **Line 26**: `export const provider = new BasicTracerProvider(...)`
- **Issue**: Global telemetry instances that can't be mocked or isolated for
  testing

### `packages/toolshed/routes/storage/blobby/utils.ts`

- **Line 7**: `export const storage = new DiskStorage(DATA_DIR);`
- **Line 10**: `let redisClient: RedisClientType | null = null;`
- **Issue**: Global storage instance and module-level Redis client state

### `packages/memory/clock.ts`

- **Line 20**: `export default new Clock();`
- **Issue**: Default export of singleton instance prevents multiple clock
  instances

## 3. Module-level TextEncoder/TextDecoder Instances

### `packages/identity/src/identity.ts`

- **Line 11**: `const textEncoder = new TextEncoder();`

### `packages/utils/src/encoding.ts`

- **Line 1**: `const encoder = new TextEncoder();`
- **Line 2**: `const decoder = new TextDecoder();`
- **Issue**: While less problematic, these could be passed as dependencies for
  better testability

## 4. Module-level Configuration Objects

### `packages/background-charm-service/src/env.ts`

- **Line 42**: `export const env = loadEnv();`
- **Issue**: Global environment configuration that can't be easily mocked

### `packages/toolshed/lib/constants.ts`

- **Lines 4-8**: `export const ZOD_ERROR_MESSAGES = { ... }`
- **Lines 10-12**: `export const ZOD_ERROR_CODES = { ... }`
- **Lines 14-16**:
  `export const notFoundSchema = createMessageObjectSchema(...)`
- **Issue**: Global constants that might need different values in different
  contexts

### `packages/runner/src/query-result-proxy.ts`

- **Lines 14-46**:
  `const arrayMethods: { [key: string]: ArrayMethodType } = { ... }`
- **Issue**: Module-level method mapping

## 5. Module-level State and Initialization

### `packages/memory/deno.ts`

- **Lines 8-18**: `const serviceDid: DID = (() => { ... })();`
- **Line 20**: `const storePath = ...`
- **Line 21**: `const STORE = new URL(...)`
- **Lines 22-29**: Module-level provider initialization
- **Issue**: Complex module-level initialization that runs on import

### `packages/toolshed/lib/otel.ts`

- **Line 17**: `let _providerRegistered = false;`
- **Line 18**: `let _provider: BasicTracerProvider | undefined;`
- **Issue**: Module-level state tracking for provider registration

## Refactoring Recommendations

According to AGENTS.md, these patterns should be refactored using:

### 1. Class-based Patterns

```typescript
// Instead of: const cache = new Map();
export class Cache {
  private map: Map<string, string> = new Map();
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  set(key: string, value: string) {
    this.map.set(key, value);
  }
}
```

### 2. Functional Patterns

```typescript
// Instead of module-level state
export type Cache = Map;
export const get = (cache: Cache, key: string): string | undefined =>
  cache.get(key);
export const set = (cache: Cache, key: string, value: string) =>
  cache.set(key, value);
```

### 3. Dependency Injection

```typescript
// Instead of: export const storage = new DiskStorage(DATA_DIR);
export interface StorageProvider {
  storage: DiskStorage;
}

export function createStorageProvider(dataDir: string): StorageProvider {
  return {
    storage: new DiskStorage(dataDir),
  };
}
```

## Impact

These singleton patterns:

- Make unit testing difficult or impossible
- Prevent running multiple instances of the application
- Create tight coupling between modules
- Make it hard to mock dependencies
- Can cause state leakage between tests

## Priority

1. **High Priority**: Fix singletons in core modules like `memory`, `toolshed`,
   and `runner`
2. **Medium Priority**: Fix utility singletons like encoders and caches
3. **Low Priority**: Fix configuration objects that rarely change
