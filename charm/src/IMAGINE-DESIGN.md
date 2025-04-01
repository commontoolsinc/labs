# Imagine: A Streamlined LLM-Based Charm Generation System

## Overview

Imagine is a new workflow-based approach to LLM-powered charm generation that focuses on intent classification, structured planning, and specialized execution paths. It aims to provide a more predictable, maintainable, and extensible system for charm creation and modification.

## Current Implementation Status

The system has been implemented with the following components:

- Core workflow types defined with configuration properties
- Intent classification using LLM with fallback mechanisms
- Plan generation with workflow-specific steps
- Integration with existing iterate/extend functionality
- UI components for workflow selection and preview
- Preview generation with live updates

## Core Workflows

The system currently supports three primary workflows, with a design that allows for extending with additional workflows in the future:

1. **Fix**
   - **Purpose**: Correct issues in the code without changing functionality or the specification
   - **Updates**: Code only
   - **Schema**: Preserved
   - **Example**: "Fix the alignment of the buttons" or "Correct the calculation bug"
   - **Current Implementation**: Uses the existing iterate function with spec preservation

2. **Edit**
   - **Purpose**: Add features or modify functionality while preserving core data structure
   - **Updates**: Code and specification
   - **Schema**: Core structure preserved (may add properties but not completely change it)
   - **Example**: "Add dark mode support" or "Include a search feature"
   - **Current Implementation**: Uses the existing iterate function with spec updates

3. **Rework**
   - **Purpose**: Create something new, potentially combining multiple data sources
   - **Updates**: Code, specification, and schema
   - **Schema**: Can be completely different
   - **Example**: "Create a dashboard combining my tasks and calendar" or "Build a visualization tool for my expense data"
   - **Current Implementation**: Uses the existing castNewRecipe function

All workflows support data references, which are interpreted according to the active workflow's context.

## System Architecture

### Intent Classification

The first step is to classify the user's intent into one of the supported workflows:

- Uses LLM-based classification to analyze the user's request
- Returns a workflow type, confidence score, and reasoning
- Optionally enhances the user's prompt for better results
- Users can override the automatically selected workflow
- Implemented in `classifyIntent` and `classifyWorkflow` functions

### Plan Generation

Once the workflow is determined, a structured execution plan is generated:

- Creates a step-by-step approach to fulfill the user's request
- Plans are customized based on the workflow type
- For "edit" and "rework" workflows, may include specification updates
- For "rework" workflows, may include schema updates
- Implemented in `generatePlan` and `generateWorkflowPlan` functions

### Execution

The system executes the plan according to the workflow type:

- **Fix**: Direct code modification while preserving spec and schema
- **Edit**: Updates both code and spec while maintaining schema compatibility
- **Rework**: Creates new code, spec, and schema with potential data integration
- Main entry point is the `imagine` function which routes to appropriate implementation

### Preview

A preview system shows the user what to expect before execution:

- Displays the selected workflow with confidence
- Shows the execution plan steps
- For "edit" and "rework", may show spec/schema changes
- Allows users to adjust the workflow if needed
- Implemented in `SpecPreview` component and `useLiveSpecPreview` hook

## Implementation Details

### LLM Prompting

- Prompts are defined in `workflow-classification.ts`
- System uses context from existing charms when available
- Customized prompts based on workflow type
- Structured output format with XML tags

### UI Integration

- Enhanced `SpecPreview` component shows workflow type and confidence
- Toggle control allows users to override the automatic classification
- Plan is displayed as numbered steps
- Spec is hidden for "fix" workflows since they don't modify it

### Fallback Mechanisms

- Heuristic-based classification when LLM fails
- Default plans for each workflow type
- Error handling throughout the pipeline
- Unit tests verify fallback behavior

## Next Steps

1. **Enhance LLM Integration**
   - Refine prompts for better classification accuracy
   - Implement more specialized generation paths for each workflow
   - Add result validation and refinement

2. **UI Improvements**
   - Create specialized views for each workflow type
   - Add more context and guidance for users
   - Include examples and templates

3. **Performance Optimization**
   - Implement caching for common classifications
   - Explore parallel generation for variants
   - Optimize LLM usage with smaller models for simpler tasks

4. **Validation and Feedback**
   - Add validation stage to check generated code
   - Implement feedback mechanism for refinement
   - Track success metrics for each workflow

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
