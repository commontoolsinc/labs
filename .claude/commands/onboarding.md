# Common Tools Repository Onboarding Tour

This command provides an interactive tour of the Common Tools platform repository, helping new contributors understand the codebase architecture, key concepts, and development workflows.

## Tour Overview

This tour will guide you through:

1. **Understanding Common Tools** - What the platform is and how it works
2. **Repository Architecture** - Key packages and their roles  
3. **Recipe Development** - The core programming model
4. **Available Claude Commands** - Workflow automation and assistance
5. **Development Setup** - Getting started with contributions
6. **Integration Capabilities** - Available tools and connections

## Interactive Tour Script

### STEP 1: Understanding Common Tools Platform

**Explain the core concepts:**

Common Tools is a distributed computing platform where users create and connect reactive programs called **recipes**. These recipes run as **charms** in collaborative **spaces**.

**Key concepts to understand:**
- **Recipes**: Reactive TypeScript/JSX programs that process data and render UIs
- **Charms**: Deployed instances of recipes running in spaces
- **Spaces**: Collaborative environments where charms interact
- **Linking**: How charms share data and create workflows
- **CT Binary**: CLI tool for managing charms and deployments

**Show the user the main README:**
- Read and explain `/README.md`
- Highlight the "What is Common Tools?" section
- Explain the architecture overview

**Visual example from repository structure:**
- Show `packages/patterns/` for recipe examples
- Point to `packages/ui/` for available components
- Reference `recipes/` folder (if provided) for user's recipe development

### STEP 2: Repository Architecture Deep Dive

**Core packages explanation:**

**Backend - Toolshed (`./packages/toolshed/`):**
- Distributed runtime and storage backend
- Written in Deno2
- Hosts spaces and manages charm execution
- Development: `cd ./packages/toolshed && deno task dev`

**Frontend - Shell (`./packages/shell/`):**
- Web interface for interacting with spaces
- Built with Lit Web Components  
- Development: `cd ./packages/shell && deno task dev`
- Default: http://localhost:5173 → http://localhost:8000

**CLI - CT Binary:**
- Command-line interface for charm management
- Built with: `deno task build-binaries --cli-only`
- Essential for recipe development and deployment
- See detailed usage: [`.claude/commands/common/ct.md`](./.claude/commands/common/ct.md)

**UI Components (`./packages/ui/`):**
- Custom VDOM layer and `ct-` prefixed components
- Used by recipes for rendering interfaces
- Provides consistent visual elements

**Patterns & Examples (`./packages/patterns/`):**
- Example recipes and reusable patterns
- Reference implementations
- Starting point for new recipe development

### STEP 3: Recipe Development Understanding

**What are recipes?**
- Reactive programs written in TypeScript/JSX
- Run in secure sandboxed environments
- Can link to other recipes to create data flows
- Render UIs using `ct-` prefixed components

**Recipe development workflow:**
1. **Create/modify** recipes using TypeScript/JSX
2. **Deploy** as charms using CT binary
3. **Link** charms together to create workflows  
4. **Test** and iterate with browser interfaces

**Key development files to reference:**
- `RECIPES.md` (in recipes folder) - Core patterns and examples
- `COMPONENTS.md` (in recipes folder) - Available UI components
- `HANDLERS.md` (in recipes folder) - Event handling patterns

**Recipe types and patterns:**
- **Filter recipes**: Process collections, output filtered subsets
- **Transformer recipes**: Convert data between formats
- **Aggregator recipes**: Combine multiple inputs
- **UI recipes**: Provide interactive interfaces
- **Integration recipes**: Connect to external APIs

### STEP 4: Available Claude Commands Overview

**Show and explain the `.claude/commands/` directory structure:**

**Recipe Development Commands:**
- `/recipe-dev` - Interactive recipe development and modification
- `/imagine-recipe` - Create new recipes from natural language descriptions
- `/explore-recipe` - Test recipes with Playwright browser automation

**Setup and Infrastructure:**
- `/deps` - Dependency and integration setup guide
- `/setup-space` - CommonTools space initialization
- `/common/ct` - Essential CT binary usage patterns

