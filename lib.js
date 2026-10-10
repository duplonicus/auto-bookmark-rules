// Pure rule logic shared by the service worker, the options page, the popup
// and the node tests. Nothing in here touches chrome.* directly: the bookmark
// functions take the bookmarks API as an argument so tests can pass a fake.

export const MATCH_TYPES = ['prefix', 'domain', 'contains', 'regex'];
export const TITLE_MODES = ['title', 'url', 'template'];
export const MAX_COOLDOWN_SEC = 3600;
export const ALL_SITES = '*://*/*';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function newId() {
  return crypto.randomUUID();
}

const str = (v, fallback) => (typeof v === 'string' ? v : fallback);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

// Coerces anything (a stored rule, an imported one, a partial override) into a
// complete rule object. Unknown fields are dropped.
export function sanitizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const cooldown = Number(r.cooldownSec);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    name: str(r.name, '').trim() || 'Untitled rule',
    enabled: r.enabled !== false,
    matchType: pick(r.matchType, MATCH_TYPES, 'prefix'),
    pattern: str(r.pattern, ''),
    excludeType: pick(r.excludeType, MATCH_TYPES, 'contains'),
    excludePattern: str(r.excludePattern, ''),
    sites: str(r.sites, ''),
    folder: str(r.folder, 'Bookmarks bar/Auto Bookmarks'),
    titleMode: pick(r.titleMode, TITLE_MODES, 'title'),
    titleTemplate: str(r.titleTemplate, '{title}'),
    stripHash: r.stripHash !== false,
    stripQuery: r.stripQuery !== false,
    cooldownSec: Number.isFinite(cooldown) ? Math.min(Math.max(cooldown, 0), MAX_COOLDOWN_SEC) : 3,
  };
}

export function presetClaudeArtifacts() {
  return sanitizeRule({
    name: 'Claude Artifacts',
    // Artifacts live at /artifact/<id> and at /code/artifact/<id>.
    matchType: 'regex',
    pattern: '^https://claude\\.ai/(code/)?artifact/',
    sites: 'claude.ai',
    folder: 'Bookmarks bar/Claude Artifacts',
  });
}

export function isHttpUrl(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

// "https://Example.com:8080/path" -> "example.com"
export function normalizeDomain(pattern) {
  return String(pattern)
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d*$/, '')
    .replace(/^\*?\.+/, '');
}

export function parseSites(sites) {
  return String(sites || '')
    .split(/[\s,]+/)
    .map(normalizeDomain)
    .filter(Boolean);
}

export function regexError(pattern) {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e.message;
  }
}

