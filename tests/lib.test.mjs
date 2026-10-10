import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeRule,
  presetClaudeArtifacts,
  validateRule,
  testPattern,
  normalizeUrl,
  normalizeDomain,
  buildTitle,
  evaluateRule,
  originsForRule,
  originPatternForUrl,
  parseFolderPath,
  resolveFolder,
  listFolderPaths,
  bookmarkForRule,
  cooldownKey,
  inCooldown,
  pruneCooldowns,
  ALL_SITES,
} from '../lib.js';
import { fakeBookmarks } from './fakes.mjs';

const rule = (over) => sanitizeRule({ id: 'r1', name: 'Test', ...over });
const NOON = new Date(2026, 9, 10, 12, 0, 0);

// ---- match types ------------------------------------------------------------

test('prefix: matches from the start of the URL only', () => {
  const p = 'https://claude.ai/artifact/';
  assert.equal(testPattern('prefix', p, 'https://claude.ai/artifact/abc123'), true);
  assert.equal(testPattern('prefix', p, 'https://claude.ai/artifact/'), true);
  assert.equal(testPattern('prefix', p, 'https://claude.ai/chat/abc'), false);
  assert.equal(testPattern('prefix', p, 'http://claude.ai/artifact/abc'), false);
  assert.equal(testPattern('prefix', p, 'https://evil.example/?u=https://claude.ai/artifact/abc'), false);
});

test('domain: matches the host and its subdomains, nothing that merely ends the same', () => {
  assert.equal(testPattern('domain', 'example.com', 'https://example.com/a'), true);
  assert.equal(testPattern('domain', 'example.com', 'http://docs.example.com/a?b=1'), true);
  assert.equal(testPattern('domain', 'example.com', 'https://a.b.example.com:8443/'), true);
  assert.equal(testPattern('domain', 'example.com', 'https://notexample.com/'), false);
  assert.equal(testPattern('domain', 'example.com', 'https://example.com.evil.net/'), false);
  assert.equal(testPattern('domain', 'example.com', 'https://other.org/example.com'), false);
});

test('domain: tolerates how people type a domain', () => {
  for (const typed of ['Example.COM', 'https://example.com/', '*.example.com', '.example.com', 'example.com:8080', ' example.com ']) {
    assert.equal(normalizeDomain(typed), 'example.com', typed);
    assert.equal(testPattern('domain', typed, 'https://www.example.com/x'), true, typed);
  }
});

test('contains: substring anywhere in the URL, case-sensitive', () => {
  assert.equal(testPattern('contains', '/pull/', 'https://github.com/a/b/pull/12'), true);
  assert.equal(testPattern('contains', 'tab=readme', 'https://github.com/a/b?tab=readme'), true);
  assert.equal(testPattern('contains', '/pull/', 'https://github.com/a/b/issues/12'), false);
  assert.equal(testPattern('contains', '/Pull/', 'https://github.com/a/b/pull/12'), false);
});

test('regex: tested against the full URL', () => {
  const p = '^https://claude\\.ai/(code/)?artifact/[\\w-]+$';
  assert.equal(testPattern('regex', p, 'https://claude.ai/artifact/AbCdEfGhIjKlMnOpQrStUv'), true);
  assert.equal(testPattern('regex', p, 'https://claude.ai/code/artifact/0a1b2c3d-1111-2222'), true);
  assert.equal(testPattern('regex', p, 'https://claude.ai/artifact/'), false);
  assert.equal(testPattern('regex', p, 'https://claudexai/artifact/abc'), false);
});

test('an empty pattern or a broken regex matches nothing', () => {
  for (const type of ['prefix', 'domain', 'contains', 'regex']) {
    assert.equal(testPattern(type, '', 'https://example.com/'), false, type);
  }
  assert.equal(testPattern('regex', '([unclosed', 'https://example.com/([unclosed'), false);
  assert.equal(testPattern('nonsense', 'x', 'https://x.com/'), false);
});

// ---- exclude patterns and evaluateRule --------------------------------------

