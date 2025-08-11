# CommonTools Space Mapping Workflow

**INSTRUCTIONS FOR AI AGENT**: When the `/walk-space` command is invoked, execute the steps in this workflow to map a CommonTools space. Do not explain the workflow - actually run the commands and store data in the memory knowledge graph.

## Overview

This workflow enables semantic mapping and change tracking of CommonTools spaces using the memory MCP knowledge graph system. It creates a searchable knowledge graph of charm states, relationships, and evolution over time.

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
# First, list all charms in the space
./dist/ct charm ls --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name]

# Optionally generate visual map
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

### 3. Create Knowledge Graph Entries

Use `mcp__memory__add_memory` to build the knowledge graph:

#### Individual Charm Documentation
- **Name**: "Charm: [Name] ([Type])"
- **Episode Body**: Include charm ID, type, purpose, content summary, technical details, connections
- **Source**: "text" or "json" (for structured charm data)
- **Source Description**: "charm [type] in [space-name]"
- **Group ID**: "[space-name]"

#### Space Relationships (JSON Format)
- **Name**: "Space Relationships: [space-name] @ [timestamp]"
- **Episode Body**: JSON string containing charm connections and data flows
  ```json
  {
    "space": "space-name",
    "timestamp": "ISO-timestamp",
    "relationships": [
      {"source": "charm-id-1", "target": "charm-id-2", "type": "data-flow"},
      {"source": "charm-id-2", "target": "charm-id-3", "type": "connection"}
    ]
  }
  ```
- **Source**: "json"
- **Source Description**: "relationship mapping for [space-name]"
- **Group ID**: "[space-name]"

#### Space Snapshot
- **Name**: "Space Snapshot: [space-name] @ [ISO-timestamp]"
- **Episode Body**: Complete state of all charms, connections, and metadata
- **Source**: "json"
- **Source Description**: "complete snapshot of [space-name]"
- **Group ID**: "[space-name]"

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
   Use `mcp__memory__add_memory`:
   - **Name**: "Space Changes: [space-name] @ [ISO-timestamp]"
   - **Episode Body**: Detailed list of all changes detected, including added/removed charms, modified content
   - **Source**: "text"
   - **Source Description**: "changes detected in [space-name]"
   - **Group ID**: "[space-name]"

4. **Create new snapshot**
   - Reference previous snapshot
   - Link to change documentation
   - Update charm states

### 5. Search and Analysis

#### Find specific charms
Use the memory MCP tools:

- **Semantic search for nodes**: `mcp__memory__search_memory_nodes`
  - Query: "dog pet border collie"
  - Query: "page recipe outliner component"
  - Group IDs: ["[space-name]"]
  
- **Search for facts/relationships**: `mcp__memory__search_memory_facts`
  - Query: "data flow connections"
  - Group IDs: ["[space-name]"]

#### Track evolution
- **Get recent episodes**: `mcp__memory__get_episodes`
  - Group ID: "[space-name]"
  - Last N: 10 (to see recent snapshots)

- **Search for changes**: `mcp__memory__search_memory_nodes`
  - Query: "changes modifications updates snapshot"
  - Group IDs: ["[space-name]"]

## Memory Episode Guidelines

### Essential Fields
- **Name**: Consistent naming pattern for easy identification (include type in name)
- **Episode Body**: Structured content (text or JSON)
- **Source**: "text" for narratives, "json" for structured data, "message" for conversations
- **Source Description**: Descriptive context including content type and space
- **Group ID**: Single identifier per space (like a tag, but only one allowed)

### Group ID Strategy
- Use `[space-name]` as the single group ID for all content related to that space
- Differentiate content types through:
  - **Name patterns**: Include type ("Charm:", "Snapshot:", "Changes:", "Reflection:")
  - **Source descriptions**: Be specific about what kind of data it is
  - **Episode body structure**: Use consistent formats for each type

## Example Implementation Flow

### Initial Space Mapping
1. List charms using `ct charm ls`
2. For each charm:
   - Use `ct charm get` to extract data
   - Add to knowledge graph with `mcp__memory__add_memory` (group: "[space-name]")
3. Document relationships with `mcp__memory__add_memory` (source: "json", group: "[space-name]")
4. Create baseline snapshot with `mcp__memory__add_memory` (source: "json", group: "[space-name]")

### Subsequent Scans
1. List charms again with `ct charm ls`
2. Extract current data for comparison
3. Search previous data: `mcp__memory__search_memory_nodes` or `mcp__memory__get_episodes` (group: "[space-name]")
4. If changes detected:
   - Record changes with `mcp__memory__add_memory` (group: "[space-name]")
   - Create new snapshot with `mcp__memory__add_memory` (group: "[space-name]")
   - Add updated charm states to graph (new episodes build on existing knowledge)

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
   - Use `mcp__memory__search_memory_nodes` to find all entities about specific topics
   - Use `mcp__memory__search_memory_facts` to understand relationships
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
   Add to knowledge graph recording the AI contribution:
   - Name: "AI Reflection: [Topic] @ [timestamp]"
   - Episode Body: Include charm ID, key insights, observations, questions
   - Source: "text"
   - Source Description: "ai reflection on [topic] in [space-name]"
   - Group ID: "[space-name]"

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