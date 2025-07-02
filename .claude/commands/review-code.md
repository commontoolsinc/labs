# Code Review Guidelines

Review the code we have written with these priorities:

## Core Principles

**Channel the spirit of Rich Hickey**: Embrace simplicity, embrace immutability, embrace data.
Also consider the lessons of: Erlang (Joe Armstrong), Elixir (José Valim), Elm (Evan Czaplicki) and Rust.

## Specific Focus Areas

### Code Structure
- **Extract pure functions** for common logic and reusable operations
- **Pay attention to the story parameters and names tell** use the code as a self-documenting structure
- **Examine similar code** to ensure consistency and avoid duplication
- **Use consistent naming conventions** that clearly express intent
- **Decoupled modules**: consider inversion of control, decomposition and breaking apart large files by extracting clear domains

### Type Safety & Data
- **Declare types for repeated shapes** - avoid inline type definitions
- **Do not work around type issues** with `any` or excessive null checks and if statements
- **Make invalid states unrepresentable** - follow the CLAUDE.md guidelines on avoiding ambiguous types

### Error Handling
- **Handle errors gracefully, or avoid them entirely**
- Prefer throwing over silent failures or unclear undefined returns
- Follow the error handling patterns outlined in CLAUDE.md

### Functional Style
- **Prefer a pure, functional programming style** over imperative approaches
- Favor immutable data transformations in library code
- Minimize side effects and make them explicit when necessary

### Functional-Reactive programming
- When working on recipes, favor functional-reactive programming patterns to handle asynchronous data streams and side effects. See @recipe-dev.md.