test('exclude: each match type can veto a match', () => {
  const base = { matchType: 'domain', pattern: 'example.com' };
  const cases = [
    ['prefix', 'https://example.com/private/', 'https://example.com/private/x', 'https://example.com/public/x'],
    ['domain', 'admin.example.com', 'https://admin.example.com/x', 'https://www.example.com/x'],
    ['contains', '/edit', 'https://example.com/doc/1/edit', 'https://example.com/doc/1'],
    ['regex', '\\.(png|jpg)$', 'https://example.com/a.png', 'https://example.com/a.html'],
  ];
  for (const [excludeType, excludePattern, blocked, allowed] of cases) {
    const r = rule({ ...base, excludeType, excludePattern });
    assert.deepEqual(evaluateRule(r, { url: blocked, title: 't' }), { match: false, reason: 'excluded' }, excludeType);
    assert.equal(evaluateRule(r, { url: allowed, title: 't' }).match, true, excludeType);
  }
});

test('exclude: empty exclude pattern excludes nothing', () => {
  const r = rule({ matchType: 'domain', pattern: 'example.com', excludeType: 'contains', excludePattern: '' });
  assert.equal(evaluateRule(r, { url: 'https://example.com/', title: 't' }).match, true);
});

test('evaluateRule: only http and https pages', () => {
  const r = rule({ matchType: 'contains', pattern: 'e' });
  for (const url of ['chrome://extensions/', 'brave://settings/', 'file:///home/e.html', 'about:blank', 'chrome-extension://abc/e.html', 'ftp://e.com/', 'javascript:alert(1)//e', 'not a url e', '']) {
    assert.deepEqual(evaluateRule(r, { url, title: 't' }), { match: false, reason: 'not-http' }, url);
  }
  assert.equal(evaluateRule(r, { url: 'http://e.com/', title: 't' }).match, true);
  assert.equal(evaluateRule(r, { url: 'https://e.com/', title: 't' }).match, true);
});

test('evaluateRule: reasons for not matching', () => {
  const page = { url: 'https://example.com/a', title: 't' };
  assert.equal(evaluateRule(rule({ matchType: 'regex', pattern: '(' }), page).reason, 'invalid');
  assert.equal(evaluateRule(rule({ matchType: 'prefix', pattern: 'https://other.org/' }), page).reason, 'no-match');
});

test('evaluateRule: matching looks at the raw URL, the result carries the normalized one', () => {
  const r = rule({ matchType: 'contains', pattern: 'tab=files' });
  const ev = evaluateRule(r, { url: 'https://example.com/pr/1?tab=files#diff-3', title: 'PR 1' }, NOON);
  assert.deepEqual(ev, { match: true, url: 'https://example.com/pr/1', title: 'PR 1' });
});

// ---- normalization ----------------------------------------------------------

test('normalizeUrl: the four combinations of strip hash / strip query', () => {
  const url = 'https://example.com/a/b?x=1&y=2#section';
  const n = (stripHash, stripQuery) => normalizeUrl(url, rule({ pattern: 'x', stripHash, stripQuery }));
  assert.equal(n(true, true), 'https://example.com/a/b');
  assert.equal(n(true, false), 'https://example.com/a/b?x=1&y=2');
  assert.equal(n(false, true), 'https://example.com/a/b#section');
  assert.equal(n(false, false), url);
});

test('normalizeUrl: both options default to on', () => {
  const r = sanitizeRule({ pattern: 'x' });
  assert.equal(r.stripHash, true);
  assert.equal(r.stripQuery, true);
});

