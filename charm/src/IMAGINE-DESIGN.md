# Imagine: A Streamlined LLM-Based Charm Generation System

## Overview

Imagine is a new workflow-based approach to LLM-powered charm generation that focuses on intent classification, structured planning, and specialized execution paths. It aims to provide a more predictable, maintainable, and extensible system for charm creation and modification.

## Core Workflows

The system currently supports three primary workflows, with a design that allows for extending with additional workflows in the future:

1. **Fix**
   - **Purpose**: Correct issues in the code without changing functionality or the specification
   - **Updates**: Code only
   - **Schema**: Preserved
   - **Example**: "Fix the alignment of the buttons" or "Correct the calculation bug"

2. **Edit**
   - **Purpose**: Add features or modify functionality while preserving core data structure
   - **Updates**: Code and specification
   - **Schema**: Core structure preserved (may add properties but not completely change it)
   - **Example**: "Add dark mode support" or "Include a search feature"

3. **Rework**
   - **Purpose**: Create something new, potentially combining multiple data sources
   - **Updates**: Code, specification, and schema
   - **Schema**: Can be completely different
   - **Example**: "Create a dashboard combining my tasks and calendar" or "Build a visualization tool for my expense data"

All workflows support data references, which are interpreted according to the active workflow's context.

## System Architecture

### Intent Classification

The first step is to classify the user's intent into one of the supported workflows:

- Uses LLM-based classification to analyze the user's request
- Returns a workflow type, confidence score, and reasoning
- Optionally enhances the user's prompt for better results
- Users can override the automatically selected workflow

### Plan Generation

Once the workflow is determined, a structured execution plan is generated:

- Creates a step-by-step approach to fulfill the user's request
- Plans are customized based on the workflow type
- For "edit" and "rework" workflows, may include specification updates
- For "rework" workflows, may include schema updates

### Execution

The system executes the plan according to the workflow type:

- **Fix**: Direct code modification while preserving spec and schema
- **Edit**: Updates both code and spec while maintaining schema compatibility
- **Rework**: Creates new code, spec, and schema with potential data integration

### Preview

A preview system shows the user what to expect before execution:

- Displays the selected workflow with confidence
- Shows the execution plan steps
- For "edit" and "rework", may show spec/schema changes
- Allows users to adjust the workflow if needed

## Implementation Strategy

1. **Side-by-side with existing system**
   - Implement `imagine.ts` alongside the current `iterate.ts`
   - Gradually migrate functionality while maintaining backward compatibility
   - Use existing components where appropriate

2. **Focus on abstraction**
   - Clear separation between classification, planning, and execution
   - Well-defined interfaces between components
   - Consistent configuration management for LLM calls

3. **Testing approach**
   - Unit tests for classification logic and workflow selection
   - Integration tests for the whole pipeline
   - Test fixtures for predictable LLM responses

## Future Extensions

The system is designed to be extensible in several ways:

1. **Additional workflows**
   - Could add specialized workflows for specific use cases
   - Examples: "Optimize", "Explain", "Visualize", etc.

2. **Enhanced validation**
   - Add validation stages to verify output quality
   - Implement feedback loops for refinement

3. **Multi-step generation**
   - Support for complex operations that require multiple generation steps
   - Chain multiple workflows together for sophisticated outcomes

4. **Model specialization**
   - Select optimal models for different workflow stages
   - Implement model fallbacks for reliability
