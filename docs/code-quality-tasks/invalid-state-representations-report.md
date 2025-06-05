# Invalid State Representations Report

Based on the analysis of the codebase against AGENTS.md guidelines, the
following interfaces allow invalid state representations that should be
refactored:

## 1. LLMRequest Interface

**File**: `packages/llm/src/types.ts` **Lines**: 28-38

```typescript
export interface LLMRequest {
  cache?: boolean;
  messages: LLMMessage[];
  model: ModelName;
  system?: string;
  maxTokens?: number;
  stream?: boolean;
  stop?: string;
  mode?: "json";
  metadata?: LLMRequestMetadata;
}
```

**Issue**: The `cache` property being optional creates ambiguity. Code
throughout the codebase defaults it to `true` if undefined, but this implicit
behavior isn't clear from the interface.

**Recommendation**: Make `cache` required with explicit default:

```typescript
export interface LLMRequest {
  cache: boolean; // Always explicit, no ambiguity
  // ... other properties
}
```

## 2. WorkflowForm Interface

**File**: `packages/charm/src/workflow.ts` **Lines**: 299-348

```typescript
export interface WorkflowForm {
  classification: {
    workflowType: WorkflowType;
    confidence: number;
    reasoning: string;
  } | null;
  
  plan: {
    features?: string[];
    description?: string;
    charms?: CharmSearchResult[];
  } | null;
  
  generation: {
    charm: Cell<Charm>;
  } | null;
  
  searchResults: {
    castable: Record<...>
  } | null;
  
  spellToCast: {
    charmId: string;
    spellId: string;
  } | null;
}
```

**Issue**: Using `null` to represent "not yet processed" states requires
constant null checking. This doesn't make invalid states unrepresentable.

**Recommendation**: Use discriminated unions:

```typescript
type WorkflowForm = 
  | { state: 'unclassified' }
  | { state: 'classified'; classification: {...}; plan: null }
  | { state: 'planned'; classification: {...}; plan: {...}; generation: null }
  | { state: 'generated'; classification: {...}; plan: {...}; generation: {...} }
  // etc.
```

## 3. OAuth2Tokens Interface

**File**:
`packages/toolshed/routes/integrations/google-oauth/google-oauth.utils.ts`
**Lines**: 9-16

```typescript
export interface OAuth2Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope?: string[];
  expiresAt?: number;
}
```

**Issue**: `refreshToken` is optional but critical for token renewal. Code has
to handle cases where it might be missing, leading to potential authentication
failures.

**Recommendation**: Create separate types for initial and renewable tokens:

```typescript
export interface InitialOAuth2Tokens {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string[];
}

export interface RenewableOAuth2Tokens extends InitialOAuth2Tokens {
  refreshToken: string;
  expiresAt: number;
}
```

## 4. UserInfo Interface

**File**:
`packages/toolshed/routes/integrations/google-oauth/google-oauth.utils.ts`
**Lines**: 18-28

```typescript
export interface UserInfo {
  id?: string;
  email?: string;
  verified_email?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  error?: string;
}
```

**Issue**: Mixes success and error states in one interface. Either you have user
data OR an error, never both.

**Recommendation**: Use discriminated union:

```typescript
type UserInfoResult =
  | {
    success: true;
    data: {
      id: string;
      email: string;
      verified_email: boolean;
      name: string;
      // ... other fields
    };
  }
  | { success: false; error: string };
```

## 5. CallbackResult Interface

**File**:
`packages/toolshed/routes/integrations/google-oauth/google-oauth.utils.ts`
**Lines**: 30-35

```typescript
export interface CallbackResult extends Record<string, unknown> {
  success: boolean;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}
```

**Issue**: When `success` is false, `error` should be required. When `success`
is true, `error` shouldn't exist.

**Recommendation**: Use discriminated union:

```typescript
type CallbackResult =
  | { success: true; message?: string; details?: Record<string, unknown> }
  | { success: false; error: string; details?: Record<string, unknown> };
```

