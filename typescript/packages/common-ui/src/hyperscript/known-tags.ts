import * as Tags from './tags.js';
import { View } from './view.js';

const viewByName: Record<string, View> = Object.freeze({...Tags})

/** Index of factory functions by HTML tag name */
const viewByTag = Object.fromEntries(
  Object.values(viewByName).map((factory) => [factory.tag, factory])
)

export const getViewByTag = (tag: string) => viewByTag[tag]
