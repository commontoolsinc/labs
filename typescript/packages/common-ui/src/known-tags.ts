/** Whitelisted component tags */
const KNOWN_TAGS = new Set([
  'com-navpanel',
  'com-navstack',
  'com-hstack',
  'com-vstack',
])

export const knownTags = () => KNOWN_TAGS.values()
export default knownTags

export const isKnownTags = (tag: string) => KNOWN_TAGS.has(tag)