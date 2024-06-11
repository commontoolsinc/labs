/**
 * Whitelisted component tags map.
 * Maps tag name to factory name.
 */
export const KNOWN_TAGS = Object.freeze({
  'com-navpanel': 'navpanel',
  'com-navstack': 'navstack',
  'com-hstack': 'hstack',
  'com-vstack': 'vstack',
})

export const isKnownTag = (tag: string) => Object.hasOwn(KNOWN_TAGS, tag)