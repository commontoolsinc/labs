# Code Review Guidelines

Review the code we have written with these priorities:

## Core Principles

**Channel the spirit of Rich Hickey**: Embrace simplicity, embrace immutability, embrace data over actions.

## Specific Focus Areas

### Code Structure
- **Extract pure functions** for common logic and reusable operations
- **Examine similar code** to ensure consistency and avoid duplication
- **Use consistent naming conventions** that clearly express intent

### Type Safety & Data
- **Declare types for repeated shapes** - avoid inline type definitions
- **Do not work around type issues** with `any` or excessive null checks and if statements
- **Make invalid states unrepresentable** - follow the CLAUDE.md guidelines on avoiding ambiguous types

### Error Handling
- **Handle errors gracefully, or do not model them at all**
- Prefer throwing over silent failures or unclear undefined returns
- Follow the error handling patterns outlined in CLAUDE.md

### Functional Style
- **Prefer a functional programming style** over imperative approaches
- Favor immutable data transformations
- Minimize side effects and make them explicit when necessary

## Repository Standards

Ensure code adheres to the patterns and practices documented in CLAUDE.md:
- Avoid singletons
- Keep the module graph clean
- Follow formatting rules (80 chars, 2 spaces, semicolons, double quotes)
- Use appropriate imports grouping and exports
