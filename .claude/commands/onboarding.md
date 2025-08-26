# Common Tools Repository Onboarding Tour

This command provides an interactive tour of the Common Tools platform repository, helping new contributors understand where to find information and how to navigate the codebase effectively.

## Getting Started (Essential Foundation)

**Everyone starts here to get oriented:**

**Step 1: What is Common Tools? (Start small)**
- Read only the "What is Common Tools?" section from README.md
- Quote the key description to the user
- Ask: "What's your first reaction to this description?"
- Wait for their response before proceeding

**Step 2: Follow their curiosity from Step 1**
- If they're interested in "recipes" → show recipe-related architecture
- If they're interested in "distributed" → show backend architecture  
- If they're interested in "collaboration" → show spaces and charms
- If they want to see the big picture → show full architecture section

**Step 3: Practical next steps based on their interest**
- Show only relevant commands/packages for what caught their attention
- Ask what they'd like to explore next
- Offer 2-3 focused options rather than everything

## Choose Your Adventure

After completing the foundation, ask the user what they're most curious about:

### Path A: Recipe Development & Deployment
*"I want to understand how to build applications with recipes"*

**Journey through:**
1. **Recipe concepts and examples**
   - Explore `packages/patterns/` for hands-on examples
   - Find recipe documentation files (`RECIPES.md`, `COMPONENTS.md`, `HANDLERS.md` in recipes folder)
   
2. **CT Binary and deployment workflow**
   - Read `.claude/commands/common/ct.md` - The essential tool
   - Understanding spaces, charms, and linking
   
3. **Development workflow commands**
   - `/recipe-dev` - Working with existing recipes
   - `/imagine-recipe` - Creating new recipes  
   - `/explore-recipe` - Interactive testing with Playwright
   
4. **Hands-on next steps**
   - Set up development environment
   - Try `/setup-space` if needed
   - Build first recipe with `/imagine-recipe`

### Path B: Runtime & Execution Layer  
*"I want to understand how the runtime works under the hood"*

**Journey through:**
1. **Core packages deep dive**
   - Explore execution-related packages in `packages/`
   - Understand sandbox execution and security model
   
2. **Recipe execution lifecycle**
   - How recipes are compiled and run
   - Reactive system and data flow
   - Linking mechanism internals
   
3. **Development setup for runtime work**
   - Review `CLAUDE.md` for contribution guidelines
   - Understanding test suite and debugging approaches
   - Build processes and development workflow

### Path C: Application Layer (Toolshed + Shell)
*"I want to understand the hosted platform and user interfaces"*

**Journey through:**
1. **Toolshed backend architecture**
   - Read `packages/toolshed/README.md`
   - Understanding distributed storage and runtime hosting
   - API design and space management
   
2. **Shell frontend architecture**  
   - Read `packages/shell/README.md`
   - Lit Web Components and UI patterns
   - How users interact with spaces and charms
   
3. **Integration points**
   - How backend and frontend communicate
   - API boundaries and data flow
   - Development setup for full-stack work
   
4. **Development workflow**
   - Running local backend: `cd packages/toolshed && deno task dev`
   - Running local frontend: `cd packages/shell && deno task dev`
   - Understanding the development loop

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
- Don't offer 6 different paths; offer 2-3 based on their actual interest

**Key principle:** The user should feel like they're discovering things themselves with Claude as a helpful guide, not receiving a presentation.