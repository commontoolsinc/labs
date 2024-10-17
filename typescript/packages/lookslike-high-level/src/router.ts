export function matchRoute(urlPattern: string, url: URL) {
  const path = decodeURIComponent(url.pathname);
  const pattern = new RegExp("^" + urlPattern.replace(/:\w+/g, "(.+)") + "$");
  const match = path.match(pattern);
  if (match) {
    const params: Record<string, string> = {};
    const keys = urlPattern.match(/:\w+/g) || [];
    keys.forEach((key, index) => {
      params[key.slice(1)] = match[index + 1];
    });
    return { params, pathname: path };
  }
  return null;
}

export function navigate(url: string) {
  history.pushState(null, "", url);
}

window.addEventListener("popstate", () => {
  window.dispatchEvent(
    new CustomEvent("routeChange", { detail: window.location.pathname }),
  );
});

window.addEventListener("pushState", () => {
  window.dispatchEvent(
    new CustomEvent("routeChange", { detail: window.location.pathname }),
  );
});

window.addEventListener("replaceState", () => {
  window.dispatchEvent(
    new CustomEvent("routeChange", { detail: window.location.pathname }),
  );
});

window.dispatchEvent(
  new CustomEvent("routeChange", { detail: window.location.pathname }),
);
