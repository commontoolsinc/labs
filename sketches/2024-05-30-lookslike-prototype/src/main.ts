export * as ComAppGrid from './components/com-app-grid'
export * as ComContent from './components/com-content'
export * as ComChat from './components/com-chat'
export * as ComThread from './components/com-thread'
export * as ComPrompt from './components/com-prompt'
export * as ComResponse from './components/com-response'
export * as ComThreadGroup from './components/com-thread-group'
export * as ComButton from './components/com-button'
export * as ComUnibox from './components/com-unibox'
export * as ComEditor from './components/com-editor'
export * as ComApp from './components/com-app'

import { doLLM } from './llm'

async function start() {
  const result = await doLLM('hello world', '', null)
  console.log(result)
}

start()
