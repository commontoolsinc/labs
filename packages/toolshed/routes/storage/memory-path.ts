import * as Path from "@std/path";

export const resolveMemoryV2StoreRootUrl = (storeUrl: URL): URL => {
  const storePath = Path.fromFileUrl(storeUrl);
  const rootPath = Path.extname(storePath) === ""
    ? Path.join(storePath, "v2-engine")
    : Path.join(
      Path.dirname(storePath),
      `${Path.basename(storePath, Path.extname(storePath))}.v2-engine`,
    );
  return Path.toFileUrl(`${rootPath}/`);
};
