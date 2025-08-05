# CommonTools Space Mapping Workflow

## Overview

This workflow enables semantic mapping and change tracking of CommonTools spaces using the murmur fragment system. It creates a searchable knowledge graph of charm states, relationships, and evolution over time.

## Core Concepts

### Space Mapping
- **Goal**: Build a semantic understanding of a CommonTools space
- **Method**: Extract charm data and relationships, store as searchable fragments
- **Benefit**: Enable natural language queries about space contents and history

### Change Tracking
- **Goal**: Monitor how spaces evolve over time
- **Method**: Create timestamped snapshots and document differences
- **Benefit**: Understand user patterns and space development

## Workflow Steps

### 1. Initial Space Discovery

```bash
# List all charms in the space
./dist/ct charm ls --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name]

# Generate visual map (optional)
./dist/ct charm map --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name]
./dist/ct charm map --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --format dot
```

### 2. Data Extraction

For each charm discovered:

```bash
# Get key fields
./dist/ct charm get --identity [key] --api-url [url] --space [space] --charm [charm-id] title
./dist/ct charm get --identity [key] --api-url [url] --space [space] --charm [charm-id] tags
./dist/ct charm get --identity [key] --api-url [url] --space [space] --charm [charm-id] outline
# Additional fields as needed based on charm type
```

### 3. Create Semantic Fragments

Use `mcp__murmur__record_fragment` with these patterns:

#### Individual Charm Documentation
- **Title**: "Charm: [Name] ([Type])"
- **Type**: "reference"
- **Tags**: ["charm", "type", "space-name", ...content-tags]
- **Body**: Include charm ID, type, purpose, content summary, technical details
- **Priority**: "medium"

#### Space Relationships
- **Title**: "Space Relationships: [space-name]"
- **Type**: "documentation"
- **Tags**: ["relationships", "connections", "data-flow", "space-name"]
- **Body**: Document all charm connections, data flows, and dependencies
- **Priority**: "medium"

#### Space Snapshot
- **Title**: "Space Snapshot: [space-name] @ [ISO-timestamp]"
- **Type**: "reference"
- **Tags**: ["snapshot", "change-tracking", "space-name", "baseline"]
- **Priority**: "high"
- **Metadata**: {
    "snapshot_time": "ISO-timestamp",
    "charm_count": N,
    "is_baseline": true/false,
    "previous_snapshot": "fragment-id"
  }
- **Body**: Complete state of all charms, connections, and metadata

### 4. Iterative Monitoring

On subsequent scans:

1. **Rescan the space**
   - List charms again
   - Extract current data for each charm

2. **Compare with previous snapshot**
   - Check for new/removed charms
   - Identify changed titles, tags, content
   - Note new or removed connections

3. **Document changes**
   Use `mcp__murmur__record_fragment`:
   - **Title**: "Space Changes: [space-name] @ [ISO-timestamp]"
   - **Type**: "documentation"
   - **Tags**: ["changes", "space-name", "update"]
   - **Metadata**: {
       "previous_snapshot_id": "fragment-id",
       "change_time": "ISO-timestamp"
     }
   - **Body**: Detailed list of all changes detected
   - **Priority**: "medium"

4. **Create new snapshot**
   - Reference previous snapshot
   - Link to change documentation
   - Update charm states

### 5. Search and Analysis

#### Find specific charms
Use the murmur fragment tools:

- **Semantic search**: `mcp__murmur__search_fragments_similar`
  - Query: "dog pet border collie"
  - Query: "page recipe outliner component"
  
- **Tag-based search**: `mcp__murmur__list_fragments`
  - Parameters: `tags=["snapshot", "space-name"]`

#### Track evolution
- **Get all snapshots**: `mcp__murmur__list_fragments`
  - Parameters: `tags=["snapshot", "space-name"], type="reference"`
  - Sort by creation date to see chronological progression

- **Find all changes**: `mcp__murmur__list_fragments`
  - Parameters: `tags=["changes", "space-name"], type="documentation"`

## Fragment Schema Guidelines

### Essential Fields
- **Title**: Consistent naming pattern for easy identification
- **Body**: Structured content with clear sections
- **Type**: `reference` for states, `documentation` for analysis
- **Tags**: Enable filtering and categorization
- **Priority**: `high` for snapshots, `medium` for changes
- **Metadata**: Machine-readable data for automation

### Tagging Strategy
- Always include space name
- Add content-specific tags (pet, recipe-type, etc.)
- Use temporal tags for time-based queries
- Include relationship tags (connected-to, uses, etc.)

