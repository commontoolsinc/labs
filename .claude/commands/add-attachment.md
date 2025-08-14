# Adding Attachments to Outliner

This guide explains how to attach charms to nodes in the outliner tree.

The user wants to: $ARGUMENTS

## Overview

Attachments allow you to link charms to specific nodes in a page's outline structure. Any charm can be attached to provide additional functionality, data, or visual representations at that location.

## Prerequisites

- A page charm with an outline structure
- A charm to attach (either existing or newly created from a recipe)
- CT binary configured with proper credentials

## Basic Steps

### Step 1: Identify Target Nodes

First, find the page charm and locate nodes where you want to add attachments:

```bash
# Get the outline structure
./dist/ct charm get --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [PAGE_CHARM_ID] outline

# Filter for specific nodes (e.g., nodes without attachments)
./dist/ct charm get --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [PAGE_CHARM_ID] outline | jq '.root.children[].children[] | select(.attachments == [])'
```

### Step 2: Create or Identify Attachment Charm

Either use an existing charm or create a new one from a recipe:

```bash
# Create new charm from recipe
./dist/ct charm new --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] [RECIPES_PATH]/[recipe-name].tsx
# Returns: NEW_CHARM_ID

# Configure the charm if needed
echo '[INPUT_DATA]' | ./dist/ct charm set --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [NEW_CHARM_ID] [INPUT_NAME] --input
```

### Step 3: Link Charm to Node

Attach the charm to the target node's attachments array:

```bash
./dist/ct charm link --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] [ATTACHMENT_CHARM_ID] [PAGE_CHARM_ID]/[PATH_TO_NODE]/attachments/[INDEX]
```

## Path Structure

The outline follows this hierarchy:
```
root
├── body: "text content"
├── children: [
│   ├── [0]
│   │   ├── body: "child text"
│   │   ├── children: [...]
│   │   └── attachments: []
│   └── [1]
│       ├── body: "another child"
│       ├── children: [...]
│       └── attachments: []
└── attachments: []
```

Example paths:
- `page/outline/root/attachments/0` - First attachment at root
- `page/outline/root/children/0/attachments/0` - First attachment of first child
- `page/outline/root/children/1/children/2/attachments/0` - Nested child attachment

## Common Attachment Patterns

### 1. Data Fetchers
Attach charms that fetch and display external data (GitHub repos, APIs, databases):
```bash
# Example: Attach a data fetcher to a node mentioning a resource
./dist/ct charm link --identity [...] [FETCHER_CHARM] [PAGE]/outline/root/children/0/attachments/0
```

### 2. Visualizations
Attach charts, graphs, or other visual representations:
```bash
# Example: Attach a chart to display metrics mentioned in text
./dist/ct charm link --identity [...] [CHART_CHARM] [PAGE]/outline/root/children/1/attachments/0
```

### 3. Interactive Elements
Attach forms, buttons, or interactive components:
```bash
# Example: Attach an input form to a task node
./dist/ct charm link --identity [...] [FORM_CHARM] [PAGE]/outline/root/children/2/attachments/0
```

### 4. Multiple Attachments
Nodes can have multiple attachments at different indices:
```bash
# Attach multiple charms to the same node
./dist/ct charm link --identity [...] [CHARM_1] [PAGE]/outline/root/attachments/0
./dist/ct charm link --identity [...] [CHARM_2] [PAGE]/outline/root/attachments/1
./dist/ct charm link --identity [...] [CHARM_3] [PAGE]/outline/root/attachments/2
```

## Efficient Querying

When working with large outlines or many attachments:

### Filter Unlinked Nodes
```bash
# Find nodes without attachments
jq '.root.children[].children[] | select(.attachments == []) | {body: .body, path: path(.)}'
```

### Target Specific Paths
```bash
# Get only a specific branch to avoid large responses
jq '.root.children[0].children[3]'
```

### Check Existing Attachments
```bash
# List nodes with attachments
jq '.. | select(.attachments? and .attachments != []) | {body: .body, attachments: .attachments | length}'
```

## Verification

After linking, verify the attachment:

```bash
# Check the specific node's attachments
./dist/ct charm get --identity [...] --charm [PAGE_CHARM_ID] outline | jq '[PATH_TO_NODE].attachments'

# Example: Check root's first attachment
./dist/ct charm get --identity [...] --charm [PAGE_CHARM_ID] outline | jq '.root.attachments[0]'
```

## Tips

1. **Index Management**: Attachments are indexed arrays. Use index 0 for the first attachment, 1 for the second, etc.

2. **Selective Updates**: Target specific nodes rather than re-processing entire outlines.

3. **Attachment Types**: Any charm can be an attachment - consider what makes sense for the content.

4. **Performance**: When outlines contain many attachments with large data, use jq filters to query only needed parts.

## Example: Complete Workflow

```bash
# 1. Find a page charm
./dist/ct charm ls --identity ~/dev/.ct.key --api-url https://api.example.com --space myspace
# Returns: page123

# 2. Examine outline for attachment points
./dist/ct charm get --identity ~/dev/.ct.key --api-url https://api.example.com --space myspace --charm page123 outline | jq '.root.children[0]'
# Found: Node at children[0] needs a visualization

# 3. Create visualization charm
./dist/ct charm new --identity ~/dev/.ct.key --api-url https://api.example.com --space myspace ~/recipes/chart.tsx
# Returns: chart456

# 4. Configure the chart
echo '{"data": [1,2,3,4,5]}' | ./dist/ct charm set --identity ~/dev/.ct.key --api-url https://api.example.com --space myspace --charm chart456 chartData --input

# 5. Attach to node
./dist/ct charm link --identity ~/dev/.ct.key --api-url https://api.example.com --space myspace chart456 page123/outline/root/children/0/attachments/0

# 6. Verify
./dist/ct charm get --identity ~/dev/.ct.key --api-url https://api.example.com --space myspace --charm page123 outline | jq '.root.children[0].attachments | length'
# Returns: 1 (success!)
```