// True when `url` matches `pattern` under `type`. An empty pattern or a broken
// regex matches nothing.
export function testPattern(type, pattern, url) {
  if (!pattern) return false;
  switch (type) {
    case 'prefix':
      return url.startsWith(pattern);
    case 'contains':
      return url.includes(pattern);
    case 'domain': {
      const domain = normalizeDomain(pattern);
      if (!domain) return false;
      let host;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return false;
      }
      return host === domain || host.endsWith('.' + domain);
    }
    case 'regex':
      try {
        return new RegExp(pattern).test(url);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function normalizeUrl(url, rule) {
  const u = new URL(url);
  if (rule.stripHash) u.hash = '';
  if (rule.stripQuery) u.search = '';
  return u.href;
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// `page` is {title, url}; `url` is the already-normalized bookmark URL.
export function buildTitle(rule, page, url, now = new Date()) {
  const pageTitle = (page.title || '').trim() || url;
  let out;
  if (rule.titleMode === 'url') {
    out = url;
  } else if (rule.titleMode === 'template') {
    const values = { title: pageTitle, host: new URL(url).hostname, date: localDate(now), url };
    out = rule.titleTemplate.replace(/\{(title|host|date|url)\}/g, (_, k) => values[k]);
  } else {
    out = pageTitle;
  }
  return out.trim() || url;
}

// Returns {field: message} for everything wrong with a rule. Empty = valid.
export function validateRule(rule) {
  const errors = {};
  if (!rule.pattern.trim()) {
    errors.pattern = 'Pattern is required.';
  } else if (rule.matchType === 'regex') {
    const e = regexError(rule.pattern);
    if (e) errors.pattern = e;
  } else if (rule.matchType === 'prefix' && !/^https?:\/\//i.test(rule.pattern)) {
    errors.pattern = 'A prefix must start with http:// or https:// (rules only apply to web pages).';
  } else if (rule.matchType === 'domain' && !DOMAIN_RE.test(normalizeDomain(rule.pattern))) {
    errors.pattern = 'Enter a domain such as example.com.';
  }
  if (rule.excludePattern) {
    if (rule.excludeType === 'regex') {
      const e = regexError(rule.excludePattern);
      if (e) errors.excludePattern = e;
    } else if (rule.excludeType === 'domain' && !DOMAIN_RE.test(normalizeDomain(rule.excludePattern))) {
      errors.excludePattern = 'Enter a domain such as example.com.';
    }
  }
  const bad = parseSites(rule.sites).find((d) => !DOMAIN_RE.test(d));
  if (bad) errors.sites = `"${bad}" is not a domain.`;
  if (!parseFolderPath(rule.folder).length) errors.folder = 'Folder path is required.';
  if (rule.titleMode === 'template' && !rule.titleTemplate.trim()) {
    errors.titleTemplate = 'Template is required.';
  }
  if (!Number.isFinite(rule.cooldownSec) || rule.cooldownSec < 0 || rule.cooldownSec > MAX_COOLDOWN_SEC) {
    errors.cooldownSec = `Cooldown must be between 0 and ${MAX_COOLDOWN_SEC} seconds.`;
  }
  return errors;
}

// What a rule would do with a page, without touching bookmarks.
// -> {match: true, url, title} or {match: false, reason}
// reason: 'not-http' | 'invalid' | 'no-match' | 'excluded'
export function evaluateRule(rule, page, now = new Date()) {
  if (!isHttpUrl(page.url)) return { match: false, reason: 'not-http' };
  if (rule.matchType === 'regex' && regexError(rule.pattern)) return { match: false, reason: 'invalid' };
  if (!testPattern(rule.matchType, rule.pattern, page.url)) return { match: false, reason: 'no-match' };
  if (rule.excludePattern && testPattern(rule.excludeType, rule.excludePattern, page.url)) {
    return { match: false, reason: 'excluded' };
  }
  const url = normalizeUrl(page.url, rule);
  return { match: true, url, title: buildTitle(rule, page, url, now) };
}

// ---- host permissions -------------------------------------------------------

// The match patterns a rule needs access to. Derived from the pattern where
// that is possible (prefix with a full host, domain); otherwise from the rule's
// "sites" list; otherwise every site.
export function originsForRule(rule) {
  if (rule.matchType === 'domain') {
    const d = normalizeDomain(rule.pattern);
    if (DOMAIN_RE.test(d)) return [`*://*.${d}/*`];
  }
  if (rule.matchType === 'prefix') {
    // Only when the host part is complete, i.e. the prefix reaches the first "/".
    const m = /^(https?):\/\/([^/?#]+)\//i.exec(rule.pattern);
    if (m) {
      const host = normalizeDomain(m[2].replace(/^.*@/, ''));
      if (DOMAIN_RE.test(host)) return [`${m[1].toLowerCase()}://${host}/*`];
    }
  }
  const sites = parseSites(rule.sites).filter((d) => DOMAIN_RE.test(d));
  if (sites.length) return sites.map((d) => `*://*.${d}/*`);
  return [ALL_SITES];
}

export function canDeriveOrigins(rule) {
  return originsForRule({ ...rule, sites: '' })[0] !== ALL_SITES;
}

// The pattern to check with chrome.permissions.contains for one page.
export function originPatternForUrl(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

// ---- bookmarks --------------------------------------------------------------

export function parseFolderPath(path) {
  return String(path || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Names people type for the two built-in folders, whatever the browser's own
// label or language is.
const ROOT_ALIASES = {
  'bookmarks-bar': ['bookmarks bar', 'bookmark bar', 'bookmarks toolbar', 'bookmarks', 'favorites bar'],
  other: ['other bookmarks', 'other', 'other favorites'],
};
const ROOT_IDS = { 'bookmarks-bar': '1', other: '2' };

function findRoot(roots, kind) {
  return roots.find((n) => n.folderType === kind) || roots.find((n) => n.id === ROOT_IDS[kind]);
}

// Finds the folder a path points at, creating missing folders when `create` is
// set. The first segment names a built-in folder ("Bookmarks bar", "Other
// bookmarks"); a path that does not start with one goes under Other bookmarks.
// -> the folder node, or null when it does not exist and create is false.
export async function resolveFolder(bookmarks, path, create) {
  const segments = parseFolderPath(path);
  if (!segments.length) throw new Error('Folder path is empty.');
  const roots = (await bookmarks.getTree())[0].children || [];
  const first = segments[0].toLowerCase();
  let parent = roots.find((n) => n.title.toLowerCase() === first);
  if (!parent) {
    const kind = Object.keys(ROOT_ALIASES).find((k) => ROOT_ALIASES[k].includes(first));
    if (kind) parent = findRoot(roots, kind);
  }
  let rest = segments.slice(1);
  if (!parent) {
    parent = findRoot(roots, 'other') || roots[0];
    rest = segments;
  }
  if (!parent) throw new Error('No bookmark folders found.');
  for (const name of rest) {
    const children = await bookmarks.getChildren(parent.id);
    let next = children.find((n) => !n.url && n.title === name);
    if (!next) {
      if (!create) return null;
      next = await bookmarks.create({ parentId: parent.id, title: name });
    }
    parent = next;
  }
  return parent;
}

// Every existing bookmark folder as a path resolveFolder understands, in tree
// order. A folder with "/" in its name (or no name) cannot be written as a
// path, so it and everything under it are left out.
export async function listFolderPaths(bookmarks) {
  const paths = [];
  const walk = (node, prefix) => {
    if (node.url || !node.title.trim() || node.title.includes('/')) return;
    const path = prefix ? `${prefix}/${node.title.trim()}` : node.title.trim();
    if (!paths.includes(path)) paths.push(path);
    for (const child of node.children || []) walk(child, path);
  };
  for (const root of (await bookmarks.getTree())[0].children || []) walk(root, '');
  return paths;
}

// Applies one rule to one page.
// -> {status: 'no-match', reason}
//    {status: 'exists', url, folderId}                      already in the target folder
//    {status: 'created', url, title, folderId, id, elsewhere}  elsewhere = it was
//        already bookmarked in some other folder
export async function bookmarkForRule(bookmarks, rule, page, now = new Date()) {
  const ev = evaluateRule(rule, page, now);
  if (!ev.match) return { status: 'no-match', reason: ev.reason };
  const folder = await resolveFolder(bookmarks, rule.folder, true);
  const existing = await bookmarks.search({ url: ev.url });
  if (existing.some((n) => n.parentId === folder.id)) {
    return { status: 'exists', url: ev.url, folderId: folder.id };
  }
  const node = await bookmarks.create({ parentId: folder.id, title: ev.title, url: ev.url });
  return {
    status: 'created',
    url: ev.url,
    title: ev.title,
    folderId: folder.id,
    id: node.id,
    elsewhere: existing.length > 0,
  };
}

// ---- cooldown ---------------------------------------------------------------

export function cooldownKey(ruleId, url) {
  return `${ruleId}|${url}`;
}

export function inCooldown(map, key, cooldownSec, now) {
  const t = map[key];
  return cooldownSec > 0 && typeof t === 'number' && now >= t && now - t < cooldownSec * 1000;
}

export function pruneCooldowns(map, now, maxAgeMs = MAX_COOLDOWN_SEC * 1000) {
  const out = {};
  for (const [k, t] of Object.entries(map)) {
    if (typeof t === 'number' && now - t < maxAgeMs && now >= t) out[k] = t;
  }
  return out;
}
