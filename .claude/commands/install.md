---
description: Install the Common Tools plugin in the current project
disable-model-invocation: false
---

Help the user install the Common Tools plugin in their current project. Follow these steps:

1. Add this repository as a marketplace:
   ```
   /plugin marketplace add <path-to-this-repo>
   ```
   (Determine the path based on the plugin root at ${CLAUDE_PLUGIN_ROOT})

2. Install the plugin at project scope so it's shared with the team:
   ```
   /plugin install common-tools@common-tools-marketplace --scope project
   ```

3. Verify the installation worked by checking `/help` shows common-tools skills.

4. Let the user know they may want to add recommended permissions to their
   `.claude/settings.json`:
   ```json
   {
     "permissions": {
       "allow": [
         "Bash(deno test:*)",
         "Bash(deno lint:*)"
       ]
     }
   }
   ```

Tell the user to restart Claude Code after installation to pick up all changes.
