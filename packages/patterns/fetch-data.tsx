/// <cts-enable />
import {
  cell,
  derive,
  fetchData,
  h,
  handler,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "commontools";

const model = schema({
  type: "object",
  properties: {
    repoUrl: {
      type: "string",
      default: "https://github.com/vercel/next.js",
      asCell: true,
    },
  },
  default: { repoUrl: "https://github.com/vercel/next.js" },
});

const updateUrl = handler(
  {
    type: "object",
    properties: {
      detail: { type: "object", properties: { value: { type: "string" } } },
    },
  },
  model,
  (event, state) => {
    if (event.detail?.value) {
      state.repoUrl.set(event.detail.value);
    }
  },
);

type GithubResponse = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    user_view_type: string;
    site_admin: boolean;
  };
  html_url: string;
  description: string;
  fork: boolean;
  url: string;
  forks_url: string;
  keys_url: string;
  collaborators_url: string;
  teams_url: string;
  hooks_url: string;
  issue_events_url: string;
  events_url: string;
  assignees_url: string;
  branches_url: string;
  tags_url: string;
  blobs_url: string;
  git_tags_url: string;
  git_refs_url: string;
  trees_url: string;
  statuses_url: string;
  languages_url: string;
  stargazers_url: string;
  contributors_url: string;
  subscribers_url: string;
  subscription_url: string;
  commits_url: string;
  git_commits_url: string;
  comments_url: string;
  issue_comment_url: string;
  contents_url: string;
  compare_url: string;
  merges_url: string;
  archive_url: string;
  downloads_url: string;
  issues_url: string;
  pulls_url: string;
  milestones_url: string;
  notifications_url: string;
  labels_url: string;
  releases_url: string;
  deployments_url: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  git_url: string;
  ssh_url: string;
  clone_url: string;
  svn_url: string;
  homepage: string;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string;
  has_issues: boolean;
  has_projects: boolean;
  has_downloads: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  has_discussions: boolean;
  forks_count: number;
  mirror_url: string | null;
  archived: boolean;
  disabled: boolean;
  open_issues_count: number;
  license: {
    key: string;
    name: string;
    spdx_id: string;
    url: string;
    node_id: string;
  };
  allow_forking: boolean;
  is_template: boolean;
  web_commit_signoff_required: boolean;
  topics: string[];
  visibility: string;
  forks: number;
  open_issues: number;
  watchers: number;
  default_branch: string;
  temp_clone_token: string | null;
  custom_properties: Record<string, any>;
  organization: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    user_view_type: string;
    site_admin: boolean;
  };
  network_count: number;
  subscribers_count: number;
};

export default recipe(model, {}, (state) => {
  // Parse URL and create API endpoint
  const apiUrl = derive({ url: state.repoUrl }, ({ url }) => {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (match) {
      return `https://api.github.com/repos/${match[1]}/${match[2]}`;
    }
    return "";
  });

  // Fetch repository data
  const repoData = fetchData<GithubResponse>({
    url: apiUrl,
    mode: "json",
  });
  const data = repoData.result;

  const validData = derive(data, (data) => {
    console.log("[DATA]", data);
    return (
      data ?? {
        name: "Unknown",
        owner: { login: "Unknown" },
        description: "No description provided",
        stargazers_count: 0,
        forks_count: 0,
        watchers_count: 0,
        open_issues_count: 0,
        network_count: 0,
        subscribers_count: 0,
      }
    );
  });

  return {
    [NAME]: "GitHub Repository Details",
    [UI]: (
      <div style="margin: 0 auto;">
        <div style="margin-bottom: 8px;">
          <ct-input
            $value={state.repoUrl}
            placeholder="https://github.com/owner/repo"
            customStyle="width: 100%; padding: 8px; font-size: 14px;"
          />
        </div>

        <div style="background: #f5f5f5; border: 1px solid #ddd; padding: 8px; border-radius: 4px;">
          <h3 id="github-title" style="margin: 0 0 8px 0; font-size: 20px;">
            {validData.name}
          </h3>
          <p style="margin: 0 0 8px 0; color: #666;">
            by {validData.owner.login}
          </p>
          <p style="margin: 0 0 16px 0;">{validData.description}</p>
          <div style="display: flex; gap: 8px; font-size: 14px;">
            <div>
              <span style="margin-right: 5px;">⭐</span>
              <strong>{validData.stargazers_count}</strong> stars
            </div>
            <div>
              <span style="margin-right: 5px;">🍴</span>
              <strong>{validData.forks_count}</strong> forks
            </div>
            <div>
              <span style="margin-right: 5px;">🔤</span>
              <strong>{validData.language}</strong>
            </div>
            <div>
              <a
                href={validData.html_url}
                target="_blank"
                style="color: #0366d6; text-decoration: none;"
              >
                View on GitHub →
              </a>
            </div>
          </div>
        </div>
      </div>
    ),
    repo: validData,
  };
});