test('normalizeUrl: edge cases keep the rest of the URL intact', () => {
  const r = rule({ pattern: 'x' });
  assert.equal(normalizeUrl('https://example.com', r), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com/#', r), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com/?', r), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com:8443/p%20q/?a#b', r), 'https://example.com:8443/p%20q/');
  assert.equal(normalizeUrl('https://example.com/a?next=/b#c?d', r), 'https://example.com/a');
});

test('normalizeUrl: idempotent, and never changes origin or path', () => {
  const urls = [
    'https://example.com/a/b?x=1#h', 'http://localhost:3000/', 'https://EXAMPLE.com/Path?Q#H',
    'https://example.com/a%2Fb/?#', 'https://xn--bcher-kva.example/ü?ö=1#ä', 'https://example.com/a;b=c?d',
  ];
  for (const url of urls) {
    for (const stripHash of [true, false]) {
      for (const stripQuery of [true, false]) {
        const r = rule({ pattern: 'x', stripHash, stripQuery });
        const once = normalizeUrl(url, r);
        assert.equal(normalizeUrl(once, r), once, `idempotent: ${url}`);
        const a = new URL(url);
        const b = new URL(once);
        assert.equal(b.origin, a.origin, url);
        assert.equal(b.pathname, a.pathname, url);
        assert.equal(b.hash, stripHash ? '' : a.hash, url);
        assert.equal(b.search, stripQuery ? '' : a.search, url);
      }
    }
  }
});

// ---- titles -----------------------------------------------------------------

test('buildTitle: tab title, page URL and template modes', () => {
  const page = { title: 'My Artifact', url: 'https://claude.ai/artifact/abc?x=1' };
  const url = 'https://claude.ai/artifact/abc';
  assert.equal(buildTitle(rule({ titleMode: 'title' }), page, url, NOON), 'My Artifact');
  assert.equal(buildTitle(rule({ titleMode: 'url' }), page, url, NOON), url);
  assert.equal(
    buildTitle(rule({ titleMode: 'template', titleTemplate: '[{host}] {title} ({date})' }), page, url, NOON),
    '[claude.ai] My Artifact (2026-10-10)'
  );
  assert.equal(buildTitle(rule({ titleMode: 'template', titleTemplate: '{url} {unknown}' }), page, url, NOON), `${url} {unknown}`);
});

test('buildTitle: {date} is the local calendar day, zero-padded', () => {
  const r = rule({ titleMode: 'template', titleTemplate: '{date}' });
  assert.equal(buildTitle(r, { title: 't' }, 'https://e.com/', new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(buildTitle(r, { title: 't' }, 'https://e.com/', new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});

test('buildTitle: never empty, and a title containing a placeholder is not expanded twice', () => {
  const url = 'https://e.com/p';
  assert.equal(buildTitle(rule({ titleMode: 'title' }), { title: '' }, url, NOON), url);
  assert.equal(buildTitle(rule({ titleMode: 'title' }), { title: '   ' }, url, NOON), url);
  assert.equal(buildTitle(rule({ titleMode: 'title' }), {}, url, NOON), url);
  assert.equal(buildTitle(rule({ titleMode: 'template', titleTemplate: '  ' }), { title: 'T' }, url, NOON), url);
  assert.equal(buildTitle(rule({ titleMode: 'template', titleTemplate: '{title}!' }), { title: 'About {host}' }, url, NOON), 'About {host}!');
});

// ---- rule model -------------------------------------------------------------

test('sanitizeRule: defaults', () => {
  const r = sanitizeRule({});
  assert.equal(typeof r.id, 'string');
  assert.ok(r.id.length > 0);
  assert.deepEqual({ ...r, id: 'x' }, {
    id: 'x', name: 'Untitled rule', enabled: true, matchType: 'prefix', pattern: '',
    excludeType: 'contains', excludePattern: '', sites: '', folder: 'Bookmarks bar/Auto Bookmarks',
    titleMode: 'title', titleTemplate: '{title}', stripHash: true, stripQuery: true, cooldownSec: 3,
  });
});

test('sanitizeRule: junk from an import is coerced, unknown fields dropped', () => {
  for (const junk of [null, undefined, 42, 'str', []]) {
    assert.equal(sanitizeRule(junk).matchType, 'prefix');
  }
  const r = sanitizeRule({ id: 7, matchType: 'glob', titleMode: 5, cooldownSec: 'soon', enabled: 0, evil: '<script>', pattern: 9 });
  assert.equal(typeof r.id, 'string');
  assert.equal(r.matchType, 'prefix');
  assert.equal(r.titleMode, 'title');
  assert.equal(r.cooldownSec, 3);
  assert.equal(r.pattern, '');
  assert.equal('evil' in r, false);
  assert.equal(sanitizeRule({ cooldownSec: -5 }).cooldownSec, 0);
  assert.equal(sanitizeRule({ cooldownSec: 1e9 }).cooldownSec, 3600);
  assert.equal(sanitizeRule({ cooldownSec: 0 }).cooldownSec, 0);
  assert.equal(sanitizeRule({ enabled: false }).enabled, false);
});

test('sanitizeRule: a rule survives export and import unchanged', () => {
  const r = rule({ matchType: 'regex', pattern: '^https://a\\.b/', excludeType: 'domain', excludePattern: 'x.a.b', sites: 'a.b', folder: 'Other bookmarks/A/B', titleMode: 'template', titleTemplate: '{host}', stripHash: false, stripQuery: false, cooldownSec: 10, enabled: false });
  assert.deepEqual(sanitizeRule(JSON.parse(JSON.stringify(r))), r);
});

test('preset: the Claude Artifacts rule', () => {
  const p = presetClaudeArtifacts();
  assert.equal(p.matchType, 'regex');
  assert.equal(p.pattern, '^https://claude\\.ai/(code/)?artifact/');
  assert.equal(p.folder, 'Bookmarks bar/Claude Artifacts');
  assert.equal(p.enabled, true);
  assert.deepEqual(validateRule(p), {});
  assert.deepEqual(originsForRule(p), ['*://*.claude.ai/*']);
  const matches = (url) => evaluateRule(p, { url, title: 'A' }).match;
  assert.equal(matches('https://claude.ai/artifact/AbCdEfGhIjKlMnOpQrStUv'), true);
  assert.equal(matches('https://claude.ai/code/artifact/0a1b2c3d-1111-2222-3333-444455556666'), true);
  assert.equal(matches('https://claude.ai/code/artifact/0a1b2c3d?x=1#y'), true);
  assert.equal(matches('https://claude.ai/chat/abc'), false);
  assert.equal(matches('https://claude.ai/code/session_01abc'), false);
  assert.equal(matches('https://claude.ai/artifacts'), false);
  assert.equal(matches('https://claudexai/artifact/abc'), false);
  assert.equal(matches('https://evil.example/?u=https://claude.ai/artifact/abc'), false);
});

test('validateRule: regex errors are reported per field', () => {
  assert.deepEqual(validateRule(rule({ matchType: 'regex', pattern: '^https://ok\\.com/' })), {});
  const e = validateRule(rule({ matchType: 'regex', pattern: '([a-z', excludeType: 'regex', excludePattern: '*oops' }));
  assert.deepEqual(Object.keys(e).sort(), ['excludePattern', 'pattern']);
  assert.match(e.pattern, /Invalid regular expression/);
  assert.match(e.excludePattern, /Invalid regular expression/);
  // A broken exclude under a non-regex type is just text.
  assert.deepEqual(validateRule(rule({ pattern: 'https://a.com/', excludeType: 'contains', excludePattern: '([a-z' })), {});
});

test('validateRule: the other fields', () => {
  const only = (over, key) => assert.deepEqual(Object.keys(validateRule({ ...rule({ pattern: 'https://a.com/' }), ...over })), [key], key);
  only({ pattern: '  ' }, 'pattern');
  only({ pattern: 'ftp://a.com/' }, 'pattern');
  only({ pattern: 'a.com/x' }, 'pattern');
  only({ matchType: 'domain', pattern: 'not a domain' }, 'pattern');
  only({ excludeType: 'domain', excludePattern: 'bad domain!' }, 'excludePattern');
  only({ folder: ' / / ' }, 'folder');
  only({ titleMode: 'template', titleTemplate: ' ' }, 'titleTemplate');
  only({ cooldownSec: NaN }, 'cooldownSec');
  only({ cooldownSec: -1 }, 'cooldownSec');
  only({ cooldownSec: 3601 }, 'cooldownSec');
  only({ matchType: 'contains', pattern: 'x', sites: 'ok.com, bad_domain!' }, 'sites');
  assert.deepEqual(validateRule({ ...rule({ pattern: 'https://a.com/' }), titleTemplate: '' }), {});
});

// ---- host permissions -------------------------------------------------------

test('originsForRule: derived from the pattern when it names a site', () => {
  assert.deepEqual(originsForRule(rule({ matchType: 'prefix', pattern: 'https://claude.ai/artifact/' })), ['https://claude.ai/*']);
  assert.deepEqual(originsForRule(rule({ matchType: 'prefix', pattern: 'http://Localhost:3000/app' })), ['http://localhost/*']);
  assert.deepEqual(originsForRule(rule({ matchType: 'domain', pattern: 'Example.com' })), ['*://*.example.com/*']);
});

test('originsForRule: a prefix that stops inside the host is not trusted as a host', () => {
  // "https://claude" also matches https://claude.evil.net/, so it must not be
  // read as the host "claude".
  assert.deepEqual(originsForRule(rule({ matchType: 'prefix', pattern: 'https://claude' })), [ALL_SITES]);
  assert.deepEqual(originsForRule(rule({ matchType: 'prefix', pattern: 'https://claude', sites: 'claude.ai' })), ['*://*.claude.ai/*']);
});

test('originsForRule: contains and regex use the sites list, else all sites', () => {
  assert.deepEqual(originsForRule(rule({ matchType: 'contains', pattern: '/pull/' })), [ALL_SITES]);
  assert.deepEqual(originsForRule(rule({ matchType: 'regex', pattern: 'x', sites: 'github.com, https://GitLab.com/x\n*.example.org' })),
    ['*://*.github.com/*', '*://*.gitlab.com/*', '*://*.example.org/*']);
});

test('originPatternForUrl: scheme and host, no port, no path', () => {
  assert.equal(originPatternForUrl('https://claude.ai/artifact/abc?x#y'), 'https://claude.ai/*');
  assert.equal(originPatternForUrl('http://localhost:8123/a'), 'http://localhost/*');
});

// ---- folders ----------------------------------------------------------------

test('parseFolderPath: trims and drops empty segments', () => {
  assert.deepEqual(parseFolderPath('Bookmarks bar/Claude Artifacts'), ['Bookmarks bar', 'Claude Artifacts']);
  assert.deepEqual(parseFolderPath(' /Bookmarks bar// A / B/ '), ['Bookmarks bar', 'A', 'B']);
  assert.deepEqual(parseFolderPath(''), []);
});

test('resolveFolder: creates a nested path once, then reuses it', async () => {
  const bm = fakeBookmarks();
  const folder = await resolveFolder(bm, 'Bookmarks bar/Work/Claude/Artifacts', true);
  assert.equal(bm.calls.create, 3);
  assert.equal(folder.title, 'Artifacts');
  assert.equal(bm.folderByPath('Bookmarks bar', 'Work', 'Claude', 'Artifacts').id, folder.id);
  const again = await resolveFolder(bm, 'Bookmarks bar/Work/Claude/Artifacts', true);
  assert.equal(again.id, folder.id);
  assert.equal(bm.calls.create, 3);
  const sibling = await resolveFolder(bm, 'Bookmarks bar/Work/Claude/Notes', true);
  assert.equal(bm.calls.create, 4);
  assert.equal(sibling.parentId, folder.parentId);
});

test('resolveFolder: create=false reports a missing folder without creating anything', async () => {
  const bm = fakeBookmarks();
  assert.equal(await resolveFolder(bm, 'Bookmarks bar/Nope/Deeper', false), null);
  assert.equal(bm.calls.create, 0);
  assert.equal((await resolveFolder(bm, 'Bookmarks bar', false)).id, '1');
});

test('resolveFolder: built-in folders are found whatever the browser calls them', async () => {
  for (const opts of [{ barTitle: 'Bookmarks bar' }, { barTitle: 'Bookmarks' }, { barTitle: 'Lesezeichenleiste' }, { barTitle: 'Bookmarks Bar', folderTypes: false }]) {
    const bm = fakeBookmarks(opts);
    for (const typed of ['Bookmarks bar', 'bookmarks BAR', 'Bookmark bar']) {
      assert.equal((await resolveFolder(bm, `${typed}/X`, true)).parentId, '1', `${opts.barTitle} / ${typed}`);
    }
    assert.equal((await resolveFolder(bm, 'Other bookmarks/Y', true)).parentId, '2');
    assert.equal((await resolveFolder(bm, 'other/Y', true)).parentId, '2');
  }
});

test('resolveFolder: a path that names no built-in folder goes under Other bookmarks', async () => {
  const bm = fakeBookmarks();
  const folder = await resolveFolder(bm, 'Reading/Later', true);
  assert.equal(bm.folderByPath('Other bookmarks', 'Reading', 'Later').id, folder.id);
});

test('resolveFolder: a bookmark with the folder\'s name is not mistaken for the folder', async () => {
  const bm = fakeBookmarks();
  await bm.create({ parentId: '1', title: 'Claude Artifacts', url: 'https://example.com/' });
  const folder = await resolveFolder(bm, 'Bookmarks bar/Claude Artifacts', true);
  assert.equal(folder.url, undefined);
  assert.equal(folder.title, 'Claude Artifacts');
});

test('resolveFolder: empty path is an error', async () => {
  await assert.rejects(resolveFolder(fakeBookmarks(), ' / ', true), /empty/);
});

test('listFolderPaths: every folder as a path, in tree order, bookmarks left out', async () => {
  const bm = fakeBookmarks();
  await resolveFolder(bm, 'Bookmarks bar/Work/Claude', true);
  await resolveFolder(bm, 'Bookmarks bar/Recipes', true);
  await resolveFolder(bm, 'Other bookmarks/Later', true);
  await bm.create({ parentId: '1', title: 'a bookmark', url: 'https://example.com/' });
  assert.deepEqual(await listFolderPaths(bm), [
    'Bookmarks bar', 'Bookmarks bar/Work', 'Bookmarks bar/Work/Claude', 'Bookmarks bar/Recipes',
    'Other bookmarks', 'Other bookmarks/Later',
  ]);
});

test('listFolderPaths: a folder that cannot be written as a path is left out, with its children', async () => {
  const bm = fakeBookmarks();
  const slash = await bm.create({ parentId: '1', title: 'A/B' });
  await bm.create({ parentId: slash.id, title: 'Inside' });
  await bm.create({ parentId: '1', title: '  ' });
  await bm.create({ parentId: '1', title: 'Twin' });
  await bm.create({ parentId: '1', title: 'Twin' });
  assert.deepEqual(await listFolderPaths(bm), ['Bookmarks bar', 'Bookmarks bar/Twin', 'Other bookmarks']);
});

test('listFolderPaths: every listed path resolves back to an existing folder, creating nothing', async () => {
  for (const opts of [{}, { barTitle: 'Bookmarks' }, { barTitle: 'Lesezeichenleiste', folderTypes: false }]) {
    const bm = fakeBookmarks(opts);
    await resolveFolder(bm, 'Bookmarks bar/Work/Claude/Artifacts', true);
    await resolveFolder(bm, 'Other bookmarks/Bookmarks bar/Odd', true);
    const before = bm.calls.create;
    const paths = await listFolderPaths(bm);
    assert.equal(paths.length, 7); // 2 built-in + 3 under the bar + 2 under Other
    for (const path of paths) {
      const folder = await resolveFolder(bm, path, false);
      assert.ok(folder, path);
      assert.equal(folder.title, path.split('/').pop(), path);
      // The folder found is the one the path was listed for, not a namesake.
      let id = folder.id;
      const up = [];
      while (id !== '0') { up.unshift(bm.nodes.get(id).title); id = bm.nodes.get(id).parentId; }
      assert.equal(up.join('/'), path);
    }
    assert.equal(bm.calls.create, before);
  }
});

// ---- the three bookmark cases -----------------------------------------------

const ARTIFACTS = () => rule({ matchType: 'prefix', pattern: 'https://claude.ai/artifact/', folder: 'Bookmarks bar/Claude Artifacts' });
const PAGE = { url: 'https://claude.ai/artifact/abc123?ref=share#top', title: 'Trip Planner' };
const CLEAN = 'https://claude.ai/artifact/abc123';

test('case 1, new: not bookmarked anywhere -> created in the target folder', async () => {
  const bm = fakeBookmarks();
  const r = await bookmarkForRule(bm, ARTIFACTS(), PAGE, NOON);
  const folder = bm.folderByPath('Bookmarks bar', 'Claude Artifacts');
  assert.ok(folder, 'target folder was created');
  assert.deepEqual(r, { status: 'created', url: CLEAN, title: 'Trip Planner', folderId: folder.id, id: r.id, elsewhere: false });
  assert.deepEqual(bm.urlsIn(folder.id), [CLEAN]);
  assert.equal(bm.nodes.get(r.id).title, 'Trip Planner');
});

test('case 2, already in folder: nothing is created', async () => {
  const bm = fakeBookmarks();
  await bookmarkForRule(bm, ARTIFACTS(), PAGE, NOON);
  const before = bm.nodes.size;
  // Same page again, and the same page under a different query/hash.
  for (const page of [PAGE, { url: 'https://claude.ai/artifact/abc123#other', title: 'Renamed' }, { url: CLEAN, title: 'x' }]) {
    const r = await bookmarkForRule(bm, ARTIFACTS(), page, NOON);
    assert.equal(r.status, 'exists', page.url);
    assert.equal(r.url, CLEAN);
  }
  assert.equal(bm.nodes.size, before);
  assert.deepEqual(bm.urlsIn(bm.folderByPath('Bookmarks bar', 'Claude Artifacts').id), [CLEAN]);
});

test('case 3, bookmarked elsewhere: still created in the target folder, the other copy untouched', async () => {
  const bm = fakeBookmarks();
  const stray = await bm.create({ parentId: '2', title: 'old copy', url: CLEAN });
  const nested = await bm.create({ parentId: (await resolveFolder(bm, 'Bookmarks bar/Misc', true)).id, title: 'another', url: CLEAN });
  const r = await bookmarkForRule(bm, ARTIFACTS(), PAGE, NOON);
  const folder = bm.folderByPath('Bookmarks bar', 'Claude Artifacts');
  assert.equal(r.status, 'created');
  assert.equal(r.elsewhere, true);
  assert.deepEqual(bm.urlsIn(folder.id), [CLEAN]);
  assert.equal(bm.nodes.get(stray.id).parentId, '2');
  assert.equal(bm.nodes.get(stray.id).title, 'old copy');
  assert.equal(bm.nodes.get(nested.id).url, CLEAN);
  assert.equal((await bm.search({ url: CLEAN })).length, 3);
  // And it is now case 2.
  assert.equal((await bookmarkForRule(bm, ARTIFACTS(), PAGE, NOON)).status, 'exists');
});

test('a different URL in the target folder does not count as already bookmarked', async () => {
  const bm = fakeBookmarks();
  await bookmarkForRule(bm, ARTIFACTS(), PAGE, NOON);
  const r = await bookmarkForRule(bm, ARTIFACTS(), { url: 'https://claude.ai/artifact/zzz', title: 'Other' }, NOON);
  assert.equal(r.status, 'created');
  assert.deepEqual(bm.urlsIn(r.folderId), [CLEAN, 'https://claude.ai/artifact/zzz']);
});

test('with strip query off, two query strings are two bookmarks', async () => {
  const bm = fakeBookmarks();
  const r = rule({ matchType: 'domain', pattern: 'example.com', folder: 'Other bookmarks/Q', stripQuery: false });
  assert.equal((await bookmarkForRule(bm, r, { url: 'https://example.com/s?q=1#a', title: 'a' })).status, 'created');
  assert.equal((await bookmarkForRule(bm, r, { url: 'https://example.com/s?q=2', title: 'b' })).status, 'created');
  assert.equal((await bookmarkForRule(bm, r, { url: 'https://example.com/s?q=1#b', title: 'c' })).status, 'exists');
  assert.deepEqual(bm.urlsIn(bm.folderByPath('Other bookmarks', 'Q').id), ['https://example.com/s?q=1', 'https://example.com/s?q=2']);
});

test('a page that does not match touches nothing, not even the folder', async () => {
  const bm = fakeBookmarks();
  for (const url of ['https://claude.ai/chat/1', 'chrome://bookmarks/', 'file:///x/claude.ai/artifact/']) {
    assert.equal((await bookmarkForRule(bm, ARTIFACTS(), { url, title: 't' })).status, 'no-match');
  }
  const excluded = { ...ARTIFACTS(), excludeType: 'contains', excludePattern: 'abc' };
  assert.deepEqual(await bookmarkForRule(bm, excluded, PAGE), { status: 'no-match', reason: 'excluded' });
  assert.equal(bm.calls.create, 0);
});

test('one URL, several rules: each rule is handled on its own', async () => {
  const bm = fakeBookmarks();
  const a = ARTIFACTS();
  const b = rule({ id: 'r2', matchType: 'domain', pattern: 'claude.ai', folder: 'Other bookmarks/Everything Claude', titleMode: 'template', titleTemplate: '{host}: {title}', stripQuery: false });
  const c = rule({ id: 'r3', matchType: 'contains', pattern: 'artifact', folder: 'Bookmarks bar/Claude Artifacts' });
  const out = [];
  for (const r of [a, b, c]) out.push(await bookmarkForRule(bm, r, PAGE, NOON));
  assert.deepEqual(out.map((r) => r.status), ['created', 'created', 'exists']);
  // Rule b keeps the query string, so its URL is a different bookmark from rule a's.
  assert.equal(out[1].elsewhere, false);
  assert.equal(out[1].url, 'https://claude.ai/artifact/abc123?ref=share');
  assert.equal(out[1].title, 'claude.ai: Trip Planner');
  assert.deepEqual(bm.urlsIn(bm.folderByPath('Bookmarks bar', 'Claude Artifacts').id), [CLEAN]);
  assert.deepEqual(bm.urlsIn(bm.folderByPath('Other bookmarks', 'Everything Claude').id), ['https://claude.ai/artifact/abc123?ref=share']);
});

// ---- cooldown ---------------------------------------------------------------

test('cooldown: inside the window, at its edge, after it, and when off', () => {
  const key = cooldownKey('r1', CLEAN);
  const map = { [key]: 100_000 };
  assert.equal(inCooldown(map, key, 3, 100_000), true);
  assert.equal(inCooldown(map, key, 3, 102_999), true);
  assert.equal(inCooldown(map, key, 3, 103_000), false);
  assert.equal(inCooldown(map, key, 0, 100_001), false);
  assert.equal(inCooldown(map, cooldownKey('r2', CLEAN), 3, 100_001), false);
  assert.equal(inCooldown(map, cooldownKey('r1', CLEAN + '/x'), 3, 100_001), false);
  // A timestamp from the future (clock change) must not lock the rule out.
  assert.equal(inCooldown(map, key, 3, 50_000), false);
});

test('pruneCooldowns: keeps recent entries, drops old and bogus ones', () => {
  const now = 10_000_000;
  const map = { fresh: now - 1000, old: now - 3_600_001, future: now + 5, junk: 'x' };
  assert.deepEqual(pruneCooldowns(map, now), { fresh: now - 1000 });
  assert.deepEqual(map.old, now - 3_600_001, 'input is not mutated');
});
