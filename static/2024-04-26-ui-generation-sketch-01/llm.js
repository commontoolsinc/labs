let apiKey = localStorage.getItem("apiKey");

if (!apiKey) {
  // Prompt the user for the API key if it doesn't exist
  const userApiKey = prompt("Please enter your API key:");

  if (userApiKey) {
    // Save the API key in localStorage
    localStorage.setItem("apiKey", userApiKey);
    apiKey = userApiKey;
  } else {
    // Handle the case when the user cancels or doesn't provide an API key
    alert("API key not provided. Some features may not work.");
  }
}

const x = `
Here's a compressed version of the are.na API specification tailored for an experienced programmer:

## are.na API Overview

### Setup
Wrap your code in module using <script type="module></script> and then import an instance of the Are.na API client:

import { arena } from './access.js';

### Channel Operations
Perform actions on channels using the following methods:

- \`channel([slug || id][, params])\`: Interact with a specific or multiple channels.
  - \`.get([params])\`: Fetch channel details. Supports pagination.
  - \`.thumb([params])\`: Fetch channel thumbnail.
  - \`.connections([params])\`: List connections of the channel. Supports pagination.
  - \`.channels([params])\`: List channels connected to channel’s blocks. Supports pagination.
  - \`.contents([params])\`: Fetch only channel contents. Supports pagination.
  - \`.collaborators([params])\`: List channel collaborators. Supports pagination.
  - \`.create(title[, status])\`: Create a channel.
  - \`.update(params)\`: Update channel details (e.g., title, status).
  - \`.delete([slug])\`: Delete a channel.
  - \`.addCollaborators(...userIds)\`: Add collaborators.
  - \`.deleteCollaborators(...userIds)\`: Remove collaborators.
  - \`.createBlock(content || source)\`: Add a block to the channel.
  - \`.deleteBlock(blockId)\`: Remove a block.

### Block Operations
Manage blocks within the are.na channels:

- \`block([id][, params])\`:
  - \`.get([params])\`: Retrieve block details.
  - \`.channels([params])\`: Fetch channels containing the block.
  - \`.create(channelSlug, content || source)\`: Create a new block.
  - \`.update({ content, title, description })\`: Update block details.

### User Operations
Interact with are.na user profiles and their contents:

- \`user(id || slug[, params])\`:
  - \`.get([params])\`: Fetch user details.
  - \`.channels([params])\`: List user's channels. Supports pagination.
  - \`.following([params])\`: List entities the user follows. Supports pagination.
  - \`.followers([params])\`: List user's followers. Supports pagination.

### Search Functionality
Query channels, blocks, or users:

- \`search(query[, params])\`:
  - \`.all([params])\`: Search across channels, blocks, and users.
  - \`.users([params])\`: Search specifically for users.
  - \`.channels([params])\`: Search specifically for channels.
  - \`.blocks([params])\`: Search specifically for blocks.

This API utilizes JavaScript promises for handling asynchronous operations, ensuring responses are managed effectively with \`.then()\` for resolved promises and \`.catch()\` for handling errors. Each method that supports pagination accepts an object with \`page\` and \`per\` properties to control the response volume.`;

const system = `
<task>
  Weaver generates user interfaces on demand using web technology. Weaver takes a user request and determines the best way to service it using the Are.na API and a bespoke user-interface based on the user's needs. Weaver then generates the HTML, CSS and Javascript needed to display the requested content in an iframe.
  Weaver will output the full HTML, CSS and Javascript as one file,  designed to be run in an iframe.
  </task>

  <arena_api>
  ${x}
  </arena_api>

  Act as Weaver to fulfill the following user_request.
`;

function prompt(message) {
  return `
  <task>
  Weaver generates user interfaces on demand using web technology. Weaver takes a user request and determines the best way to service it using the Are.na API and a bespoke user-interface based on the user's needs. Weaver then generates the HTML, CSS and Javascript needed to display the requested content in an iframe.
  Weaver will output the full HTML, CSS and Javascript as one file,  designed to be run in an iframe.
  </task>

  <arena_api>
  ${x}
  </arena_api>

  Act as Weaver to fulfill the following user_request.

  <user_request>${message}</user_request>
  Generated Code:

  Give NO commentary, NO explanations, just the code.
  <generated_code>
  `;
}

export async function sendPrompt(message, last) {
  let systemPrompt = system;
  if (last) {
    systemPrompt += " " + `<prev_generated_code>${last}</prev_generated_code>`;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    body: JSON.stringify({
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt(message) }],
      model: "claude-3-opus-20240229",
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  const data = await res.json();
  console.log(data);
  return data.content[0].text;
}
