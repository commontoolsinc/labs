# Well-Known IDs

CommonTools provides well-known IDs for accessing system-level data within a space.

## allCharms (Charms List)

**ID:** `baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye`

**Purpose:** Contains a list of all charms in the current space.

**Common Usage:** Link to charm inputs that need to access the full charm list.

**Example:**
```bash
deno task ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [target-charm]/allCharms
```

**Use Cases:**
- Building UI that displays all charms in a space
- Creating dashboards or management interfaces
- Implementing charm discovery or search functionality
- Building tools that operate across multiple charms

## How Well-Known IDs Work

Well-known IDs are special charm IDs that:
- Are consistent across all spaces
- Provide access to system-level data
- Can be used in links just like regular charm IDs
- Always have the same ID regardless of deployment

When linking a well-known ID to a charm's input field, the target charm will receive live updates whenever the underlying data changes (e.g., when new charms are added to the space).
