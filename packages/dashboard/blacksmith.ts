type Environment = (name: string) => string | undefined;

const DEFAULT_API_URL = "https://backend.blacksmith.sh";

function apiURL(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("BLACKSMITH_API_URL is not a valid URL");
  }
  const localHTTP = parsed.protocol === "http:" &&
    parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !localHTTP) {
    throw new Error("BLACKSMITH_API_URL must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export class BlacksmithClient {
  private constructor(
    private readonly token: string,
    private readonly baseURL: string,
  ) {}

  static fromEnvironment(env: Environment): BlacksmithClient | null {
    const token = env("BLACKSMITH_API_TOKEN")?.trim();
    if (!token) return null;
    return new BlacksmithClient(token, apiURL(env("BLACKSMITH_API_URL")));
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(
      `${this.baseURL}/api/${path.replace(/^\/+/, "")}`,
      {
        headers: {
          accept: "application/json, text/plain, */*",
          authorization: `Bearer ${this.token}`,
        },
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new Error("Blacksmith API token rejected");
    }
    if (!response.ok) {
      throw new Error(`Blacksmith billing failed: HTTP ${response.status}`);
    }
    return await response.json() as T;
  }
}

const orgPath = (org: string) => `user/github/orgs/${encodeURIComponent(org)}`;

function rangeQuery(start: Date, end: Date): string {
  const query = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
  });
  return query.toString();
}

export const blacksmithRoutes = {
  daily: (org: string, start: Date, end: Date) =>
    `${orgPath(org)}/metrics/daily?${rangeQuery(start, end)}`,
  stickyDaily: (org: string, start: Date, end: Date) =>
    `${orgPath(org)}/metrics/docker/daily-by-type?${rangeQuery(start, end)}`,
  stickyTotal: (org: string, start: Date, end: Date) =>
    `${orgPath(org)}/metrics/docker/sticky-disk/total?${
      rangeQuery(start, end)
    }`,
  invoiceAmount: (org: string) => `${orgPath(org)}/metrics/invoice-amount`,
  spendingThreshold: (org: string) => `${orgPath(org)}/email-alert-threshold`,
};
