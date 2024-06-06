export const config = {
  debug: false
}

export const debug = (tag: string, msg: string) => {
  if (config.debug) {
    console.debug(tag, msg)
  }
}
