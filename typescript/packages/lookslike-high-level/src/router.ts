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
  // Merge existing query params with new URL
  const newUrl = new URL(url, window.location.href);
  const currentParams = new URLSearchParams(window.location.search);
  const newParams = new URLSearchParams(newUrl.search);

  currentParams.forEach((value, key) => {
    if (!newParams.has(key)) {
      newParams.set(key, value);
    }
  });

  newUrl.search = newParams.toString();
  history.pushState(null, "", newUrl.toString());
}

window.addEventListener("popstate", () => {
  window.dispatchEvent(new CustomEvent("routeChange", { detail: window.location.pathname }));
});

window.addEventListener("pushState", () => {
  window.dispatchEvent(new CustomEvent("routeChange", { detail: window.location.pathname }));
});

window.addEventListener("replaceState", () => {
  window.dispatchEvent(new CustomEvent("routeChange", { detail: window.location.pathname }));
});

window.dispatchEvent(new CustomEvent("routeChange", { detail: window.location.pathname }));
