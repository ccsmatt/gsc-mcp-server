import { GSCClient } from "./gsc-client.js";
import type { SearchAnalyticsRow } from "./gsc-client.js";

export interface PageOverviewOptions {
  siteUrl: string;
  startDate: string;
  endDate: string;
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  minImpressions: number;
  standaloneMaxDepth: number;
  maxStandalone: number;
  maxGroups: number;
  includePathRegex?: string;
  excludePathRegex?: string;
  maxRows: number;
}

// Utility / non-service paths that are rarely useful when hunting for
// service pages. Overridable via excludePathRegex (pass "" to exclude nothing).
const DEFAULT_EXCLUDE =
  "^/(blog|category|tag|author|page|wp-content|wp-json|feed)(/|$)" +
  "|^/(privacy|terms|ada-standards|contact|about|reviews|careers|faqs?|" +
  "request-a-quote|quote|coupon|gallery|testimonials)[^/]*/?$";

const PAGE_SIZE = 25000; // Search Console API max rows per request

interface Agg {
  host: string;
  path: string;
  clicks: number;
  impressions: number;
  posWeighted: number; // sum(position * impressions)
}

function normalize(
  rawUrl: string,
  basePath: string
): { host: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  let path = u.pathname || "/";
  // For URL-prefix properties like https://example.com/raleigh/, make paths
  // relative to the property so depth is counted from the property root.
  if (basePath !== "/" && path.startsWith(basePath)) {
    path = "/" + path.slice(basePath.length);
  }
  if (!path.startsWith("/")) path = "/" + path;
  // Consistent trailing slash for page-like paths (not files such as .pdf)
  if (!/\.[a-z0-9]{2,5}$/i.test(path) && !path.endsWith("/")) path += "/";
  return { host: u.hostname, path };
}

function round(n: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export async function buildPageOverview(
  client: GSCClient,
  opts: PageOverviewOptions
) {
  const include = opts.includePathRegex
    ? new RegExp(opts.includePathRegex, "i")
    : null;
  const excludeSrc =
    opts.excludePathRegex === undefined
      ? DEFAULT_EXCLUDE
      : opts.excludePathRegex;
  const exclude = excludeSrc ? new RegExp(excludeSrc, "i") : null;

  let basePath = "/";
  if (/^https?:\/\//i.test(opts.siteUrl)) {
    try {
      basePath = new URL(opts.siteUrl).pathname || "/";
    } catch {
      basePath = "/";
    }
  }

  // 1. Fetch every page row (paginated) up to maxRows.
  const rows: SearchAnalyticsRow[] = [];
  let startRow = 0;
  let truncated = false;
  while (true) {
    const batch = await client.querySearchAnalytics({
      siteUrl: opts.siteUrl,
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: ["page"],
      type: opts.type,
      rowLimit: PAGE_SIZE,
      startRow,
    });
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (rows.length >= opts.maxRows) {
      truncated = true;
      break;
    }
    startRow += PAGE_SIZE;
  }

  // 2. Normalize URLs (strip query strings/hashes, e.g. ?utm_source=gbp) and
  //    merge duplicates, weighting position by impressions.
  const pages = new Map<string, Agg>();
  const hosts = new Set<string>();
  let totalImpressions = 0;
  for (const row of rows) {
    const n = normalize(row.keys[0] ?? "", basePath);
    if (!n) continue;
    totalImpressions += row.impressions;
    hosts.add(n.host);
    const key = n.host + n.path;
    const existing = pages.get(key);
    if (existing) {
      existing.clicks += row.clicks;
      existing.impressions += row.impressions;
      existing.posWeighted += row.position * row.impressions;
    } else {
      pages.set(key, {
        host: n.host,
        path: n.path,
        clicks: row.clicks,
        impressions: row.impressions,
        posWeighted: row.position * row.impressions,
      });
    }
  }
  const multiHost = hosts.size > 1;
  const label = (a: { host: string; path: string }) =>
    multiHost ? a.host + a.path : a.path;

  // 3. Split into standalone pages vs grouped (deeper) pages.
  const standalone: Agg[] = [];
  const groups = new Map<
    string,
    {
      pages: number;
      clicks: number;
      impressions: number;
      posWeighted: number;
      top: { path: string; impressions: number }[];
    }
  >();

  for (const a of pages.values()) {
    if (include && !include.test(a.path)) continue;
    if (exclude && exclude.test(a.path)) continue;

    const segments = a.path.split("/").filter(Boolean);
    if (segments.length <= opts.standaloneMaxDepth) {
      standalone.push(a);
    } else {
      const prefix = (multiHost ? a.host : "") + "/" + segments[0] + "/";
      let g = groups.get(prefix);
      if (!g) {
        g = { pages: 0, clicks: 0, impressions: 0, posWeighted: 0, top: [] };
        groups.set(prefix, g);
      }
      g.pages += 1;
      g.clicks += a.clicks;
      g.impressions += a.impressions;
      g.posWeighted += a.posWeighted;
      g.top.push({ path: a.path, impressions: a.impressions });
    }
  }

  const standaloneOut = standalone
    .filter((a) => a.impressions >= opts.minImpressions)
    .sort((x, y) => y.impressions - x.impressions)
    .slice(0, opts.maxStandalone)
    .map((a) => [
      label(a),
      a.impressions,
      a.clicks,
      round(a.posWeighted / a.impressions),
    ]);

  const groupsOut = [...groups.entries()]
    .sort((x, y) => y[1].impressions - x[1].impressions)
    .slice(0, opts.maxGroups)
    .map(([prefix, g]) => [
      prefix,
      g.pages,
      g.impressions,
      g.clicks,
      g.impressions > 0 ? round(g.posWeighted / g.impressions) : 0,
      g.top
        .sort((x, y) => y.impressions - x.impressions)
        .slice(0, 3)
        .map((t) => `${t.path} (${t.impressions})`),
    ]);

  return {
    summary: {
      siteUrl: opts.siteUrl,
      period: `${opts.startDate} to ${opts.endDate}`,
      rowsFetched: rows.length,
      uniquePages: pages.size,
      totalImpressions,
      truncated,
      standaloneMaxDepth: opts.standaloneMaxDepth,
      minImpressions: opts.minImpressions,
    },
    standaloneColumns: ["path", "impressions", "clicks", "avgPosition"],
    standalone: standaloneOut,
    groupColumns: [
      "prefix",
      "pagesWithImpressions",
      "impressions",
      "clicks",
      "avgPosition",
      "topPages",
    ],
    groups: groupsOut,
    note:
      "Only pages with at least one impression appear. A page with zero impressions " +
      "may exist but will not be listed. Query strings are merged into the base URL.",
  };
}
