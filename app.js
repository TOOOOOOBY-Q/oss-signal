const repoInput = document.querySelector("#repoInput");
const tokenInput = document.querySelector("#tokenInput");
const analyzeButton = document.querySelector("#analyzeButton");
const statusLine = document.querySelector("#statusLine");
const warningPanel = document.querySelector("#warningPanel");
const dashboard = document.querySelector("#dashboard");
const attentionScore = document.querySelector("#attentionScore");
const attentionLabel = document.querySelector("#attentionLabel");
const miniFacts = document.querySelector("#miniFacts");
const metricGrid = document.querySelector("#metricGrid");
const laneNow = document.querySelector("#laneNow");
const laneNext = document.querySelector("#laneNext");
const laneHealthy = document.querySelector("#laneHealthy");
const repoTitle = document.querySelector("#repoTitle");
const releaseSummary = document.querySelector("#releaseSummary");
const releaseTimeline = document.querySelector("#releaseTimeline");
const contributorBars = document.querySelector("#contributorBars");
const reportOutput = document.querySelector("#reportOutput");
const copyReportButton = document.querySelector("#copyReportButton");
const downloadReportButton = document.querySelector("#downloadReportButton");
const metricTemplate = document.querySelector("#metricTemplate");
const itemTemplate = document.querySelector("#itemTemplate");
const demoButtons = document.querySelectorAll("[data-demo]");
const workspaceNote = document.querySelector("#workspaceNote");

const TOKEN_KEY = "oss-signal-token";
const SAMPLE_LIMITS = {
  issues: 300,
  pulls: 300,
  contributors: 100,
  commits: 30,
};
const BACKLOG_SORT = {
  sort: "created",
  direction: "asc",
};

let activeRequestController = null;
let latestRequestId = 0;

const storage = createSafeSessionStorage();
const storedToken = storage?.getItem(TOKEN_KEY);
if (storedToken) {
  tokenInput.value = storedToken;
}

const repoFromUrl = readRepoFromUrl();
if (repoFromUrl) {
  repoInput.value = repoFromUrl;
}

demoButtons.forEach((button) => {
  button.addEventListener("click", () => {
    repoInput.value = button.dataset.demo ?? "";
    loadRepository();
  });
});

analyzeButton.addEventListener("click", () => {
  loadRepository();
});

repoInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadRepository();
  }
});

tokenInput.addEventListener("input", () => {
  const token = tokenInput.value.trim();
  if (!storage) {
    return;
  }

  if (token) {
    storage.setItem(TOKEN_KEY, token);
  } else {
    storage.removeItem(TOKEN_KEY);
  }
});

copyReportButton.addEventListener("click", async () => {
  if (!reportOutput.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(reportOutput.value);
    setStatus("Markdown copied to clipboard.");
  } catch {
    setStatus("Clipboard access failed. You can still copy from the textarea manually.");
  }
});

downloadReportButton.addEventListener("click", () => {
  if (!reportOutput.value) {
    return;
  }

  const repo = normalizeRepo(repoInput.value) ?? "repo";
  const blob = new Blob([reportOutput.value], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${repo.replace("/", "-")}-codex-draft.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Markdown draft downloaded.");
});

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
      }
    });
  },
  { threshold: 0.16 }
);

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

loadRepository();

function normalizeRepo(value) {
  const raw = value.trim();
  const isGitHubLocator =
    /^https?:\/\/github\.com\//i.test(raw) ||
    /^github\.com\//i.test(raw) ||
    /^git@github\.com:/i.test(raw);
  const normalized = raw
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 2) {
    if (isGitHubLocator && parts.length > 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  return `${parts[0]}/${parts[1]}`;
}

function readRepoFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return normalizeRepo(params.get("repo") ?? "");
}

function writeRepoToUrl(repo) {
  const url = new URL(window.location.href);
  url.searchParams.set("repo", repo);
  window.history.replaceState({}, "", url);
}

