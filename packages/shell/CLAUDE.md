# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Development Commands

### Build & Serve

- **Development build with hot reload**: `deno task dev` (serves at
  http://127.0.0.1:5173)
- **Production build**: `deno task build` or `deno task production`
- **Serve built files**: `deno task serve` (serves dist/ at http://0.0.0.0:9099)
- **Check types**: Run from workspace root: `deno task check`
- **Format code**: `deno fmt` (80 char width, 2 spaces, semicolons required)

### Testing

Tests should be run from the workspace root:

- **All tests**: `deno task test`
- **Single test**: `deno test path/to/test.ts`

## Architecture Overview

The shell package is a web-based shell application built with Lit Web
Components. It provides a browser-based interface for interacting with Common
Tools' charm runtime system.

### Core Architecture Pattern

The application follows a **command-based state management pattern** where all
state changes flow through typed commands:

```typescript
// State changes via commands
dispatch("setState", { key: "value" });
dispatch("login", { username });
dispatch("navigateTo", { spaceName, charmId });
```

### Component Hierarchy

```
RootView (authentication wrapper)
  └─ AppView (main application)
      ├─ HeaderView (navigation/auth UI)
      └─ BodyView (main content area)
          └─ [Dynamic charm content]
```

### Key Systems

1. **State Management**:
   - Central `AppState` interface in `src/lib/app/types.ts`
   - Commands processed through `WorkQueue` for async operations
   - State propagated via Lit Context API (`@lit/context`)

2. **Authentication**:
   - Identity management via `@commontools/identity`
   - Root keys stored in browser KeyStore
   - Session state managed in AppState

3. **Charm Integration**:
   - CharmsController (`src/contexts/charms-controller.ts`) manages lifecycle
   - Runtime provided by `@commontools/runner`
   - Storage via StorageManager for persistent data

4. **Routing**:
   - URL pattern: `/{spaceName}/{charmId}`
   - History API integration with back/forward support
   - Default space: "common-knowledge"

### Important Patterns

1. **Async Task Handling**: Use `@lit/task` for async operations in components
2. **Event Flow**: Custom events bubble up through component tree
3. **Component State**: Use Lit's reactive properties and controllers
4. **Error Handling**: Errors should propagate to AppState for user display

### File Organization

- `src/components/` - Reusable UI components
- `src/views/` - Page-level components
- `src/contexts/` - Lit Context providers and controllers
- `src/lib/` - Core application logic
  - `app/` - State management and types
  - `commands.ts` - Command definitions
  - `runtime.ts` - Charm runtime integration

### Build Configuration

The project uses `@commontools/felt` (custom build tool) configured in
`felt.config.ts`:

- Entry: `src/index.ts`
- Output: `dist/scripts/index.js`
- Development server: `127.0.0.1:5173`
- Source maps enabled in development

### Current Development Context

When working on async tasks:

- The codebase recently improved async task completion and reactivity
- Use `@lit/task` for component-level async operations
- Ensure proper cleanup in component lifecycle methods
- State updates should trigger appropriate re-renders