## 6. RuntimeOptions Interface

**File**: `packages/runner/src/runtime.ts` **Lines**: 43-51

```typescript
export interface RuntimeOptions {
  storageUrl: string;
  signer?: Signer;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  blobbyServerUrl?: string;
  recipeEnvironment?: RecipeEnvironment;
  debug?: boolean;
}
```

**Issue**: Optional properties have implicit defaults that aren't clear from the
interface. Code later throws if `storageUrl` doesn't exist (line 275).

**Recommendation**: Make defaults explicit:

```typescript
export interface RuntimeOptions {
  storageUrl: string;
  signer: Signer | null;
  consoleHandler: ConsoleHandler | null;
  errorHandlers: ErrorHandler[];
  blobbyServerUrl: string | null;
  recipeEnvironment: RecipeEnvironment | null;
  debug: boolean;
}

// With a factory function for defaults:
export function createRuntimeOptions(
  partial: PartialRuntimeOptions,
): RuntimeOptions {
  return {
    storageUrl: partial.storageUrl, // required
    signer: partial.signer ?? null,
    consoleHandler: partial.consoleHandler ?? defaultConsoleHandler,
    errorHandlers: partial.errorHandlers ?? [],
    blobbyServerUrl: partial.blobbyServerUrl ?? null,
    recipeEnvironment: partial.recipeEnvironment ?? null,
    debug: partial.debug ?? false,
  };
}
```

## 7. BackgroundCharmServiceOptions Interface

**File**: `packages/background-charm-service/src/service.ts` **Lines**: 12-19

```typescript
export interface BackgroundCharmServiceOptions {
  identity: Identity;
  toolshedUrl: string;
  runtime: Runtime;
  bgSpace?: string;
  bgCause?: string;
  workerTimeoutMs?: number;
}
```

**Issue**: Optional properties have defaults (`BG_SYSTEM_SPACE_ID` and
`BG_CELL_CAUSE`) applied in constructor, but this isn't clear from the
interface.

**Recommendation**: Make defaults explicit in the type:

```typescript
export interface BackgroundCharmServiceOptions {
  identity: Identity;
  toolshedUrl: string;
  runtime: Runtime;
  bgSpace: string;
  bgCause: string;
  workerTimeoutMs: number;
}

export const DEFAULT_BG_OPTIONS = {
  bgSpace: BG_SYSTEM_SPACE_ID,
  bgCause: BG_CELL_CAUSE,
  workerTimeoutMs: 30000,
} as const;
```

## 8. Module Interface

**File**: `packages/builder/src/types.ts` **Lines**: 182-188

```typescript
export interface Module {
  type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
  implementation?: ((...args: any[]) => any) | Recipe | string;
  wrapper?: "handler";
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
}
```

**Issue**: `implementation` is optional but certain module types require it. The
relationship between `type` and required properties isn't enforced.

**Recommendation**: Use discriminated unions:

```typescript
type Module =
  | {
    type: "ref";
    implementation: string;
    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }
  | {
    type: "javascript";
    implementation: (...args: any[]) => any;
    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }
  | {
    type: "recipe";
    implementation: Recipe;
    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;
  }
  | { type: "raw"; implementation: string }
  | { type: "isolated"; implementation: string }
  | { type: "passthrough" };
```

## Impact of These Issues

1. **Runtime Errors**: Optional properties that are actually required lead to
   runtime failures
2. **Defensive Programming**: Developers must add null checks everywhere,
   cluttering the code
3. **Hidden Dependencies**: Implicit defaults make it hard to understand the
   true requirements
4. **Type Safety Loss**: TypeScript can't catch invalid combinations of
   properties

## General Principles from AGENTS.md

"Making invalid states unrepresentable is good" - These interfaces violate this
principle by allowing combinations of properties that shouldn't exist together
or by making required properties optional.
