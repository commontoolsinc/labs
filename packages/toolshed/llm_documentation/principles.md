# Project Principles

## Core Philosophy

We are a small team optimizing for rapid development and product-market fit
while maintaining security and privacy guarantees.

## Key Principles

### 1. Personal Computing, Not Webscale Computing

- Each user gets their own instance
- Optimize for individual-user-scale (<100 messages/second)
- Avoid unnecessary web-scale complexity

### 2. Minimize Complexity

- Embrace essential complexity, eliminate accidental complexity
- Keep implementations simple and shallow
- Prefer DAMP (Descriptive And Meaningful Phrases) over DRY (Don't Repeat
  Yourself)
- Duplicate code is great, especially if it reduces dependencies
- Shared code should be limited to general-purpose utilities

### 3. Product Before Protocol

- Focus on building a product people love
- Maintain flexibility in system interactions
- Avoid premature protocol commitments
- Prioritize discrete, useful functionality
- Let protocols emerge from proven use cases

### 4. Ship First, Optimize Later

- Focus on shipping working features
- Use boring, proven technology
- Defer optimization until necessary
- Prioritize product functionality over performance
- Embrace iterative improvement

### 5. Implementation Guidelines

- Keep shared code limited to utilities
- Use HTTP for service communication
- When calling inter-service APIs, make use of the hono stack, and RPC style
  calls
- Maintain service independence
- Enable easy refactoring and replacement
