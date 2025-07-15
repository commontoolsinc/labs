# Todos Command

Manage todo lists using CommonTools. Deploy new lists or work with existing ones.

## Usage

`/todos [item]` - Add item to todo list (deploys new if needed)
`/todos [URL]` - Work with existing todo list
`/todos` - Deploy new empty todo list

## Command Pattern

Direct todo management using CommonTools:

**Standard Parameters:**
- Identity: claude.key
- API URL: https://toolshed.saga-castor.ts.net/
- Recipe: recipes/todo-list.tsx
- Space: Use date-based naming like `2025-07-15-claude-dev` (format: YYYY-MM-DD-claude-dev)

**Quick CT Commands:**
- READ: `./dist/ct charm get [params] --charm [id] [path]`
- SET: `echo '[value]' | ./dist/ct charm set [params] --charm [id] [path]`
- CALL: `echo '[json]' | ./dist/ct charm call [params] --charm [id] [handler]`

**Todo Operations:**
- Add item: `echo '{"title": "text"}' | ct charm call [params] --charm [id] addItem`
- Mark done: `echo 'true' | ct charm set [params] --charm [id] items/0/done`
- Read items: `ct charm get [params] --charm [id] items`

**Scenarios:**
- [SCENARIO A: URL provided] Extract space/charm from URL, work with existing list
- [SCENARIO B: Add item] Find/deploy todo list in date-based space (YYYY-MM-DD-claude-dev), add item
- [SCENARIO C: Deploy only] Deploy new list, provide URL and usage

**Return**: Confirmation, URL, current items, usage instructions

## Benefits

- Persistent task tracking across Claude sessions
- Direct data manipulation via SET commands
- Full web UI via CommonTools interface
- API accessible for automation

Simple, fast, persistent todo management.
