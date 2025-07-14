# Interactive Recipe Imagination and Creation

This command guides Claude through an AI-assisted recipe creation workflow that uses specialized subagents to research, plan, and implement new CommonTools recipes based on user prompts.

## Prerequisites

**Before starting recipe imagination:**
- User should have an existing space or have run the space setup script
- Claude should read the common CT setup instructions in `.claude/commands/common/ct.md`
- Recipe development environment should be set up (user should have run `ct init` in recipes directory)

**Important: UI Components and Framework Reference**
- All UI components prefixed with `ct-` (like `ct-button`, `ct-input`, `ct-list`) come from the `ui` package in this repository
- The recipe framework implementations are also located in the packages within this repository
- When stuck on UI components, recipe patterns, or framework behavior, search the packages for reference implementations
- Use `find packages/ -name "*.ts" -o -name "*.tsx" | xargs grep -l "ct-button"` type searches to find component usage examples

The user provides an initial prompt describing what they want their recipe to do: $ARGUMENTS

## Workflow Overview

The imagine-recipe command uses a multi-agent approach:
1. **Main Claude**: Orchestrates the entire process, handles handoffs between agents
2. **Spec-subagent**: Clarifies requirements, researches existing recipes, examines spaces
3. **Recipe-subagent**: Implements the recipe, deploys it, and refines based on feedback

## Script Flow for Claude

### STEP 1: Initial Setup and Prompt Processing

**Read common setup instructions:**
- First, read `.claude/commands/common/ct.md` for shared CT binary setup
- Follow those instructions for CT binary check, identity management, environment setup
- Collect required parameters (API URL, space name, recipe path, identity file)

**Process user prompt:**
- Capture the user's initial recipe idea from $ARGUMENTS
- Explain the multi-agent workflow to the user
- Set expectations about the process: research → planning → implementation → refinement

### STEP 2: Launch Spec-Subagent for Requirements and Research

**Create spec-subagent with these responsibilities:**

**Task: Recipe Specification and Research**
- Take the user's initial prompt and ask clarifying questions to narrow the requirements
- Research existing recipes in the user's recipe repository to understand patterns and avoid duplication
- Optionally examine the user's current space using CT commands to understand existing charms and data flow
- Produce a detailed specification document for the new recipe

**Spec-subagent workflow:**
1. **Requirements clarification:**
   - Ask targeted questions about inputs, outputs, and behavior
   - Clarify data sources (other charms, user inputs, external APIs)
   - Understand UI requirements and user interactions
   - Identify integration points with existing charms

2. **Recipe repository research:**
   - Search existing recipes: `find [recipe-path] -name "*.tsx" -type f | head -20`
   - Analyze similar recipes for patterns and reusable components
   - Identify potential base recipes to extend or adapt
   - Look for shared schemas and utilities that could be reused
   - **Reference framework implementations:** Search packages for UI component usage and recipe patterns: `find packages/ -name "*.ts" -o -name "*.tsx" | xargs grep -l "[pattern]"`

3. **Space examination (optional):**
   - List current charms: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`
   - Inspect key charms to understand data structures: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id]`
   - Identify potential data sources and integration opportunities
   - Map existing data flow for integration planning

4. **Specification output:**
   - Recipe purpose and behavior description
   - Input schema (from other charms, user inputs, external data)
   - Output schema (what other charms will consume)
   - UI components and user interaction patterns
   - Integration requirements (which charms to link to/from)
   - Implementation approach and architecture notes
   - Potential challenges and considerations

**Spec-subagent should return a comprehensive specification document that the main Claude can use for planning.**

### STEP 3: Planning and Architecture (Main Claude)

**Review specification:**
- Analyze the spec-subagent's research and requirements
- Validate the proposed approach against CommonTools patterns
- Identify implementation complexity and potential issues

**Create implementation plan:**
- Break down the recipe into implementable components
- Plan the file structure (single file vs multi-file recipe)
- Design the deployment strategy (new charm vs updating existing)
- Plan integration and linking steps
- Identify testing and validation approach

**Present plan to user:**
- Show the detailed implementation plan
- Explain the proposed recipe architecture
- Get user approval before proceeding to implementation
- Allow user to request modifications to the plan

### STEP 4: Launch Recipe-Subagent for Implementation

**Create recipe-subagent with these responsibilities:**

**Task: Recipe Implementation and Deployment**
- Implement the recipe based on the approved specification and plan
- Ensure TypeScript correctness and CommonTools compliance
- Deploy the recipe and handle any deployment issues
- Test the recipe and refine based on results
- Debug using CT inspection commands as needed

**Recipe-subagent workflow:**

1. **Recipe implementation:**
   - Create the recipe file(s) following CommonTools patterns
   - Implement the UI components and interaction handlers using `ct-` prefixed components from the `ui` package
   - **Reference component implementations:** When unsure about UI components, search packages: `find packages/ui -name "*.tsx" | xargs grep -l "ct-[component]"`
   - Define proper input/output schemas matching the specification
   - Add error handling and validation
   - Include helpful comments and documentation

