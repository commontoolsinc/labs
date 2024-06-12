import { View } from './view.js';

const registry = () => {
  const viewByName = new Map<string, View>();
  const viewByTag = new Map<string, View>();

  const getViewByTag = (tag: string) => viewByTag.get(tag);
  const getViewByName = (name: string) => viewByName.get(name);

  const register = (view: View) => {
    viewByName.set(view.name, view);
    viewByTag.set(view.tag, view);
  }

  return {getViewByTag, getViewByName, register};
}

export const {getViewByTag, getViewByName, register} = registry();