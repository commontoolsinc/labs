import { View } from "./view.js"
import { hstack } from "../components/hstack.js"

export const tags: Record<string, View> = Object.freeze({
  hstack
})

export default tags

/** Index of factory functions by HTML tag name (lowercase) */
const viewByTag = Object.fromEntries(
  Object.values(tags).map((factory) => [factory.tag, factory])
)

export const getViewByTag = (tag: string) => viewByTag[tag]
