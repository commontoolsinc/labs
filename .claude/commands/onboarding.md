# Common Tools Repository Onboarding Tour

This command provides an interactive tour of the Common Tools platform repository, helping new contributors understand where to find information and how to navigate the codebase effectively.

## Getting Started (Essential Foundation)

**Everyone starts here to get oriented:**

**Step 1: What is Common Tools? (Start small)**
- Read only the "What is Common Tools?" section from README.md
- Quote the key description to the user
- Immediately offer the four focused paths:

"Now that you have the basic idea, what would you like to know more about:

- **Programs that run in this platform** (recipes, charms, UI components)
- **The runtime that enables information flow analysis and storage** (runner, builder, storage)  
- **The application layer that users access the platform through** (toolshed, shell, CLI)
- **The LLM tooling layer** (Claude commands, subagents, and development workflows)

Which of these interests you most?"

**Step 2: Follow their choice with targeted exploration**
Based on their choice, dive into only the relevant packages and concepts for that area

## Deep Dive Paths

Based on the user's choice in Step 2, follow these focused exploration paths:

### Path A: Programs That Run in the Platform
*"I chose: Programs that run in this platform (recipes, charms, UI components)"*

**Explore in order:**
1. **What are recipes?** - Quote relevant sections from README about reactive programs
2. **Recipe examples** - Show a simple example from `packages/patterns/`
3. **UI components** - Brief look at `packages/ui/` and `ct-` prefixed components
4. **How recipes become charms** - Deployment and linking concepts
5. **Development commands** - `/recipe-dev`, `/imagine-recipe`, `/explore-recipe`

### Path B: Runtime That Enables Information Flow
*"I chose: The runtime that enables information flow analysis and storage"*

**Explore in order:**
1. **Runtime architecture** - Quote architecture sections about distributed runtime
2. **Core packages** - Look at runner, storage, and execution-related packages
3. **Information flow concepts** - How data moves and is tracked
4. **Security model** - Sandbox execution and privacy features
5. **Development setup** - How to work on runtime components

### Path C: Application Layer Users Access
*"I chose: The application layer that users access the platform through"*

**Explore in order:**
1. **Toolshed backend** - Quote from `packages/toolshed/README.md` about hosted platform
2. **Shell frontend** - Quote from `packages/shell/README.md` about user interface
3. **CT CLI** - Overview from `.claude/commands/common/ct.md`
4. **How they work together** - Integration points and data flow
5. **Development workflow** - Running local development environment

### Path D: LLM Tooling Layer
*"I chose: The LLM tooling layer (Claude commands, subagents, and development workflows)"*

**Explore in order:**
1. **Commands overview** - Quote from `.claude/commands/README.md` about available workflows
2. **Command categories** - Recipe development, workflow management, research, etc.
3. **Integration setup** - Quote from `deps.md` about MCP integrations (Linear, Playwright)
4. **Development assistance patterns** - How LLMs help with Common Tools development
5. **Creating new commands** - How this onboarding command was built

## Navigation Support

**Throughout any path, users can access:**
- **Available commands**: List `.claude/commands/` and read `.claude/commands/README.md`
- **Integration setup**: Review `deps.md` for tools and MCP integrations  
- **Development guidelines**: Reference `CLAUDE.md` for coding standards
- **Research commands**: Use `/research` to dive deeper into specific areas

## Adventure Branches

**Users can switch paths or dive deeper:**
- From Recipe Development → explore Runtime internals
- From Runtime → understand Application layer integration  
- From Application layer → try Recipe development
- Or combine multiple paths based on curiosity

## Completion Indicators

**Each path concludes when the user can:**
- Navigate to relevant information sources independently
- Understand their chosen area's development workflow
- Know what commands/tools to use for their interests
- Have clear next steps for hands-on work

## Notes for Claude

**Critical: This is a guided discovery experience, not a fire-hose lecture:**

- **Start tiny and build** - Don't read multiple files at once. Start with one small section
- **Quote small chunks** - Show 2-3 sentences from files, not entire sections  
- **Wait for their reaction** - After each quote, ask what they think and WAIT for response
- **Follow their energy** - Only show more based on what sparked their curiosity
- **Never charge ahead** - Resist the urge to show everything; be patient and responsive
- **Let silence be OK** - Give them time to process and respond

**Example flow:**
1. Read just the "What is Common Tools?" section from README.md
2. Quote the first paragraph: "Common Tools is a new distributed computing platform..."  
3. Ask: "What's your first reaction to this?"
4. Wait for user response
5. Based on their response, show ONLY the next relevant small piece
6. Repeat this cycle

**What NOT to do:**
- Don't read README.md + list packages + read commands README all at once
- Don't summarize what you found after reading files
- Don't offer too many paths; the four focused paths are sufficient based on their actual interest

**Key principle:** The user should feel like they're discovering things themselves with Claude as a helpful guide, not receiving a presentation.