2. **Syntax validation and testing:**
   - Test recipe syntax: `./dist/ct dev [recipe-file] --no-run`
   - Fix any TypeScript or syntax errors
   - Ensure imports and dependencies are correct
   - Validate against CommonTools recipe requirements

3. **Deployment:**
   - Deploy the new charm: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-file]`
   - Record the new CHARM_ID
   - Verify successful deployment: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`

4. **Integration and linking:**
   - Create planned links to other charms: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [source]/[field] [target]/[input]`
   - Verify links are working: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id]`
   - Test data flow through the network

5. **Testing and debugging:**
   - Use inspection commands to verify behavior: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] --json`
   - Use cell operations for debugging: `./dist/ct charm get --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] [path]`
   - Set test data if needed: `echo '[test-data]' | ./dist/ct charm set --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] [path]`
   - Iterate on the recipe based on test results

6. **User feedback and refinement:**
   - Present the deployed recipe to the user
   - Gather feedback on functionality and UI
   - Make refinements using `./dist/ct charm setsrc` for updates
   - Continue testing and refinement cycles as needed

**Recipe-subagent should return a fully functional, deployed, and tested recipe.**

### STEP 5: Review and Repository Management (Main Claude)

**Final recipe review:**
- Verify the recipe meets the original requirements
- Check that all planned integrations are working
- Ensure the recipe follows CommonTools best practices
- Validate error handling and edge cases

**Repository preparation:**
- Review the final recipe code for quality and maintainability
- Ensure proper documentation and comments
- Check for any cleanup needed (temporary files, test data)
- Verify the recipe file is in the correct location in the recipe repository

**Git workflow assistance:**
- Help user stage the new recipe file: `git add [recipe-file]`
- Review changes: `git diff --staged`
- Guide commit message creation following repository conventions
- Create commit: `git commit -m "[descriptive commit message]"`
- Optionally help create a pull request if using external recipe repository

**Documentation and handoff:**
- Provide usage instructions for the new recipe
- Document any special configuration or setup requirements
- Explain how the recipe integrates with existing charms
- Suggest next steps or potential enhancements

## Subagent Handoff Protocol

**Between Main Claude and Spec-subagent:**
- Main Claude provides: User prompt, recipe repository path, space context
- Spec-subagent returns: Detailed specification document with requirements, research findings, and implementation notes

**Between Main Claude and Recipe-subagent:**
- Main Claude provides: Approved specification, implementation plan, deployment parameters
- Recipe-subagent returns: Working recipe file, deployed charm ID, integration status, test results

**Error handling between agents:**
- If subagent encounters blocking issues, it should return partial results with clear error descriptions
- Main Claude should handle subagent failures gracefully and potentially retry with modified parameters
- User should be informed of any issues and given options to adjust the approach

## Advanced Features

**Multi-file recipe support:**
- Spec-subagent should identify when multi-file architecture is beneficial
- Recipe-subagent should handle proper import/export patterns
- Plan for shared schema and utility files

**API integration recipes:**
- Spec-subagent should research API requirements and authentication needs
- Recipe-subagent should implement proper error handling for external services
- Consider rate limiting and data caching strategies

**Complex data transformation recipes:**
- Identify data format mismatches between existing charms
- Plan intermediate transformation steps
- Implement robust data validation and error recovery

## Error Handling and Troubleshooting

**Common issues and solutions:**
- Recipe syntax errors: Recipe-subagent should iterate until syntax is valid
- UI component issues: Search packages for component implementations and usage examples
- Framework pattern confusion: Reference recipe framework implementations in packages
- Deployment failures: Check network connectivity, identity permissions, space access
- Integration problems: Verify charm IDs, field names, and data schema compatibility
- Runtime errors: Use inspection and cell operations for debugging

**Escalation path:**
- If subagents cannot resolve issues, escalate to user with specific problem description
- Provide diagnostic information and suggested next steps
- Allow user to modify requirements or approach based on technical constraints

## Success Criteria

**A successful imagine-recipe session should result in:**
- A working recipe that meets the user's original requirements
- Proper integration with existing space charms
- Clean, well-documented code following CommonTools patterns
- Successful deployment and testing
- Committed code ready for sharing or collaboration

## Notes for Claude

- Always maintain context between subagent handoffs
- Keep user informed of progress through each phase
- Don't proceed to implementation without user approval of the plan
- Use the subagents' specialized focus to ensure thorough work in each phase
- Be prepared to iterate if requirements change during the process
- Document lessons learned for future recipe development

Remember: This is a collaborative AI-assisted development process. The goal is to leverage specialized subagents for deep research and implementation while maintaining human oversight and approval at key decision points.