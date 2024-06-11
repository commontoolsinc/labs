import * as Tags from './tags.js';
import { View } from './view.js';

const {freeze, values, fromEntries} = Object;

const viewByName: Record<string, View> = freeze({...Tags});

/** Index of factory functions by HTML tag name */
const viewByTag = freeze(
  fromEntries(
    values(viewByName).map((factory) => [factory.tag, factory])
  )
);

export const getViewByTag = (tag: string) => viewByTag[tag];