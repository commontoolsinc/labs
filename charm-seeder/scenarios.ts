import { CommandType, type Scenario, type Step } from "./interfaces.ts";

export const scenarios: Scenario[] = [
  {
    name: "2048 Game Long",
    steps: [{
      type: CommandType.New,
      prompt: "a 2048 game",
    }],
  },
  {
    name: "2048 Game Short",
    steps: [{
      type: CommandType.New,
      prompt: "2048 game",
    }],
  },
  {
    name: "Todo List",
    steps: [
      {
        type: CommandType.New,
        prompt: "todo list",
      },
    ],
  },
  {
    name: "Mexican Recipes",
    steps: [{
      type: CommandType.New,
      prompt: "create json to describe 25 mexican meal recipes",
    }],
  },
  {
    name: "Mexican Recipes with Shopping List",
    steps: [{
      type: CommandType.New,
      prompt: "create json to describe 25 mexican meal recipes",
    }, {
      type: CommandType.Extend,
      prompt: "let me create a shopping list from selected recipes",
    }],
  },
  {
    name: "Shopping List",
    steps: [{
      type: CommandType.New,
      prompt:
        "i'd like to keep a shopping list.  let me import from markdown with existing selections.  keep it clean and simple!",
    }],
  },
  {
    name: "Summer Camp Coordination",
    steps: [{
      type: CommandType.New,
      prompt:
        `this is a summer coordination calendar, make it clean like an apple interface. 

it shows variable 3 compact month views at the top (default June, July, August 2025) and allows participants (default Alice) to pick a color and indicate their availability for a given activity. 

when new activities are added, all participants see them and can add their availability. when creating a new activity the active user can specify details like title, description, location, and duration. when a given user is in control, the other users colors become lighter shades, and they click calendar dates to indicate their availability with a colored circle. when a day is selected by multiple participants, place the active participant color behind the others and divide the colors evenly (like a pie chart) to show them all within the circle.

Recommend the 3 best timeframes for the trip based on degree of overlap relative to the activity duration. if there is any overlap, outline the best dates in black.

double clicking toggles the entire week's availability (Sunday through Saturday)

default participants: alice, bob, eve

default activities: Summer Camp (duration 5 days), Monterey Bay Aquarium (duration 1 day), Lake Tahoe (duration 3 days), Beach Day (duration 1 day), Zoo (duration 1 day) 

make it easy to rename and edit activities.

make it minimal and apple-like UI.`,
    }],
  },
  {
    name: "HyperList - Extend Version",
    steps: [{
      type: CommandType.New,
      prompt:
        `Outline tool that allows me to create a hierarchical list where items can be nested under other items by one level per parent/child relationship.  Moving any item will move everything nested inside that item's substructure.  Items at the top level have no parents.

There is a root item in the list that looks the same as the others but can not be deleted.  If one doesn't exist, add one and name it "Root".

Outliner tool that has two modes.

   - The first root item appears like all other items, but can never be deleted.

   - In Nav mode

      - Pressing CMD-RETURN inserts a NEW LIST ITEM on the same level as the ACTIVE SELECTION and switches to Edit mode.  IF ACTIVE SELECTION has indented children, the NEW LIST ITEM appears below all children.

      - Keep track of the hierarchical level of the item as well as the parent. Display the level and item text from the parent in gray to the right of the item.

      - Ensure that items never advance more than one hierarchical level in either direction per key press.

      - The hierarchical level of each ACTIVE SELECTION can be increased or decreased with TAB and SHIFT-TAB.

         - Pressing TAB demotes (indents) the ACTIVE SELECTION one level making it a child of the item above.  If there is a hidden item directly above, show that hierarchy at this time.

         - Pressing SHIFT-TAB promotes (unindents) the ACTIVE SELECTION.

         - Show a disclosure triangle next to any item that has children. Pressing left arrow hides and right arrow shows or single clicking on the disclosure triangle directly toggles.

         - Change the active selection with the up and down arrow keys.  Skip items not shown due to disclosure triangles setting.

      - DELETE deletes the ACTIVE SELECTION

      - Pressing CMD-E or double-clicking an item switches to Edit mode.

   - In Edit mode

      - Edit mode allows editing the text of the ACTIVE SELECTION.  It begins by selecting the existing text or inserting the cursor if there is no text.

      - Pressing escape, up arrow, down arrow, or return switches to Nav mode and selects the current item as active.

Make the UI clean and Apple-like.

   - Include a button to add list items and an indication of Nav or Edit mode at the top of the screen.

   - Make all buttons subtle and minimal.

   - Include a subtle version number in the corner: 0.01`,
    }, {
      type: CommandType.Extend,
      prompt:
        "fix the bug where Tab should set the level to the item above which shares the same level as ActiveItem before indentation (increase hierarchical level) by one increment.",
    }, {
      type: CommandType.Extend,
      prompt:
        "fix the bug where CMD-Return SHOULD insert the new item directly below the current ActiveItem",
    }, {
      type: CommandType.Extend,
      prompt:
        "add the ability to change the order but moving the position of the active selection with CMD-up arrow and CMD-down arrow while retaining hierarchical integrity of all connected child relationships",
    }],
  },
  {
    name: "HyperList 4/14 One-shot",
    steps: [{
      type: CommandType.New,
      prompt: `HyperList is a hierarchical outline tool.

It offers two modes (Nav and Edit) and is driven by keyboard commands.

Hierarchical integrity is maintained as subitems with their Parent items.

    Add a root item "Root" which can not be deleted.
    Force the focus on the outline.
    Pressing CMD-Return:
        If ActiveItem has children, insert a new List Item below all children
            Else, insert a new List Item
        Switch to Edit mode
    Outliner tool that has two modes.
        In Nav mode
            Pressing Tab:
                If there is a hidden item directly above (sharing the same hierarchical Level) show that hierarchy.
                If the parent item is at the same level, increment hierarchical Level by one and indent ActiveItem.
                    Change the selected ActiveItem with the up and down arrow keys. Skip items not shown due to disclosure triangles setting.
            Pressing Shift-Tab:
                Only if Level is not 0, decrement hierarchical Level and change parent to the first item above on at one level below.
            Show a disclosure triangle next to any item that has children. Pressing left arrow hides and right arrow shows or single clicking on the disclosure triangle directly toggles.
                If triangle is in closed position, pressing left arrow again moves the ActiveItem to the parent.
            Double-clicking any item selects that item as ActiveItem and switches to Edit mode
            DELETE deletes the ActiveItem
            Pressing CMD-e switches to Edit mode on the current ActiveItem
            up and down arrow keys
        In Edit mode
            Pressing escape, up arrow, down arrow, or return saves the ActiveItem before switching back to Nav mode
            Pressing Tab in Edit mode should behave the same as Nav mode but allow editing of the ActiveItem text.
            Edit mode allows editing the text of the ActiveItem. It begins by selecting the existing text or inserting the cursor if there is no text.
    ItemDetails is a full height window (with large notes field and Dock button that shows it as a pane on the right) which can be opened by pressing Shift-CMD-o or Shift-CMD-n or double-clicking on any ActiveItem and shows a particular display depending on the ItemType. Focus is shifted to the item text field on open. CMD-Return saves everything and closes the ItemDetails window.
        ItemTypes include:
            List
                Shows Text, Notes (only in Details Window), Date Created (only in Details Window)
            Task
                Shows CompletedState (checkbox), Text, DueDate (with date picker), Notes (only in Details Window), Date Created (only in Details Window)
                Make check boxes green
                Make the due date a red badge if overdue
                Make the due date a blue badge if due today
                Make it so that I can click the due date and change it with a date picker
    Make the UI clean and Apple-like in dark mode.
        Start the list with the item: "Welcome to HyperList." and set to ActiveItem.
        The first item in the list can never be deleted.
        Nav mode keeps the focus on the list.
        The display order of the list always respects the Ordinal Position (per level)
        At the top
            Add Item
            Settings (minimal icon)
                Opens Settings window
                    Rename the App Title
                    Option to Hide Root Item
                    Option to Hide Completed Items
        At the bottom
            Indicate Nav or Edit mode
            Indicate the Indent Level, Displayed Position (vertical), Level Position (relative to it's level) of the ActiveItem, Parent item (Text)
        Triggers:
            As typed:
                Items that begin with [] are converted to ItemType: Task
            On save of new item or edit of existing item:
                Triggers on save new item:
        Additional keyboard commands:
            CMD-e enters Edit mode on ActiveItem
                Pressing escape, up arrow, down arrow, or return saves the ActiveItem before switching back to Nav mode
            Option-Return: Insert a new item above the ActiveItem and switch to Edit mode
            CMD-left arrow: collapse all child items of the ActiveItem
            Shift-CMD-left arrow: collapse all items of the entire outline
            CMD-up arrow and CMD-down arrow changes the Level Position of the ActiveItem. Hierarchical integrity is maintained as all children move with the parent.
            CMD-; Inserts today's Day and Date
            CMD-' Inserts the current time stamp
        Make all buttons subtle and minimal.
        Include a subtle version number in the corner: 0.01
    Fix the bug where users can't add items!
    Force focus on the first item of the list`,
    }],
  },
];