**Workflow and Task Management:**
- `/linear` - Linear task management integration
- `/fix-issue` - GitHub issue resolution workflow
- `/fix-pr` - Pull request improvement workflow
- `/review-code` - Code review assistance

**Research and Documentation:**
- `/research` - Codebase investigation and analysis
- `/maintain-docs` - Documentation maintenance
- `/search-wiki` - Knowledge base searching

**Explain command usage pattern:**
- Commands are invoked with `/command-name` in Claude Code
- Each provides structured workflows for specific tasks
- Commands can be chained and combined for complex workflows

### STEP 5: Development Setup Walkthrough

**Prerequisites verification:**
1. **Check Deno 2 installation:** `deno --version`
   - If missing: [Installation guide](https://docs.deno.com/runtime/getting_started/installation/)

2. **Verify GitHub CLI (optional but recommended):** `gh --version`
   - If missing: [GitHub CLI installation](https://github.com/cli/cli)

**Repository setup:**
1. **Build CT binary:** `deno task build-binaries --cli-only`
   - This takes a few minutes but is essential
   - Verify: `./dist/ct --help`

2. **Run tests:** `deno task test`
   - Ensures repository is working correctly

3. **Type checking:** `deno task check`
   - Verifies TypeScript compilation

**Recipe development setup (if user has recipes):**
1. Navigate to recipes repository
2. Run: `./dist/ct init` - Sets up TypeScript types
3. This creates/updates tsconfig.json with proper CommonTools types

**Identity and space setup:**
- Create identity: `./dist/ct id new > claude.key`
- API URL: `https://toolshed.saga-castor.ts.net/`
- Choose space name for development work

### STEP 6: Integration Capabilities

**Explain available integrations from `deps.md`:**

**Claude Code MCP Integrations:**
- **Linear Server MCP**: Task and project management
  - Setup: `claude mcp add --transport sse linear-server https://mcp.linear.app/sse`
  - Usage: `/linear` command for workflow integration
  
- **Playwright MCP**: Browser automation for recipe testing
  - Setup: `claude mcp add playwright npx '@playwright/mcp@latest'`
  - Usage: Interactive testing in `/explore-recipe`, `/imagine-recipe`

**Development workflow integrations:**
- **GitHub CLI**: PR and issue management workflows
- **Git**: Version control with CI/CD integration
- **Deno**: Runtime, testing, and formatting tools

### STEP 7: Next Steps and Pathways

**Based on user interest, suggest appropriate next steps:**

**For Recipe Development:**
- Use `/imagine-recipe` to create a first recipe
- Explore `packages/patterns/` for examples
- Reference recipe documentation files
- Set up a development space with `/setup-space`

**For Platform Development:**
- Explore individual package README files
- Run backend: `cd packages/toolshed && deno task dev`
- Run frontend: `cd packages/shell && deno task dev`
- Review [CLAUDE.md](./CLAUDE.md) coding guidelines

**For Integration Development:**
- Check current integrations in `deps.md`
- Explore MCP capabilities with Claude Code
- Consider new integration possibilities

**For Research and Understanding:**
- Use `/research` to investigate specific aspects
- Read codebase documentation and inline comments
- Explore existing patterns and implementations

## Tour Completion Checklist

By the end of this tour, users should understand:

- [ ] What Common Tools platform does and how it works
- [ ] Repository structure and key packages
- [ ] Recipe development concepts and workflows  
- [ ] Available Claude commands and their purposes
- [ ] How to set up development environment
- [ ] Integration capabilities and setup
- [ ] Next steps for their specific interests

## Notes for Claude

- **Adapt the tour** based on user's experience level and interests
- **Reference actual files** in the repository when explaining concepts
- **Show practical examples** from patterns and existing code
- **Suggest hands-on activities** like building a first recipe
- **Connect concepts** between different parts of the platform
- **Be interactive** - ask questions and get user feedback throughout

This tour should take 15-30 minutes depending on depth and user questions. Focus on understanding rather than memorization - users can always reference documentation and commands later.