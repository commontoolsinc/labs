# Charm Workflow System: A Comprehensive Guide

## Overview

The Charm Workflow System provides an LLM-powered approach to charm generation and modification. It analyzes user intent, classifies operations into specific workflows, and generates appropriate code through a structured pipeline. The system is designed to be predictable, maintainable, and extensible.

## Code Execution Flow

```mermaid
graph TD
    %% Entry Points
    UI[UI Components] --> A[imagine/modifyCharm]
    A --> B[executeWorkflow]

    %% Core Linear Pipeline with Form Object Flow
    B --> C[processWorkflow]
    C --> |Form| D1[processInputSection]
    D1 --> |Form with mentions| D2[fillClassificationSection]
    D2 --> |Form with classification| D3[fillPlanningSection]
    D3 --> |Form with plan/spec| D4[generateCode]

    %% Form Processing Details
    D1 --> |Handles| P1[formatPromptWithMentions]
    D2 --> |Performs| P2[classifyIntent]
    P2 --> |Uses| P2a[classifyWorkflow LLM function]
    D3 --> |Generates| P3[generatePlan]
    P3 --> |Uses| P3a[generateWorkflowPlan LLM function]

    %% Workflow Branching Based on Classification
    D4 --> |Form.classification = Fix| W1[executeFixWorkflow]
    D4 --> |Form.classification = Edit| W2[executeEditWorkflow]
    D4 --> |Form.classification = Rework| W3[executeReworkWorkflow]

    %% Implementation Path for Fix/Edit (Both use iterate)
    W1 --> I1[iterate]
    W2 --> I1
    I1 --> |1| I2[getIframeRecipe]
    I1 --> |2| I3[genSrc]
    I1 --> |3| I4[generateNewRecipeVersion]
    I4 --> I5[compileAndRunRecipe]

    %% Implementation Path for Rework
    W3 --> R1[castNewRecipe]
    R1 --> |1| R2[scrub/turnCellsIntoAliases]
    R1 --> |2| R3[generateSpecAndSchema]
    R1 --> |3| R4[genSrc]
    R1 --> |4| R5[compileAndRunRecipe]

    %% Final compilation and charm creation (shared)
    I5 --> F1[compileRecipe]
    R5 --> F1
    F1 --> F2[tsToExports]
    F1 --> F3[registerNewRecipe]
    F1 --> Result[Charm Cell]
```

### Pipeline Description

The workflow system follows a clear linear pipeline where a `WorkflowForm` object is progressively built and passed through each stage:

1. **Entry Point**:
   - UI components call `imagine()` or `modifyCharm()`
   - Both ultimately call `executeWorkflow()`

2. **Form Pipeline**:
   - `processWorkflow()` orchestrates the form-building pipeline
   - Each stage enriches the same form object:
     1. `processInputSection()`: Processes raw input, resolves @mentions
     2. `fillClassificationSection()`: Determines workflow type (Fix/Edit/Rework)
     3. `fillPlanningSection()`: Generates execution plan, spec, and schema
     4. `generateCode()`: Routes to workflow-specific implementation

3. **Workflow-Specific Implementation**:
   - All workflows receive the same fully populated form object
   - **Fix and Edit**: Both use `iterate()` but handle spec differently
     - Fix: Preserves existing spec from original charm
     - Edit: Uses newly generated spec from form

   - **Rework**: Uses `castNewRecipe()` with different approach
     - Creates entirely new charm rather than modifying
     - Handles references to other charms

4. **Common Final Path**:
   - All workflows compile and run their recipes
   - `compileRecipe()` takes source code and compiles it
   - Results in a new charm cell that's returned to caller

The form object flows sequentially through each stage, accumulating more data until it contains everything needed for code generation. The pipeline only branches after classification determines which specific implementation to use.

## Core Workflow Types

The system supports three primary workflows:

1. **Fix**
   - **Purpose**: Correct issues without changing functionality
   - **Updates**: Code only
   - **Schema**: Preserved
   - **Spec**: Preserved
   - **Example**: "Fix the alignment of the buttons"
   - **Implementation**: Uses `iterate()` with preserved spec

2. **Edit**
   - **Purpose**: Add features while preserving core data structure
   - **Updates**: Code and specification
   - **Schema**: Core structure preserved
   - **Example**: "Add dark mode support"
   - **Implementation**: Uses `iterate()` with spec updates

3. **Rework**
   - **Purpose**: Create something new, potentially combining data sources
   - **Updates**: Code, specification, and schema
   - **Schema**: Can be completely different
   - **Example**: "Create a dashboard combining my tasks and calendar"
   - **Implementation**: Uses `castNewRecipe()`
   - **References**: Can reference multiple charms

## Entry Points

The workflow system can be initiated from several places in the UI:

1. **Command Center** (`CommandCenter.tsx`)
   - Global command palette (⌘K)
   - Processes user input and @mentions
   - Shows live preview with `useLiveSpecPreview` hook
   - Uses `handleImagineOperation()` in `commands.ts` to dispatch workflow
   - Entry point for both new charms and modifications to existing charms
   - Supports "Fast" vs "Smart" model selection for preview generation

