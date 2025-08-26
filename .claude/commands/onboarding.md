# Common Tools Repository Onboarding Tour

This command provides an interactive tour of the Common Tools platform repository, helping new contributors understand where to find information and how to navigate the codebase effectively.

## Getting Started (Essential Foundation)

**Everyone starts here to get oriented:**

**Step 1: Platform Foundation**
- Read `README.md` together to understand what Common Tools is
- Focus on "What is Common Tools?" section for core concepts  
- Review architecture overview of packages
- Understand development practices section

**Step 2: Repository Structure**
- List packages: `ls packages/`
- Get oriented with the monorepo layout  
- Understand the relationship between packages

**Step 3: Commands Overview**
- List `.claude/commands/` contents
- Read `.claude/commands/README.md` for workflow overview
- Understand what automation and assistance is available

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

**Critical: This is a guided discovery experience, not a lecture:**

- **Read WITH the user, not FOR them** - Say "Let's read README.md together" then ask them to look at specific sections you both just saw
- **Ask questions about what THEY see** - "What do you notice about the architecture section?" rather than explaining it
- **Let them discover and react** - After reading files together, ask "What interests you most from what we just saw?"
- **Guide, don't summarize** - Point to sections in files rather than repeating their content
- **Follow their curiosity** - If they get excited about something, explore that direction
- **Encourage exploration** - "What do you think that package does? Let's look at its README together"

**Example flow:**
1. "Let's read README.md together" → user and Claude both see the content
2. "Looking at what we just read, what caught your attention most?"  
3. User responds with interest → follow that thread
4. "Great! Let's explore that by looking at [specific file/directory] together"

**Key principle:** The user should feel like they're discovering things themselves with Claude as a helpful guide, not receiving a presentation.