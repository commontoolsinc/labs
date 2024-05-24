export function snapshot(state$) {
  return Object.keys(state$).reduce((acc, key) => {
    acc[key] = state$[key].getValue();
    return acc;
  }, {});
}