2. **CharmDetailView** (`CharmDetailView.tsx`)
   - Operation tab in the bottom sheet when viewing a charm
   - Uses `useCharmOperation()` hook to manage operations
   - Handles iterate, extend, and variant generation workflows
   - Performs operations via `performOperation()` function

3. **Direct Functions**
   - External applications can call the core functions directly:
   - `executeWorkflow()`: Main entry point for all workflow processing
   - `imagine()`: Alias for `executeWorkflow()`, used in most places
   - `modifyCharm()`: Higher-level function for modifying existing charms

## Workflow Form Progression

The system builds up a `WorkflowForm` object throughout the process:

1. **Creation**: `createWorkflowForm(rawInput)` initializes the basic structure
   ```typescript
   {
     input: { rawInput, processedInput: rawInput, references: {} },
     classification: { workflowType: "edit", confidence: 0, reasoning: "" },
     plan: { steps: [] },
     meta: { isComplete: false, isFilled: false }
   }
   ```

2. **Input Processing**: `processInputSection(form, options)`
   - Processes @mentions in the input
   - Resolves references to other charms
   - Updates `form.input.processedInput` and `form.input.references`
   - Sets `charmManager` in `form.meta`

3. **Classification**: `fillClassificationSection(form, options)`
   - Determines workflow type via LLM or heuristic fallbacks
   - Forces "rework" workflow when other charms are referenced
   - Updates `form.classification`
   - Sets `modelId` in `form.meta`

4. **Planning**: `fillPlanningSection(form, options)`
   - Generates execution plan and updated spec/schema
   - For "fix" workflow, preserves existing spec
   - Updates `form.plan` with steps, spec, and schema
   - Sets `form.meta.isFilled = true`

5. **Generation**: `generateCode(form)`
   - Executes the appropriate workflow function
   - Sets `form.generation.charm` with the created charm
   - Sets `form.meta.isComplete = true`

## Charm References and @Mentions

When a user references another charm with an @mention:

1. The `formatPromptWithMentions()` function processes these references
2. The system forces a "rework" workflow even if manual override is attempted
3. The references are processed in `executeReworkWorkflow()` to create a new charm with access to referenced data

## UI Integration

1. **Live Preview**: The `useLiveSpecPreview` hook:
   - Processes input as the user types
   - Calls `generateWorkflowPreview()` which runs the workflow process in "dry run" mode
   - Provides dynamic feedback on classification, plan, and spec
   - Manages multiple loading states for different preview components
   - Supports "Fast" vs "Smart" model selection

2. **SpecPreview Component**:
   - Displays workflow type with confidence score
   - Shows execution plan as numbered steps
   - Conditionally shows spec (hidden for "fix" workflow)
   - Allows workflow type override through a toggle

## Execution Pipeline

The main entry point is `executeWorkflow()`, which:

1. Processes the full form with `processWorkflow(input, false, options)`
2. Routes execution to the appropriate workflow function:
   - `executeFixWorkflow()`: Preserves spec, updates implementation
   - `executeEditWorkflow()`: Updates spec and implementation
   - `executeReworkWorkflow()`: Creates new charm with new spec/schema

## Integration with existing components:

1. The system leverages existing functions:
   - `iterate()`: Core function for Fix/Edit workflows
   - `castNewRecipe()`: Core function for Rework workflow
   - `genSrc()`: Generates source code for all workflows

2. LLM integration:
   - `classifyWorkflow()`: LLM-based classification
   - `generateWorkflowPlan()`: LLM-based plan generation
   - `generateSpecAndSchema()`: For creating new specifications and schemas

## Fallback Mechanisms

The system includes fallbacks at each stage:

1. If LLM classification fails, it falls back to keyword heuristics
2. If plan generation fails, it provides default plans for each workflow
3. If mention processing fails, it continues with the raw input

## Key Implementation Details

- **Workflow Form**: Centralized data structure that evolves through the process
- **Force Rework**: References to other charms force the rework workflow
- **Input Processing**: Handles @mentions and creates charm references
- **Live Preview**: Progressive processing showing classification → plan → spec
- **Execution Plan**: Structured steps to fulfill the user's request

## Extensibility

The workflow system is designed to be extensible:

1. **New Workflow Types**: The `WorkflowType` type and `WORKFLOWS` record can be expanded
   - Add new entries to the `WORKFLOWS` record
   - Update classification logic to recognize new types
   - Implement specialized execution functions

2. **Model Selection**: The system supports different LLM models for different stages
   - Fast models for classification and preview
   - More powerful models for code generation
   - `getModelId()` function maps user-friendly names to model identifiers

3. **UI Customization**: The workflow UI components are decoupled
   - `SpecPreview` can be integrated in different contexts
   - `useLiveSpecPreview` hook can be used in custom components
   - Workflow type toggle allows manual override when appropriate
