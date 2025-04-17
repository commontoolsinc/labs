# LLM-Based Code Generation Workflows

## Current Architecture Analysis

### Core Components

1. **iterate.ts**
   - Main functions:
     - `iterate()`: Updates existing charms with new specs
     - `castNewRecipe()`: Creates new charms from a goal
     - `genSrc()`: Core function that handles LLM prompting
   - Flow: user input → prepare prompt → call LLM → process response → compile
     recipe → run recipe

2. **SpecPreview.tsx**
   - UI component showing live preview of specifications and plans
   - Connected to `useLiveSpecPreview` hook for real-time generation

3. **iframe/prompt.ts & static.ts**
   - Contains prompt templates and utilities
   - `buildPrompt()`: Creates LLM requests
   - `injectUserCode()`: Places generated code into template

4. **spec-and-schema-gen.ts**
   - Contains prompts for spec/schema generation
   - `generateSpecAndSchema()`: Creates specifications and schemas

5. **CharmDetailView.tsx**
   - Primary UI for all operations
   - Contains tabs for: Operation (iterate/extend), Code, Data
   - Manages variants generation across multiple models

### Current Workflows

1. **Iterate Workflow**
   - User edits existing charm specification
   - System preserves schema and code structure
   - LLM updates only user code
   - Lineage tracked as "iterate" relation

2. **Extend Workflow**
   - User provides a goal with optional referenced data
   - System generates spec and schema from scratch
   - LLM creates new code
   - Lineage tracked as "extend" relation

3. **Live Preview**
   - As user types, real-time spec/plan is generated
   - Uses either "fast" or "precise" model based on user selection

4. **Variant Generation**
   - Can generate multiple versions across different models
   - Models defined in `variantModels` array

### Issues with Current Architecture

1. **Poor Abstraction**
   - Multiple entry points with overlapping functionality
   - Code duplication in CharmDetailView for suggestions and direct input
   - Multiple message handlers in static.ts

2. **Schema Handling**
   - Results are injected into argument schema as a hack
   - Lacks clear separation between input/output schemas

3. **Code Organization**
   - Lack of unified workflow layer
   - Direct coupling between UI components and LLM generation
   - Hard-coded model selection in multiple places

4. **Error Handling**
   - Limited fallback mechanisms for LLM failures
   - No structured validation of generated outputs

## Proposed Architecture

### New Funnel Workflow

1. **Intent Classification Stage**
   - Input: User query/command and context
   - Output: Operation type (create/iterate/extend) and structured plan
   - Purpose: Determine the most appropriate workflow path

2. **Planning Stage**
   - Input: Classified intent and context
   - Output: Execution plan with detailed steps
   - Purpose: Create a structured execution plan before code generation

3. **Execution Stage**
   - Input: Execution plan and context
   - Output: Generated code/artifacts based on plan
   - Purpose: Execute plan steps using appropriate generators

4. **Validation Stage**
   - Input: Generated code/artifacts
   - Output: Validation results and suggestions
   - Purpose: Ensure output meets requirements

5. **Refinement Stage**
   - Input: Validation results and user feedback
   - Output: Refined code/artifacts
   - Purpose: Fix any issues identified during validation

### Core Components

1. **IntentClassifier**
   - Analyzes user input to determine operation type
   - Maps input to appropriate workflow
   - Uses LLM to understand ambiguous requests

2. **PlanGenerator**
   - Creates a structured execution plan
   - Breaks down complex operations into steps
   - Includes schema requirements and validation criteria

3. **CodeGenerator**
   - Executes plan to produce code
   - Specializes based on operation type
   - Maintains context between generation steps

4. **SchemaGenerator**
   - Creates or updates schemas
   - Handles both input and output schemas
   - Ensures schema compatibility

5. **ValidationService**
   - Verifies generated output meets requirements
   - Checks for code correctness and spec adherence
   - Suggests refinements when issues found

### Implementation Path

1. **Phase 1: Extract Core Logic**
   - Create new abstractions for intent classification and planning
   - Refactor existing code to use these abstractions
   - Maintain backward compatibility

2. **Phase 2: Enhance Generation Pipeline**
   - Implement validation and refinement stages
   - Add better error handling and fallback mechanisms
   - Improve schema handling

3. **Phase 3: UI Integration**
   - Update UI to support new workflow stages
   - Add visibility into the generation process
   - Enhance feedback mechanisms

### Benefits

1. **Better Abstraction**
   - Clear separation of concerns
   - Unified entry point
   - Consistent model selection

2. **Improved User Experience**
   - More predictable results
   - Better error handling
   - More detailed feedback

3. **Enhanced Extensibility**
   - Easier to add new operation types
   - Simpler to integrate new models
   - More flexible validation rules

4. **Better Code Organization**
   - Reduced duplication
   - Clearer dependencies
   - More testable components
