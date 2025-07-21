# Documentation Review Command

Review documentation for accuracy, completeness, and developer workflow issues, with a focus on areas with recent development activity.

## Process

### Phase 1: Context Discovery (5-10 minutes)
1. **Check recent git activity** to identify areas of active development:
   - `git log --oneline --since="2 weeks ago" -- "*.md"` - Recent doc changes
   - `git log --oneline --since="2 weeks ago" --name-only` - Recent code changes
   - Focus on frequently modified packages and new features

2. **Quick documentation landscape scan**:
   - Identify main documentation files and their relationships
   - Check for symlinks, aliases, or generated files
   - Spot obvious critical issues (broken links, missing core docs)

### Phase 2: Targeted Analysis (15-20 minutes)
3. **Focus on developer workflow blockers**:
   - Can someone follow the setup/development instructions?
   - Do import statements and code examples actually work?
   - Are package paths and directory structures accurate?

4. **Cross-reference docs with recent code changes**:
   - Check if areas with recent development have up-to-date documentation
   - Verify that new features or architectural changes are documented
   - Look for implementation details that contradict existing docs

5. **Verify structural claims**:
   - Do referenced packages, files, and directories exist?
   - Are import paths and command examples correct?
   - Do links resolve properly?

### Phase 3: Prioritized Reporting (5 minutes)
6. **Categorize findings by impact**:
   - **Critical**: Blocks developer workflow, incorrect instructions
   - **High**: Significant confusion or outdated major features  
   - **Medium**: Minor inconsistencies in active development areas
   - **Low**: Stylistic issues, minor formatting problems

7. **Ask clarifying questions** when scope is unclear:
   - "Should I focus on specific packages or workflows?"
   - "Are there particular types of issues you're most concerned about?"
   - "Should I prioritize accuracy fixes or structural improvements?"

## Focus Areas

### Primary Concerns
- **Workflow blockers**: Instructions that don't work
- **Import/reference accuracy**: Code examples that fail
- **Recent change documentation**: Areas with active development
- **Package relationship clarity**: How components fit together

### Secondary Concerns  
- Architectural documentation gaps
- Missing guides for complex patterns
- Cross-reference accuracy
- Link integrity

### Defer Unless Specifically Requested
- Minor formatting inconsistencies
- Stylistic preferences
- Comprehensive style guide compliance
- Low-impact wording improvements

## Key Questions to Answer
1. **"If someone tried to follow these docs today, where would they get stuck?"**
2. **"What recent changes might have made existing docs inaccurate?"**
3. **"Are there new features or patterns that need documentation?"**
4. **"Do the most actively developed areas have adequate documentation?"**

## Verification Before Fixes
- Confirm file relationships (symlinks, aliases) before flagging duplicates
- Verify proposed fixes are correct (check actual package names, paths)
- Test that suggested import statements and commands actually work
- Ask for confirmation on significant structural changes