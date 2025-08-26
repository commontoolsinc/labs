# Common Tools Repository Onboarding Tour

This command provides an interactive tour of the Common Tools platform repository, helping new contributors understand where to find information and how to navigate the codebase effectively.

## Tour Overview

This tour will guide you through key information sources in order:

1. **Platform Overview** - Main README and core concepts
2. **Architecture Understanding** - Package structure and roles
3. **Recipe Development** - Programming model and workflows  
4. **Available Workflows** - Claude commands and automation
5. **Development Setup** - Getting started with contributions
6. **Integration Options** - Available tools and connections

## Interactive Tour Script

### STEP 1: Platform Overview

**Read the main README together:**
- Open and review `README.md`
- Focus on "What is Common Tools?" section
- Review architecture overview of packages
- Discuss development practices section

**Ask user about their interest area:**
- Recipe development and building applications?
- Platform development and contributing to core?
- Integration development and extending capabilities?

### STEP 2: Architecture Understanding

**Package exploration:**
- List packages: `ls packages/`
- For each major package, open its README:
  - `packages/toolshed/README.md` - Backend runtime
  - `packages/shell/README.md` - Frontend interface  
  - `packages/ui/README.md` - UI components
  - `packages/patterns/README.md` - Examples and patterns

**Visual repository structure:**
- Show `packages/patterns/` contents for recipe examples
- Point to recipe development folder (if provided)
- Explain monorepo organization

### STEP 3: Recipe Development Resources

**Key documentation to bookmark:**
- `.claude/commands/common/ct.md` - Essential CT binary usage
- `.claude/commands/recipe-dev.md` - Recipe development workflow
- `.claude/commands/imagine-recipe.md` - Creating new recipes

**Recipe development files to find (in recipes folder if available):**
- `RECIPES.md` - Core patterns and examples
- `COMPONENTS.md` - Available UI components  
- `HANDLERS.md` - Event handling patterns

**Show patterns package:**
- Browse `packages/patterns/` for examples
- Identify reusable components and patterns

### STEP 4: Available Claude Commands

**Tour the commands directory:**
- List `.claude/commands/` contents
- Read `.claude/commands/README.md` for overview
- Group commands by category:

**Recipe Development:**
- `/recipe-dev`, `/imagine-recipe`, `/explore-recipe`

**Setup and Infrastructure:**  
- `/deps`, `/setup-space`, `/common/ct`

**Workflow Management:**
- `/linear`, `/fix-issue`, `/fix-pr`, `/review-code`

**Research and Documentation:**
- `/research`, `/maintain-docs`, `/search-wiki`

### STEP 5: Development Setup

**Prerequisites check:**
- Review `deps.md` for required tools
- Point to installation guides for missing dependencies

**Repository guidelines:**
- Read `CLAUDE.md` together for coding standards
- Review CI/CD requirements and testing expectations
- Understand formatting and contribution guidelines

**Initial setup steps:**
- How to build CT binary: `deno task build-binaries --cli-only`
- How to run tests: `deno task test`
- How to check types: `deno task check`

### STEP 6: Integration Capabilities

**Read integration documentation:**
- Review `deps.md` for available integrations
- Understand Claude Code MCP setup options
- Review GitHub workflow integrations

**Available development tools:**
- GitHub CLI for PR/issue workflows
- Linear MCP for task management
- Playwright MCP for browser automation

### STEP 7: Next Steps Planning

**Based on user's interests, point to appropriate starting points:**

**For Recipe Development:**
- Start with `/setup-space` if needed
- Use `/imagine-recipe` for first recipe
- Reference patterns in `packages/patterns/`

**For Platform Development:**
- Review individual package READMEs
- Check `CLAUDE.md` coding guidelines
- Look at existing issues for contribution opportunities

**For Integration Work:**
- Review current integrations in `deps.md`
- Explore `.claude/commands/` for automation patterns

## Tour Completion

**Verify understanding of key locations:**
- [ ] Main `README.md` for platform overview
- [ ] `CLAUDE.md` for development guidelines
- [ ] `.claude/commands/` directory for workflows
- [ ] `packages/` structure and individual READMEs  
- [ ] `deps.md` for integration setup
- [ ] Recipe documentation files (if available)

**Next action items:**
- Choose an area of interest
- Set up development environment
- Pick first task or experiment

## Notes for Claude

- **This is a guide, not information source** - Always read files with the user rather than explaining from memory
- **Focus on discovery** - Help user find and understand information locations  
- **Adapt based on interest** - Spend more time on areas relevant to the user
- **Be interactive** - Ask questions and let user guide depth of exploration
- **Reference files directly** - Use Read tool to show actual content
- **Connect the dots** - Help user understand relationships between different parts

The goal is teaching navigation and information discovery, not information transfer.