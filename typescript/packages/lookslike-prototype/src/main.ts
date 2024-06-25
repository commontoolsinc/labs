export * as ComAppGrid from "./components/com-app-grid.js";
export * as ComContent from "./components/com-content.js";
export * as ComChat from "./components/com-chat.js";
export * as ComThread from "./components/com-thread.js";
export * as ComPrompt from "./components/com-prompt.js";
export * as ComResponse from "./components/com-response.js";
export * as ComThreadGroup from "./components/com-thread-group.js";
export * as ComButton from "./components/com-button.js";
export * as ComUnibox from "./components/com-unibox.js";
export * as ComEditor from "./components/com-editor.js";
export * as ComToggle from "./components/com-toggle.js";
export * as ComCode from "./components/com-code.js";
export * as ComData from "./components/com-data.js";
export * as ComThoughtLog from "./components/com-thought-log.js";
export * as ComShader from "./components/com-shader.js";
export * as ComMarkdown from "./components/com-markdown.js";
export * as ComDebug from "./components/com-debug.js";
export * as ComModuleCode from "./components/modules/com-module-code.js";
export * as ComModuleUi from "./components/modules/com-module-ui.js";
export * as ComModuleFetch from "./components/modules/com-module-fetch.js";
export * as ComModuleLlm from "./components/modules/com-module-llm.js";
export * as ComModuleImage from "./components/modules/com-module-image.js";
export * as ComModuleShader from "./components/modules/com-module-shader.js";
export * as ComModuleEvent from "./components/modules/com-module-event.js";
export * as ComModuleStorage from "./components/modules/com-module-storage.js";

export * as ComApp from "./components/com-app.js";

import { LLMClient } from "@commontools/llm-client";
import { activateServiceWorker } from "@commontools/usuba-rt";
import { LLM_SERVER_URL } from "./llm-client.js";

await activateServiceWorker();

// const client = new LLMClient({
//   serverUrl: LLM_SERVER_URL,
//   tools: [],
//   system: "",
// });

// const thread = await client.createThread("Hello, world!");
// await thread.sendMessage("What is the meaning of life?");
// await thread.sendMessage("Woah, really?");
