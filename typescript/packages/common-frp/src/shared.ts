export const config = {
  debug: false
}

export const debug = (...data: Array<any>) => {
  if (config.debug) {
    console.debug(...data)
  }
}