function createSafeSessionStorage() {
  try {
    const probeKey = "__oss_signal_probe__";
    window.sessionStorage.setItem(probeKey, "1");
    window.sessionStorage.removeItem(probeKey);
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function makeHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchJson(url, token, signal) {
  const response = await fetch(url, {
    headers: makeHeaders(token),
    signal,
  });

  if (!response.ok) {
    const payload = await safeJson(response);
    const message =
      payload?.message ??
      `GitHub API request failed with ${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  const bodyText = await response.text();
  return bodyText ? JSON.parse(bodyText) : null;
}

async function fetchOptionalJson(url, token, signal, fallback = []) {
  try {
    return {
      items: (await fetchJson(url, token, signal)) ?? fallback,
      warning: null,
      truncated: false,
      status: "complete",
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    return {
      items: fallback,
      warning: error instanceof Error ? error.message : "Unknown error.",
      truncated: false,
      status: "unavailable",
    };
  }
}

async function fetchPagedJson(
  url,
  token,
  { signal, maxItems, label, filterItem = () => true, query = {} }
) {
  const items = [];
  const collectionLimit = maxItems + 1;
  let page = 1;
  let truncated = false;

  while (items.length < collectionLimit) {
    const pageSize = 100;
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("per_page", String(pageSize));
    pageUrl.searchParams.set("page", String(page));
    Object.entries(query).forEach(([key, value]) => {
      if (value != null) {
        pageUrl.searchParams.set(key, String(value));
      }
    });

    let pageItems;
    try {
      pageItems = await fetchJson(pageUrl.toString(), token, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      return {
        items,
        warning: items.length
          ? `${label} partially loaded before GitHub returned an error: ${
              error instanceof Error ? error.message : "Unknown error."
            }`
          : `${label} could not be loaded: ${
              error instanceof Error ? error.message : "Unknown error."
            }`,
        truncated: false,
        status: items.length ? "partial" : "unavailable",
      };
    }

    if (!Array.isArray(pageItems)) {
      break;
    }

    const matchedItems = pageItems.filter(filterItem);
    items.push(...matchedItems);

    if (items.length > maxItems) {
      truncated = true;
      break;
    }

    if (pageItems.length < pageSize) {
      break;
    }

    page += 1;
  }

  return {
    items: items.slice(0, maxItems),
    warning: null,
    truncated,
    status: "complete",
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function loadRepository() {
  const repo = normalizeRepo(repoInput.value);
  const token = tokenInput.value.trim();
  const requestId = ++latestRequestId;

  if (!repo) {
    setStatus("Use the format owner/repo, for example openai/openai-python.");
    renderWarnings([]);
    dashboard.classList.add("hidden");
    return;
  }

  if (activeRequestController) {
    activeRequestController.abort();
  }
  activeRequestController = new AbortController();

  analyzeButton.disabled = true;
  analyzeButton.textContent = "Loading...";
  setStatus(`Pulling live GitHub data for ${repo}...`);

  try {
    const base = `https://api.github.com/repos/${repo}`;
    const signal = activeRequestController.signal;
    const repoData = await fetchJson(base, token, signal);
    const [issuesResult, pullsResult, releasesResult, contributorsResult, commitsResult] =
      await Promise.all([
        fetchPagedJson(`${base}/issues?state=open`, token, {
          signal,
          maxItems: SAMPLE_LIMITS.issues,
          label: "Open issues",
          filterItem: (item) => !item.pull_request,
          query: BACKLOG_SORT,
        }),
        fetchPagedJson(`${base}/pulls?state=open`, token, {
          signal,
          maxItems: SAMPLE_LIMITS.pulls,
          label: "Open pull requests",
          query: BACKLOG_SORT,
        }),
        fetchOptionalJson(`${base}/releases?per_page=12`, token, signal),
        fetchPagedJson(`${base}/contributors`, token, {
          signal,
          maxItems: SAMPLE_LIMITS.contributors,
          label: "Contributors",
        }),
        fetchOptionalJson(`${base}/commits?per_page=${SAMPLE_LIMITS.commits}`, token, signal),
      ]);

    if (requestId !== latestRequestId) {
      return;
    }

    const warnings = [
      issuesResult.warning,
      pullsResult.warning,
      releasesResult.warning ? `Releases unavailable: ${releasesResult.warning}` : null,
      contributorsResult.warning,
      commitsResult.warning ? `Recent commits unavailable: ${commitsResult.warning}` : null,
    ].filter(Boolean);

    const analysis = buildAnalysis({
      repo,
      repoData,
      issues: issuesResult.items,
      pulls: pullsResult.items,
      releases: releasesResult.items,
      contributors: contributorsResult.items,
      commits: commitsResult.items,
      warnings,
      sourceStatus: {
        issues: issuesResult.status,
        pulls: pullsResult.status,
        releases: releasesResult.status,
        contributors: contributorsResult.status,
        commits: commitsResult.status,
      },
      sampling: {
        issuesTruncated: issuesResult.truncated,
        pullsTruncated: pullsResult.truncated,
        contributorsTruncated: contributorsResult.truncated,
      },
    });

    renderAnalysis(analysis);
    writeRepoToUrl(repo);
    dashboard.classList.remove("hidden");
    setStatus(
      warnings.length
        ? `Live data loaded for ${repo} with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
        : `Live data loaded for ${repo}.`
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    if (requestId !== latestRequestId) {
      return;
    }

    dashboard.classList.add("hidden");
    renderWarnings([]);
    setStatus(
      `Could not load that repository. ${error instanceof Error ? error.message : "Unknown error."}`
    );
  } finally {
    if (requestId === latestRequestId) {
      analyzeButton.disabled = false;
      analyzeButton.textContent = "Analyze";
    }
  }
}

function buildAnalysis({
  repo,
  repoData,
  issues,
  pulls,
  releases,
  contributors,
  commits,
  warnings,
  sourceStatus,
  sampling,
}) {
  const now = new Date();
  const issueDataAvailable = sourceStatus.issues === "complete";
  const pullDataAvailable = sourceStatus.pulls === "complete";
  const backlogDataAvailable = issueDataAvailable && pullDataAvailable;
  const releaseDataAvailable = sourceStatus.releases === "complete";
  const contributorDataAvailable = sourceStatus.contributors === "complete";
  const commitDataAvailable = sourceStatus.commits === "complete";
  const lastCommitAt = commitDataAvailable
    ? commits[0]?.commit?.committer?.date ?? repoData.pushed_at
    : repoData.pushed_at;
  const openIssueAges = issueDataAvailable
    ? issues.map((issue) => ageInDays(issue.created_at, now))
    : [];
  const openPrAges = pullDataAvailable
    ? pulls.map((pull) => ageInDays(pull.created_at, now))
    : [];
  const staleIssues = issueDataAvailable
    ? issues.filter((issue) => ageInDays(issue.created_at, now) >= 30)
    : [];
  const silentIssues = issueDataAvailable
    ? issues.filter((issue) => issue.comments === 0 && ageInDays(issue.created_at, now) >= 7)
    : [];
  const stalledPulls = pullDataAvailable
    ? pulls.filter((pull) => ageInDays(pull.created_at, now) >= 14)
    : [];
  const averageIssueAge = average(openIssueAges);
  const averagePrAge = average(openPrAges);
  const releaseIntervals = releaseDataAvailable
    ? releases
        .slice(0, 6)
        .map((release) => release.published_at || release.created_at)
        .filter(Boolean)
        .map((date) => new Date(date))
        .sort((a, b) => b.getTime() - a.getTime())
        .reduce((intervals, current, index, array) => {
          if (index < array.length - 1) {
            intervals.push(diffInDays(array[index + 1], current));
          }
          return intervals;
        }, [])
    : [];

  const averageReleaseInterval = releaseDataAvailable ? average(releaseIntervals) : null;
  const daysSinceLastRelease = releaseDataAvailable
    ? releases[0]
      ? ageInDays(releases[0].published_at || releases[0].created_at, now)
      : null
    : null;
  const contributorTotal = contributorDataAvailable
    ? contributors.reduce((sum, contributor) => sum + contributor.contributions, 0)
    : null;
  const topContributorShare =
    contributorDataAvailable && contributorTotal
      ? (contributors[0]?.contributions ?? 0) / contributorTotal
      : null;
  const topThreeShare =
    contributorDataAvailable && contributorTotal
      ? contributors.slice(0, 3).reduce((sum, contributor) => sum + contributor.contributions, 0) /
        contributorTotal
      : null;

  const scoreParts = [];
  if (backlogDataAvailable) {
    scoreParts.push(
      staleIssues.length * 2.2,
      stalledPulls.length * 3.1,
      Math.min(silentIssues.length, 10)
    );

    if (releaseDataAvailable) {
      scoreParts.push(daysSinceLastRelease ? Math.min(daysSinceLastRelease / 3, 24) : 18);
    }

    if (contributorDataAvailable && topContributorShare !== null && topThreeShare !== null) {
      scoreParts.push(topContributorShare * 28, topThreeShare * 18);
    }
  }

  const score = backlogDataAvailable
    ? clamp(
        Math.round(scoreParts.reduce((sum, value) => sum + value, 0)),
        4,
        100
      )
    : null;

  const scoreLabel =
    !backlogDataAvailable
      ? "Backlog snapshot incomplete"
      : score >= 70
      ? "High maintainer pressure"
      : score >= 40
        ? "Watchlist pressure"
        : "Healthy operating range";

  const urgencyItems = backlogDataAvailable
    ? rankItems(
        [
          ...issues.map((issue) => ({
            kind: "Issue",
            title: issue.title,
            url: issue.html_url,
            age: ageInDays(issue.created_at, now),
            score: ageInDays(issue.created_at, now) * 1.2 + (issue.comments === 0 ? 8 : 0),
            detail: `${ageInDays(issue.created_at, now)}d open${issue.comments === 0 ? " | no replies" : ` | ${issue.comments} comments`}`,
          })),
          ...pulls.map((pull) => ({
            kind: "PR",
            title: pull.title,
            url: pull.html_url,
            age: ageInDays(pull.created_at, now),
            score: ageInDays(pull.created_at, now) * 1.5 + (pull.draft ? -4 : 6),
            detail: `${ageInDays(pull.created_at, now)}d open${pull.draft ? " | draft" : " | review needed"}`,
          })),
        ],
        8
      )
    : [];

  const triage = {
    now: urgencyItems.filter((item) => item.score >= 35).slice(0, 4),
    next: urgencyItems.filter((item) => item.score >= 18 && item.score < 35).slice(0, 4),
    healthy: urgencyItems.filter((item) => item.score < 18).slice(0, 4),
  };

  const releaseTone =
    !releaseDataAvailable
      ? "Release history was unavailable from GitHub for this snapshot, so cadence was excluded from the score."
      : daysSinceLastRelease == null
        ? "No tagged releases yet."
        : daysSinceLastRelease > 120
          ? `Last release landed ${daysSinceLastRelease} days ago, which suggests momentum may be bottlenecked.`
          : `Last release landed ${daysSinceLastRelease} days ago, which keeps the project in a believable shipping rhythm.`;

  const busFactorLabel =
    !contributorDataAvailable
      ? "Unavailable"
      : topContributorShare >= 0.6
        ? "High concentration"
        : topThreeShare >= 0.85
          ? "Medium concentration"
          : "Distributed ownership";

  const scoreLimitations = [];
  if (!backlogDataAvailable) {
    scoreLimitations.push("backlog pressure excluded because issues or pull requests were incomplete");
  }
  if (!releaseDataAvailable) {
    scoreLimitations.push("release cadence excluded");
  }
  if (!contributorDataAvailable) {
    scoreLimitations.push("contributor concentration excluded");
  }
  if (!commitDataAvailable) {
    scoreLimitations.push("recent commit history unavailable");
  }

  const ownerNote =
    !contributorDataAvailable
      ? "Contributor concentration could not be evaluated in this snapshot."
      : topContributorShare >= 0.6
        ? "Contributor ownership is highly concentrated, which increases maintainer fragility."
        : topThreeShare >= 0.85
          ? "A small core group still carries most of the shipping load."
          : "Ownership is meaningfully distributed across multiple contributors.";

  return {
    repo,
    repoData,
    snapshotAt: now.toISOString(),
    score,
    scoreLabel,
    backlogDataAvailable,
    issues,
    pulls,
    releases,
    contributors,
    commits,
    staleIssues,
    silentIssues,
    stalledPulls,
    averageIssueAge,
    averagePrAge,
    averageReleaseInterval,
    daysSinceLastRelease,
    lastCommitAt,
    topContributorShare,
    topThreeShare,
    contributorTotal,
    busFactorLabel,
    releaseTone,
    triage,
    warnings,
    sourceStatus,
    sampling,
    scoreLimitations,
    ownerNote,
  };
}

function renderAnalysis(analysis) {
  repoTitle.textContent = analysis.repo;
  attentionScore.textContent = analysis.score === null ? "N/A" : String(analysis.score);
  attentionLabel.textContent = analysis.scoreLabel;
  attentionLabel.className = `summary-copy ${
    analysis.score === null ? "tone-medium" : toneForScore(analysis.score)
  }`;

  miniFacts.innerHTML = `
    <div>Stars: ${formatInteger(analysis.repoData.stargazers_count)}</div>
    <div>Forks: ${formatInteger(analysis.repoData.forks_count)}</div>
    <div>${formatSnapshotCount("Issues", analysis.issues.length, analysis.sourceStatus.issues, analysis.sampling.issuesTruncated, "oldest open issues")}</div>
    <div>${formatSnapshotCount("PRs", analysis.pulls.length, analysis.sourceStatus.pulls, analysis.sampling.pullsTruncated, "oldest open PRs")}</div>
    <div>Last push: ${formatDate(analysis.lastCommitAt)}</div>
  `;

  renderMetrics(analysis);
  renderLane(
    laneNow,
    analysis.triage.now,
    analysis.backlogDataAvailable
      ? "No immediate blockers surfaced."
      : "Backlog lanes are unavailable because the issues or pull requests snapshot was incomplete."
  );
  renderLane(
    laneNext,
    analysis.triage.next,
    analysis.backlogDataAvailable
      ? "The backlog looks surprisingly under control."
      : "Scheduling guidance is withheld until GitHub returns a complete backlog snapshot."
  );
  renderLane(
    laneHealthy,
    analysis.triage.healthy,
    analysis.backlogDataAvailable
      ? "No low-urgency items were sampled."
      : "Healthy-flow suggestions are unavailable without complete backlog data."
  );
  renderReleaseSection(analysis);
  renderContributors(analysis);
  reportOutput.value = buildReportMarkdown(analysis);
  workspaceNote.textContent = buildWorkspaceNote(analysis);
  renderWarnings(buildWarningItems(analysis));

  document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
}

function renderWarnings(items) {
  if (!items.length) {
    warningPanel.innerHTML = "";
    warningPanel.classList.add("hidden");
    return;
  }

  warningPanel.innerHTML = `
    <strong>Snapshot caveats</strong>
    <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  `;
  warningPanel.classList.remove("hidden");
}

function buildWarningItems(analysis) {
  const items = [];

  if (analysis.sampling.issuesTruncated || analysis.sampling.pullsTruncated) {
    items.push(
      `Backlog metrics are sampled from the oldest ${SAMPLE_LIMITS.issues} open issues and oldest ${SAMPLE_LIMITS.pulls} open pull requests returned by GitHub.`
    );
  }

  if (analysis.scoreLimitations.length) {
    items.push(`The attention score excludes: ${analysis.scoreLimitations.join("; ")}.`);
  }

  items.push(...analysis.warnings);
  return items;
}

function renderMetrics(analysis) {
  const metrics = [
    {
      label: "Stale issues",
      value: analysis.sourceStatus.issues === "complete" ? analysis.staleIssues.length : "Unavailable",
      detail:
        analysis.sourceStatus.issues !== "complete"
          ? "Issue backlog data was incomplete, so stale-issue pressure is withheld."
          : analysis.staleIssues.length > 0
          ? `${Math.round(percentage(analysis.staleIssues.length, analysis.issues.length))}% of open issues are older than 30 days.`
          : "No stale issue pressure in the sampled window.",
    },
    {
      label: "Stalled PRs",
      value: analysis.sourceStatus.pulls === "complete" ? analysis.stalledPulls.length : "Unavailable",
      detail:
        analysis.sourceStatus.pulls !== "complete"
          ? "Pull request backlog data was incomplete, so stalled-PR pressure is withheld."
          : analysis.stalledPulls.length > 0
          ? `${Math.round(analysis.averagePrAge)} day average age across open PRs.`
          : "Open pull requests are still moving quickly.",
    },
    {
      label: "Release interval",
      value:
        analysis.sourceStatus.releases !== "complete"
          ? "Unavailable"
          : analysis.averageReleaseInterval
            ? `${Math.round(analysis.averageReleaseInterval)}d`
            : "N/A",
      detail:
        analysis.sourceStatus.releases !== "complete"
          ? "Release cadence data was unavailable from GitHub for this snapshot."
          : analysis.averageReleaseInterval
          ? "Average gap across the latest tagged releases."
          : "Not enough release history to estimate a cadence.",
    },
    {
      label: "Top contributor share",
      value:
        analysis.topContributorShare === null
          ? "Unavailable"
          : `${Math.round(analysis.topContributorShare * 100)}%`,
      detail:
        analysis.topContributorShare === null
          ? "Contributor concentration data was unavailable from GitHub for this snapshot."
          : `${analysis.busFactorLabel} across the sampled contributor set.`,
    },
    {
      label: "Issue age",
      value:
        analysis.sourceStatus.issues === "complete"
          ? `${Math.round(analysis.averageIssueAge || 0)}d`
          : "Unavailable",
      detail:
        analysis.sourceStatus.issues === "complete"
          ? "Average age of current open issues."
          : "Issue age is withheld until GitHub returns a complete issue snapshot.",
    },
    {
      label: "Silent issues",
      value: analysis.sourceStatus.issues === "complete" ? analysis.silentIssues.length : "Unavailable",
      detail:
        analysis.sourceStatus.issues === "complete"
          ? "Open for at least 7 days with zero comments."
          : "Silent-issue counts are withheld until the issue backlog fully loads.",
    },
    {
      label: "Last release",
      value:
        analysis.sourceStatus.releases !== "complete"
          ? "Unavailable"
          : analysis.daysSinceLastRelease == null
            ? "N/A"
            : `${analysis.daysSinceLastRelease}d`,
      detail:
        analysis.sourceStatus.releases !== "complete"
          ? "Release history was unavailable from GitHub for this snapshot."
          : "Days since the latest tagged release.",
    },
    {
      label: "Default branch",
      value: analysis.repoData.default_branch,
      detail: analysis.repoData.license?.spdx_id
        ? `License: ${analysis.repoData.license.spdx_id}`
        : "No license metadata returned by GitHub.",
    },
  ];

  metricGrid.innerHTML = "";
  metrics.forEach((metric) => {
    const fragment = metricTemplate.content.cloneNode(true);
    fragment.querySelector(".metric-label").textContent = metric.label;
    fragment.querySelector(".metric-value").textContent = String(metric.value);
    fragment.querySelector(".metric-detail").textContent = metric.detail;
    metricGrid.append(fragment);
  });
}

function renderLane(container, items, emptyMessage) {
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  items.forEach((item) => {
    const fragment = itemTemplate.content.cloneNode(true);
    const link = fragment.querySelector(".work-item");
    link.href = item.url;
    fragment.querySelector(".work-item-type").textContent = item.kind;
    fragment.querySelector(".work-item-title").textContent = item.title;
    fragment.querySelector(".work-item-meta").textContent = item.detail;
    container.append(fragment);
  });
}

function renderReleaseSection(analysis) {
  const summaryLines = [];
  summaryLines.push(analysis.releaseTone);

  if (analysis.averageReleaseInterval) {
    summaryLines.push(
      `The latest release interval averages ${Math.round(
        analysis.averageReleaseInterval
      )} days across the sampled history.`
    );
  }

  summaryLines.push(
    `The repository was last pushed on ${formatDate(
      analysis.lastCommitAt
    )}, which helps separate shipping delay from actual inactivity.`
  );

  releaseSummary.innerHTML = summaryLines.map((line) => `<p>${line}</p>`).join("");

  releaseTimeline.innerHTML = "";
  if (!analysis.releases.length) {
    releaseTimeline.innerHTML =
      analysis.sourceStatus.releases === "complete"
        ? `<div class="empty-state">No release history returned by GitHub.</div>`
        : `<div class="empty-state">Release history was unavailable for this snapshot.</div>`;
    return;
  }

  analysis.releases.slice(0, 6).forEach((release) => {
    const publishedAt = release.published_at || release.created_at;
    const wrapper = document.createElement("article");
    const summary = truncate(
      release.body?.replace(/\r?\n+/g, " ") || "Release notes not provided.",
      120
    );
    wrapper.className = "timeline-item";
    wrapper.innerHTML = `
      <div class="timeline-head">
        <strong>${escapeHtml(release.name || release.tag_name)}</strong>
        <span class="timeline-date">${formatDate(publishedAt)}</span>
      </div>
      <div class="copy-block">${escapeHtml(summary)}</div>
    `;
    releaseTimeline.append(wrapper);
  });
}

function renderContributors(analysis) {
  contributorBars.innerHTML = "";
  if (analysis.sourceStatus.contributors !== "complete") {
    contributorBars.innerHTML = `<div class="empty-state">Contributor data was unavailable for this snapshot.</div>`;
    return;
  }

  if (!analysis.contributors.length || !analysis.contributorTotal) {
    contributorBars.innerHTML = `<div class="empty-state">Contributor data is not available for this repository.</div>`;
    return;
  }

  analysis.contributors.slice(0, 8).forEach((contributor) => {
    const row = document.createElement("article");
    row.className = "bar-row";
    const share = percentage(contributor.contributions, analysis.contributorTotal);
    row.innerHTML = `
      <div class="bar-head">
        <strong>${escapeHtml(contributor.login)}</strong>
        <span class="bar-value">${Math.round(share)}% of recorded contributions</span>
      </div>
      <div class="bar-track" aria-hidden="true">
        <div class="bar-fill" style="width: ${share}%;"></div>
      </div>
    `;
    contributorBars.append(row);
  });
}

function buildReportMarkdown(analysis) {
  const samplingNote =
    !analysis.backlogDataAvailable
      ? "The backlog snapshot was incomplete from GitHub, so issue and pull-request pressure was excluded from this draft."
      : analysis.sampling.issuesTruncated || analysis.sampling.pullsTruncated
      ? `The backlog snapshot is sampled from the oldest ${SAMPLE_LIMITS.issues} open issues and oldest ${SAMPLE_LIMITS.pulls} open pull requests returned by GitHub for speed.`
      : "The backlog snapshot covers the currently returned open issues and pull requests from GitHub.";
  const demandLine =
    !analysis.backlogDataAvailable
      ? "GitHub did not return a complete issues and pull-requests view for this snapshot, so backlog demand should be verified before using this draft in an application."
      : analysis.sampling.issuesTruncated || analysis.sampling.pullsTruncated
      ? `The project shows active community demand, with a sampled snapshot of ${analysis.issues.length} oldest open issues and ${analysis.pulls.length} oldest open pull requests in the current view.`
      : `The project shows active community demand, with ${analysis.issues.length} open issues and ${analysis.pulls.length} open pull requests in the current snapshot.`;
  const limitationsLine = analysis.scoreLimitations.length
    ? `Score note: ${analysis.scoreLimitations.join("; ")}.`
    : null;
  const staleIssuesLine =
    analysis.sourceStatus.issues === "complete"
      ? `${analysis.staleIssues.length} open issues are older than 30 days.`
      : "Open-issue age pressure was excluded because the issue backlog did not fully load.";
  const silentIssuesLine =
    analysis.sourceStatus.issues === "complete"
      ? `${analysis.silentIssues.length} open issues have had no replies for at least 7 days.`
      : "Silent-issue counts were excluded because the issue backlog did not fully load.";
  const stalledPullsLine =
    analysis.sourceStatus.pulls === "complete"
      ? `${analysis.stalledPulls.length} open pull requests are older than 14 days.`
      : "Stalled pull-request counts were excluded because the PR backlog did not fully load.";
  const scoreLine =
    analysis.score === null
      ? "Overall attention score was withheld because the backlog snapshot was incomplete."
      : `Overall attention score: ${analysis.score}/100 (${analysis.scoreLabel}).`;

  return `# Codex for Open Source draft

Repository: ${analysis.repo}
Homepage: ${analysis.repoData.html_url}
Snapshot taken: ${formatDate(analysis.snapshotAt)}

## Why this repository matters

- ${analysis.repo} currently has ${formatInteger(analysis.repoData.stargazers_count)} stars and ${formatInteger(analysis.repoData.forks_count)} forks on GitHub.
- ${demandLine}
- The latest commit landed on ${formatDate(analysis.lastCommitAt)}.

## Maintainer pressure in the current snapshot

- ${staleIssuesLine}
- ${silentIssuesLine}
- ${stalledPullsLine}
- ${analysis.ownerNote}
- ${scoreLine}
- ${samplingNote}
${limitationsLine ? `- ${limitationsLine}` : ""}

## How Codex would help

- Triage issues faster by clustering bug reports, writing suggested labels, and drafting maintainers' first responses.
- Review pull requests with repository context, summarize risky changes, and propose targeted tests before merge.
- Draft release notes, changelog summaries, and follow-up tasks from merged PRs so releases do not bottleneck on writing overhead.
- Reduce response latency without increasing volunteer maintainer burnout.

## Suggested closing paragraph

I would use Codex to keep ${analysis.repo} responsive while preserving maintainer bandwidth. The current workload shows real review and backlog pressure, and AI assistance would be most valuable in triage, PR summarization, testing suggestions, and release preparation.

---

Generated by OSS Signal. Edit the language above so it reflects your actual maintainer role and repository context before submitting.`;
}

function buildWorkspaceNote(analysis) {
  const notes = [];

  notes.push(
    storage
      ? "Token stays in this tab only."
      : "This browser blocked session storage, so the token will only live in the current input field."
  );

  if (analysis.sampling.issuesTruncated || analysis.sampling.pullsTruncated) {
    notes.push(
      `Backlog view is sampled across the oldest ${SAMPLE_LIMITS.issues} open issues and oldest ${SAMPLE_LIMITS.pulls} open PRs for speed.`
    );
  } else {
    notes.push("Backlog view includes all currently returned open issues and PRs from GitHub.");
  }

  if (analysis.scoreLimitations.length) {
    notes.push(`Score note: ${analysis.scoreLimitations.join("; ")}.`);
  }

  if (analysis.warnings.length) {
    notes.push(`Warnings: ${analysis.warnings.join(" | ")}`);
  }

  return notes.join(" ");
}

function rankItems(items, count) {
  return items.sort((left, right) => right.score - left.score).slice(0, count);
}

function ageInDays(dateString, now = new Date()) {
  return diffInDays(new Date(dateString), now);
}

function diffInDays(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percentage(value, total) {
  if (!total) {
    return 0;
  }

  return (value / total) * 100;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function truncate(value, length) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1).trimEnd()}...`;
}

function toneForScore(score) {
  if (score >= 70) {
    return "tone-high";
  }
  if (score >= 40) {
    return "tone-medium";
  }
  return "tone-low";
}

function setStatus(message) {
  statusLine.textContent = message;
}

function formatSnapshotCount(label, count, status, truncated, sampledLabel) {
  if (status === "complete") {
    return `${truncated ? `Sampled ${sampledLabel}` : label}: ${count}`;
  }
  if (status === "partial") {
    return `${label}: ${count} loaded (partial)`;
  }
  return `${label}: unavailable`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