## Example Implementation Flow

### Initial Space Mapping
1. List charms using `ct charm ls`
2. For each charm:
   - Use `ct charm get` to extract data
   - Create charm fragment with `mcp__murmur__record_fragment`
3. Document relationships with `mcp__murmur__record_fragment` (type: documentation)
4. Create baseline snapshot with `mcp__murmur__record_fragment` (type: reference, metadata includes is_baseline: true)

### Subsequent Scans
1. List charms again with `ct charm ls`
2. Extract current data for comparison
3. Search previous snapshot: `mcp__murmur__search_fragments_by_title` or `mcp__murmur__list_fragments`
4. If changes detected:
   - Record changes with `mcp__murmur__record_fragment` (type: documentation)
   - Create new snapshot with `mcp__murmur__record_fragment` (reference previous snapshot ID)
   - Update existing charm fragments with `mcp__murmur__update_fragment`

## Benefits

1. **Semantic Search**: Find charms by meaning, not just keywords
2. **Change History**: Understand how spaces evolve
3. **Relationship Mapping**: Visualize data flows and dependencies
4. **Pattern Recognition**: Identify common usage patterns
5. **Space Understanding**: Build AI comprehension of user intent
6. **AI Collaboration**: Agents can contribute meaningful content based on user data
7. **Reflective Analysis**: Generate insights and questions that enrich user documentation

## Known Limitations

- Embedding similarity scores may be too high (bug to be filed)
- Circular references in charm inspect can cause errors
- Large spaces may require pagination strategies

## AI Reflection Process

### Purpose
Enable AI agents to contribute meaningful content to spaces by analyzing user data and creating reflective pages with observations, questions, and suggestions.

### Workflow for Content Reflection

1. **Analyze existing content**
   - Use `mcp__murmur__search_fragments_similar` to find all content about specific topics
   - Extract actual user data from charm fields (not just metadata)
   - Focus on what the user has written, not technical implementation

2. **Generate reflections**
   - **Observations**: What patterns or interesting details do you notice?
   - **Questions**: What would you like to know more about?
   - **Suggestions**: How could the user enrich their documentation?
   - **Pattern Analysis**: What does their documentation style reveal?

3. **Deploy reflection page**
   ```bash
   # Deploy a new page.tsx instance
   ./dist/ct charm new --identity [key] --api-url [url] --space [space] [page-recipe-path]
   
   # Set meaningful title
   echo '"Reflections on [Topic] 🤔"' | ./dist/ct charm set [params] --charm [new-charm-id] title
   
   # Set appropriate tags
   echo '["reflection", "analysis", "topic", "ai-observations"]' | ./dist/ct charm set [params] --charm [new-charm-id] tags
   
   # Create outline content (write to file first to avoid escaping issues)
   cat outline.json | ./dist/ct charm set [params] --charm [new-charm-id] outline
   
   # Link to allCharms for mentionable functionality
   ./dist/ct charm link [params] [allCharms-id] [new-charm-id]/mentionable
   ```

4. **Document the reflection**
   Create a fragment recording the AI contribution:
   - Title: "AI Reflection: [Topic] @ [timestamp]"
   - Type: "documentation"
   - Tags: ["ai-reflection", "space-name", "topic"]
   - Include charm ID and key insights

### Reflection Content Guidelines

- **Be specific**: Reference actual data the user entered
- **Be curious**: Ask thoughtful questions based on the content
- **Be helpful**: Suggest concrete ways to expand documentation
- **Be respectful**: Frame observations positively
- **Be relevant**: Focus on the user's interests, not technical details

### Example Reflection Structure
```json
{
  "root": {
    "body": "",
    "children": [
      {
        "body": "## Observations about [Topic]",
        "children": [/* Specific observations about user's content */]
      },
      {
        "body": "## Questions I am Curious About",
        "children": [/* Thoughtful questions based on the data */]
      },
      {
        "body": "## Suggestions for Enriching [Topic]",
        "children": [/* Concrete suggestions for expansion */]
      },
      {
        "body": "## Patterns I Noticed",
        "children": [/* Analysis of documentation style and evolution */]
      }
    ]
  }
}
```

## Future Enhancements

1. **Automated scanning**: Periodic space checks
2. **Change notifications**: Alert on significant modifications
3. **Pattern analysis**: Identify common charm combinations
4. **Space templates**: Suggest charms based on usage patterns
5. **Version control**: Git-like branching for space states
6. **AI collaboration**: Multiple agents contributing different perspectives
7. **Content suggestions**: AI-generated prompts based on existing content