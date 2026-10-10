// Real-browser check: loads the unpacked extension into Chromium and drives it
// against a local web server. Not part of `npm test` (it needs a browser).
//
//   npm install            # playwright-core, dev only
//   CHROME=/path/to/chrome npm run e2e
//
// CHROME defaults to the newest Playwright Chromium in ~/.cache/ms-playwright.
//
// A permission prompt cannot be clicked from automation, so the run uses two
// copies of the extension: one unmodified (no site access: rules must NOT run)
// and one whose manifest already has host access to http://localhost/* (the
// state after the user clicks Allow).

import { chromium } from 'playwright-core';
import http from 'node:http';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || join(tmpdir(), 'auto-bookmark-rules-shots');
const EXT_FILES = ['manifest.json', 'background.js', 'lib.js', 'storage.js', 'toast.js', 'options.html', 'options.js', 'popup.html', 'popup.js', 'icons'];

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.slice(9) - a.slice(9));
  for (const b of builds) {
    const exe = join(cache, b, 'chrome-linux64', 'chrome');
    if (existsSync(exe)) return exe;
    const old = join(cache, b, 'chrome-linux', 'chrome');
    if (existsSync(old)) return old;
  }
  throw new Error('No Chromium found; set CHROME.');
}

function copyExtension(withLocalhostAccess) {
  const dir = mkdtempSync(join(tmpdir(), 'abr-ext-'));
  for (const f of EXT_FILES) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  if (withLocalhostAccess) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['http://localhost/*'];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

const PAGES = {
  '/artifact/one': '<title>Artifact One</title><h1>one</h1>',
  '/artifact/two': '<title>Artifact Two</title><h1>two</h1>',
  '/artifact/three': '<title>Artifact Three</title><h1>three</h1>',
  '/artifact/four': '<title>Artifact Four</title><h1>four</h1>',
  '/artifact/five': '<title>Artifact Five</title><h1>five</h1>',
  '/artifact/toast-light': '<title>Toast Light</title><body style="background:#fff"><h1>light</h1>',
  '/artifact/toast-dark': '<title>Toast Dark</title><body style="background:#111;color:#eee"><h1>dark</h1>',
  '/artifact/toast-off': '<title>Toast Off</title><h1>off</h1>',
  '/artifact/six': '<title>Artifact Six</title><h1>six</h1>',
  '/artifact/private/x': '<title>Private</title><h1>private</h1>',
  '/other': '<title>Other</title><h1>other</h1>',
  // Sets its real title a moment after load, like a single-page app.
  '/artifact/late': '<title>Loading…</title><h1>late</h1><script>setTimeout(() => { document.title = "Late Title"; }, 1200);</script>',
  // Navigates with history.pushState, which never fires a page load.
  '/app': '<title>App</title><button id="go">go</button><script>document.getElementById("go").onclick = () => { history.pushState({}, "", "/artifact/pushed"); document.title = "Pushed"; };</script>',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const body = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ? `<!doctype html>${body}` : 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(extDir) {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'abr-profile-')), {
    executablePath: findChrome(),
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  return { context, extId };
}

async function poll(fn, what, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOAST = '[data-auto-bookmark-rules-toast]';
// Text and WCAG contrast of the toast's lines, read through its shadow root.
function readToast(page) {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return null;
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const box = host.shadowRoot.querySelector('.toast');
    const bg = lum(parse(getComputedStyle(box).backgroundColor));
    const lines = [...box.children].map((el) => {
      const fg = lum(parse(getComputedStyle(el).color));
      const [a, b] = [fg, bg].sort((x, y) => y - x);
      return { text: el.textContent, ratio: (a + 0.05) / (b + 0.05) };
    });
    const r = host.getBoundingClientRect();
    return { lines, bg: getComputedStyle(box).backgroundColor, inViewport: r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  }, TOAST);
}

const passed = [];
async function step(name, fn) {
  await fn();
  passed.push(name);
  console.log(`ok - ${name}`);
}

// WCAG contrast of an element's text against the nearest opaque background.
function contrastOf(page, selector) {
  return page.evaluate((sel) => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const el = document.querySelector(sel);
    if (!el) return null;
    const fg = parse(getComputedStyle(el).color);
    let bg = null;
    for (let n = el; n && !bg; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length < 4 || c[3] === 1) bg = c;
    }
    bg = bg || [255, 255, 255];
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { ratio: (a + 0.05) / (b + 0.05), bg: bg.slice(0, 3).join(',') };
  }, selector);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  const cleanup = [];

  // ---- A: unmodified extension, no site access ------------------------------
  {
    const { context, extId } = await launch(copyExtension(false));
    cleanup.push(() => context.close());
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);

    await step('manifest asks for bookmarks, tabs, storage, scripting and no host access up front', async () => {
      const m = await options.evaluate(() => chrome.runtime.getManifest());
      assert.deepEqual(m.permissions, ['bookmarks', 'tabs', 'storage', 'scripting']);
      assert.equal(m.host_permissions, undefined);
      const granted = await options.evaluate(() => chrome.permissions.getAll());
      assert.deepEqual(granted.origins, []);
    });

    await step('without site access a matching page is NOT bookmarked, and the options page says why', async () => {
      await options.evaluate((pattern) => chrome.storage.sync.set({
        order: ['a'],
        rule_a: { id: 'a', name: 'No access', enabled: true, matchType: 'prefix', pattern, folder: 'Bookmarks bar/E2E' },
      }), `${base}/artifact/`);
      const tab = await context.newPage();
      await tab.goto(`${base}/artifact/one`);
      await sleep(1500);
      assert.deepEqual(await options.evaluate((url) => chrome.bookmarks.search({ url }), `${base}/artifact/one`), []);
      assert.equal(await tab.locator(TOAST).count(), 0, 'no toast, and nothing injected, without site access');
      await options.bringToFront();
      await poll(() => options.locator('[data-access="a"]:not([hidden])').count(), 'no-access badge');
      assert.equal(await options.locator('[data-access="a"]').textContent(), 'no site access');
      assert.match(await options.locator('#access-text').textContent(), /no access to localhost/);
      const tabId = await options.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/artifact/one`);
      const res = await options.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'bookmark-now', tabId }), tabId);
      assert.deepEqual(res.results.map((r) => r.status), ['no-access']);
    });
    await context.close();
    cleanup.pop();
  }

  // ---- B: site access to localhost granted ----------------------------------
  const { context, extId } = await launch(copyExtension(true));
  cleanup.push(() => context.close());
  const errors = [];
  const options = await context.newPage();
  options.on('pageerror', (e) => errors.push(`options: ${e.message}`));
  options.on('console', (m) => m.type() === 'error' && errors.push(`options console: ${m.text()}`));
  await options.goto(`chrome-extension://${extId}/options.html`);
  const bookmarksFor = (path) => options.evaluate((url) => chrome.bookmarks.search({ url }), `${base}${path}`);
  const folderId = () => options.evaluate(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children[0];
    const e2e = (await chrome.bookmarks.getChildren(bar.id)).find((n) => n.title === 'E2E');
    const sub = e2e && (await chrome.bookmarks.getChildren(e2e.id)).find((n) => n.title === 'Artifacts');
    return sub ? sub.id : null;
  });
  const tab = await context.newPage();

  await step('options: add a rule through the form; regex error shows inline; test box reports match, folder and title', async () => {
    await options.bringToFront();
    await options.click('#add');
    await options.fill('#f-name', 'E2E artifacts');
    await options.selectOption('#f-matchType', 'regex');
    await options.fill('#f-pattern', '([oops');
    assert.match(await options.locator('[data-field="pattern"] .err').textContent(), /Invalid regular expression/);
    await options.click('#save-rule');
    assert.equal(await options.locator('#status').textContent(), 'Fix the highlighted fields first.');
    assert.equal(await options.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).length), 0);

    await options.selectOption('#f-matchType', 'prefix');
    await options.fill('#f-pattern', `${base}/artifact/`);
    assert.equal(await options.locator('[data-field="pattern"] .err').textContent(), '');
    await options.selectOption('#f-excludeType', 'contains');
    await options.fill('#f-excludePattern', '/private/');
    await options.fill('#f-folder', 'Bookmarks bar/E2E/Artifacts');
    await options.selectOption('#f-titleMode', 'template');
    await options.fill('#f-titleTemplate', '{title} @ {host}');
    await options.fill('#f-cooldownSec', '1');

    await options.fill('#test-url', `${base}/artifact/one?x=1#frag`);
    await options.fill('#test-title', 'Hello');
    await poll(async () => (await options.locator('.test-out').textContent()).includes('(will be created)'), 'test output');
    const out = await options.locator('.test-out dd').allTextContents();
    assert.deepEqual(out, [`${base}/artifact/one`, 'Bookmarks bar/E2E/Artifacts (will be created)', 'Hello @ localhost']);
    await options.fill('#test-url', `${base}/artifact/private/x`);
    assert.equal(await options.locator('.test-out').textContent(), 'No match: the exclude pattern matches.');
    await options.fill('#test-url', `${base}/other`);
    assert.equal(await options.locator('.test-out').textContent(), 'No match: the pattern does not match.');
    await options.screenshot({ path: join(SHOTS, 'options-editor-light.png'), fullPage: true });

    await options.click('#save-rule');
    await poll(async () => (await options.locator('#status').textContent()) === 'Saved "E2E artifacts".', 'saved status');
    const stored = await options.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(stored.order.length, 1);
    assert.equal(stored[`rule_${stored.order[0]}`].pattern, `${base}/artifact/`);
    assert.equal(await folderId(), null, 'the test box must not create the folder');
  });

  await step('case 1: a new matching page is bookmarked into the nested folder, URL normalized, title from the template', async () => {
    await tab.goto(`${base}/artifact/one?x=1#frag`);
    const [bm] = await poll(async () => { const r = await bookmarksFor('/artifact/one'); return r.length && r; }, 'bookmark for /artifact/one');
    assert.equal(bm.parentId, await folderId());
    assert.equal(bm.title, 'Artifact One @ localhost');
    assert.equal((await bookmarksFor('/artifact/one?x=1#frag')).length, 0);
  });

  await step('toast: shown in the page when a bookmark is added, readable in both themes, then gone', async () => {
    const seen = {};
    for (const [scheme, path] of [['light', '/artifact/toast-light'], ['dark', '/artifact/toast-dark']]) {
      await tab.emulateMedia({ colorScheme: scheme });
      await tab.goto(`${base}${path}`);
      const t = await poll(() => readToast(tab), `toast on ${path}`);
      assert.deepEqual(t.lines.map((l) => l.text), ['Bookmarked', '→ Bookmarks bar/E2E/Artifacts']);
      for (const l of t.lines) assert.ok(l.ratio >= 4.5, `${scheme} "${l.text}": contrast ${l.ratio.toFixed(2)}`);
      assert.equal(t.inViewport, true);
      seen[scheme] = t.bg;
      await sleep(300);
      await tab.screenshot({ path: join(SHOTS, `toast-${scheme}.png`) });
    }
    assert.notEqual(seen.light, seen.dark);
    await tab.emulateMedia({ colorScheme: 'light' });
    await poll(async () => (await tab.locator(TOAST).count()) === 0, 'toast removes itself', 6000);
    assert.equal((await bookmarksFor('/artifact/toast-dark')).length, 1);
  });

  await step('toast: none when the page was already bookmarked, none on a non-matching page, none when switched off', async () => {
    await tab.goto(`${base}/artifact/toast-dark`);
    await sleep(1200);
    assert.equal(await tab.locator(TOAST).count(), 0, 'already in the folder');
    await tab.goto(`${base}/other`);
    await sleep(800);
    assert.equal(await tab.locator(TOAST).count(), 0, 'no rule matches');

    await options.bringToFront();
    assert.equal(await options.isChecked('#toast'), true, 'on by default');
    await options.uncheck('#toast');
    await tab.goto(`${base}/artifact/toast-off`);
    await poll(async () => (await bookmarksFor('/artifact/toast-off')).length === 1, 'bookmark still made');
    await sleep(500);
    assert.equal(await tab.locator(TOAST).count(), 0, 'switched off');
    await options.check('#toast');
  });

  await step('case 2: reloading, and revisiting after the cooldown, adds no duplicate', async () => {
    await tab.reload();
    await sleep(1500);
    await tab.goto(`${base}/artifact/one?y=2`);
    await sleep(1000);
    assert.equal((await bookmarksFor('/artifact/one')).length, 1);
  });

  await step('case 3: a page bookmarked in another folder still gets a bookmark in the target folder', async () => {
    const stray = await options.evaluate((url) => chrome.bookmarks.create({ parentId: '2', title: 'stray', url }), `${base}/artifact/two`);
    await tab.goto(`${base}/artifact/two`);
    const all = await poll(async () => { const r = await bookmarksFor('/artifact/two'); return r.length === 2 && r; }, 'second bookmark for /artifact/two');
    assert.deepEqual(all.map((b) => b.parentId).sort(), [stray.parentId, await folderId()].sort());
  });

  await step('non-matching and excluded pages are left alone', async () => {
    await tab.goto(`${base}/other`);
    await tab.goto(`${base}/artifact/private/x`);
    await sleep(1000);
    assert.equal((await bookmarksFor('/other')).length, 0);
    assert.equal((await bookmarksFor('/artifact/private/x')).length, 0);
  });

  await step('a title set after load renames the fresh bookmark', async () => {
    await tab.goto(`${base}/artifact/late`);
    await poll(async () => (await bookmarksFor('/artifact/late')).length === 1, 'bookmark for /artifact/late');
    await poll(async () => (await bookmarksFor('/artifact/late'))[0].title === 'Late Title @ localhost', 'renamed bookmark', 6000);
  });

  await step('a history.pushState navigation (no page load) is bookmarked', async () => {
    await tab.goto(`${base}/app`);
    await tab.click('#go');
    await poll(async () => (await bookmarksFor('/artifact/pushed')).length === 1, 'bookmark for /artifact/pushed');
    await poll(async () => (await bookmarksFor('/artifact/pushed'))[0].title === 'Pushed @ localhost', 'pushed bookmark takes the new title');
    assert.equal((await bookmarksFor('/app')).length, 0);
  });

  await step('a second rule on the same URL is handled independently', async () => {
    await options.evaluate(async (pattern) => {
      const all = await chrome.storage.sync.get(null);
      await chrome.storage.sync.set({
        order: [...all.order, 'second'],
        rule_second: { id: 'second', name: 'Second', enabled: true, matchType: 'contains', pattern, folder: 'Other bookmarks/E2E second', titleMode: 'url', cooldownSec: 0 },
      });
    }, '/artifact/three');
    await tab.goto(`${base}/artifact/three`);
    const all = await poll(async () => { const r = await bookmarksFor('/artifact/three'); return r.length === 2 && r; }, 'two bookmarks for /artifact/three');
    assert.deepEqual(all.map((b) => b.title).sort(), ['Artifact Three @ localhost', `${base}/artifact/three`].sort());
    const t = await poll(() => readToast(tab), 'toast for two rules');
    assert.deepEqual(t.lines.map((l) => l.text), ['Bookmarked', '→ Bookmarks bar/E2E/Artifacts', '→ Other bookmarks/E2E second']);
    assert.notEqual(all[0].parentId, all[1].parentId);
  });

  await step('pause stops automatic bookmarking; "bookmark now" still works while paused', async () => {
    await options.bringToFront();
    await options.check('#paused');
    await tab.goto(`${base}/artifact/four`);
    await sleep(1200);
    assert.equal((await bookmarksFor('/artifact/four')).length, 0);
    const tabId = await options.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/artifact/four`);
    const res = await options.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'bookmark-now', tabId }), tabId);
    assert.equal(res.ok, true);
    assert.deepEqual(res.results.map((r) => r.status), ['created']);
    assert.equal((await bookmarksFor('/artifact/four')).length, 1);
    const again = await options.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'bookmark-now', tabId }), tabId);
    assert.deepEqual(again.results.map((r) => r.status), ['exists']);
    await options.uncheck('#paused');
  });

  await step('popup: lists the matching rule, pause toggle writes through, "Bookmark this page now" works while paused', async () => {
    await tab.goto(`${base}/artifact/six`);
    await poll(async () => (await bookmarksFor('/artifact/six')).length === 1, 'bookmark for /artifact/six');
    await options.evaluate(async (url) => chrome.bookmarks.remove((await chrome.bookmarks.search({ url }))[0].id), `${base}/artifact/six`);
    const tabId = await options.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/artifact/six`);

    // Opened as a tab, the popup would see itself as the active tab, so point
    // its active-tab lookup at the web page. Everything else is the real thing.
    const popup = await context.newPage();
    popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
    await popup.addInitScript((t) => { chrome.tabs.query = async () => [t]; }, { id: tabId, url: `${base}/artifact/six?from=popup#x`, title: 'Artifact Six' });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await poll(() => popup.locator('#matches li').count(), 'matching rules in the popup');
    assert.deepEqual(await popup.locator('#matches li').allTextContents(), ['E2E artifacts → Bookmarks bar/E2E/Artifacts']);
    assert.equal(await popup.isChecked('#paused'), false);
    // The popup shows the five newest entries of the log.
    assert.equal(await popup.locator('#activity div').count(), 5);
    assert.match(await popup.locator('#activity div >> nth=0').textContent(), /Artifact Six @ localhost$/);
    const logged = (await options.evaluate(() => chrome.storage.local.get('activity'))).activity.map((a) => a.title);
    assert.ok(logged.includes('Late Title @ localhost'), 'the log follows a renamed bookmark');
    assert.ok(!logged.some((t) => t.startsWith('Loading')), 'no stale title left in the log');

    await popup.check('#paused');
    await poll(() => options.isChecked('#paused'), 'options page follows the popup pause toggle');
    await tab.reload();
    await sleep(1200);
    assert.equal((await bookmarksFor('/artifact/six')).length, 0, 'paused: nothing bookmarked automatically');

    await popup.click('#now');
    await poll(async () => (await popup.locator('#result').textContent()) === 'Bookmarked by "E2E artifacts".', 'popup result');
    assert.ok(await readToast(tab), 'the popup button toasts in the page too');
    assert.equal((await bookmarksFor('/artifact/six')).length, 1);
    await popup.click('#now');
    await poll(async () => (await popup.locator('#result').textContent()) === '"E2E artifacts": already in its folder.', 'popup result on second click');
    assert.equal((await bookmarksFor('/artifact/six')).length, 1);

    await popup.setViewportSize({ width: 320, height: 420 });
    await popup.screenshot({ path: join(SHOTS, 'popup-light.png') });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.screenshot({ path: join(SHOTS, 'popup-dark.png') });
    for (const scheme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme: scheme });
      for (const sel of ['h1', '#matches li', '#now', '#result .ok', '#activity div', '#options']) {
        const c = await contrastOf(popup, sel);
        assert.ok(c && c.ratio >= 4.5, `popup ${scheme} ${sel}: contrast ${c && c.ratio.toFixed(2)}`);
      }
    }
    await popup.uncheck('#paused');
    await poll(async () => !(await options.isChecked('#paused')), 'unpaused');
    await popup.close();
  });

  await step('the service worker can be killed and still handles the next page', async () => {
    const cdp = await context.newCDPSession(options);
    const target = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    assert.ok(target, 'service worker target is running before the kill');
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await poll(async () => !(await cdp.send('Target.getTargets')).targetInfos.some((t) => t.type === 'service_worker' && t.url.includes(extId)), 'service worker stopped');
    await tab.goto(`${base}/artifact/five`);
    await poll(async () => (await bookmarksFor('/artifact/five')).length === 1, 'bookmark after worker restart');
    // The cooldown map is in storage.session, so it survived the restart.
    const session = await options.evaluate(() => chrome.storage.session.get('cooldowns'));
    assert.ok(Object.keys(session.cooldowns).some((k) => k.endsWith('/artifact/one')), 'cooldown entries from before the restart are still there');
  });

  await step('options: disable, reorder, export, import, delete', async () => {
    await options.bringToFront();
    await options.reload();
    await poll(async () => (await options.locator('.card').count()) === 2, 'two rule cards');
    const names = () => options.locator('.card .name').evaluateAll((els) => els.map((e) => e.firstChild.textContent));
    assert.deepEqual(await names(), ['E2E artifacts', 'Second']);

    await options.locator('.card >> nth=1').getByRole('button', { name: 'Move up' }).click();
    await poll(async () => (await names())[0] === 'Second', 'reordered');
    assert.deepEqual((await options.evaluate(() => chrome.storage.sync.get('order'))).order.slice(0, 1), ['second']);

    await options.locator('.card >> nth=0').getByRole('checkbox').uncheck();
    await poll(() => options.evaluate(async () => (await chrome.storage.sync.get('rule_second')).rule_second.enabled === false), 'rule disabled in storage');
    await tab.goto(`${base}/artifact/one`);
    await sleep(800);
    assert.equal((await bookmarksFor('/artifact/one')).length, 1, 'a disabled rule does not bookmark');

    await options.bringToFront();
    const [download] = await Promise.all([options.waitForEvent('download'), options.click('#export')]);
    const file = join(SHOTS, 'export.json');
    await download.saveAs(file);
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(exported.app, 'auto-bookmark-rules');
    assert.deepEqual(exported.rules.map((r) => r.name), ['Second', 'E2E artifacts']);

    await options.setInputFiles('#import-file', file);
    await poll(async () => (await options.locator('.card').count()) === 4, 'import appended two rules');
    const ids = (await options.evaluate(() => chrome.storage.sync.get('order'))).order;
    assert.equal(new Set(ids).size, 4, 'imported rules got fresh ids');

    await options.check('#import-replace');
    await options.setInputFiles('#import-file', file);
    await poll(async () => (await options.locator('.card').count()) === 2, 'import with replace');
    assert.deepEqual(await names(), ['Second', 'E2E artifacts']);

    const bad = join(SHOTS, 'bad.json');
    writeFileSync(bad, '{"nope": true}');
    await options.setInputFiles('#import-file', bad);
    await poll(async () => (await options.locator('#status').textContent()).startsWith('Import failed'), 'import error');
    assert.equal(await options.locator('.card').count(), 2);

    const del = options.locator('.card >> nth=0').getByRole('button', { name: 'Delete' });
    await del.click();
    await options.locator('.card >> nth=0').getByRole('button', { name: 'Really delete?' }).click();
    await poll(async () => (await options.locator('.card').count()) === 1, 'rule deleted');
    assert.deepEqual(Object.keys(await options.evaluate(() => chrome.storage.sync.get(null))).filter((k) => k.startsWith('rule_')).length, 1);
  });

  await step('options: the folder picker lists existing folders and fills the path', async () => {
    await options.locator('.card >> nth=0').getByRole('button', { name: 'Edit' }).click();
    await poll(async () => (await options.locator('#folder-pick option').count()) > 3, 'folder options');
    const listed = await options.locator('#folder-pick option').evaluateAll((els) => els.map((e) => e.value));
    assert.equal(listed[0], '');
    const bar = await options.evaluate(async () => (await chrome.bookmarks.getTree())[0].children[0].title);
    for (const path of [bar, `${bar}/E2E`, `${bar}/E2E/Artifacts`]) assert.ok(listed.includes(path), path);
    assert.equal(new Set(listed).size, listed.length);

    await options.fill('#f-folder', 'Bookmarks bar/Somewhere else');
    await options.selectOption('#folder-pick', `${bar}/E2E`);
    assert.equal(await options.inputValue('#f-folder'), `${bar}/E2E`);
    assert.equal(await options.inputValue('#folder-pick'), '', 'the picker goes back to its prompt');
    // Typing after picking still works, for a new subfolder.
    await options.locator('#f-folder').pressSequentially('/Picked');
    await options.fill('#test-url', `${base}/artifact/one`);
    await poll(async () => (await options.locator('.test-out').textContent()).includes(`${bar}/E2E/Picked (will be created)`), 'test box shows the new subfolder');
    await options.selectOption('#folder-pick', `${bar}/E2E/Artifacts`);
    await poll(async () => (await options.locator('.test-out').textContent()).includes(`${bar}/E2E/Artifacts (exists)`), 'test box shows the picked folder exists');
    await options.screenshot({ path: join(SHOTS, 'options-picker.png'), fullPage: true });

    await options.selectOption('#folder-pick', `${bar}/E2E`);
    await options.click('#save-rule');
    await poll(async () => (await options.locator('#status').textContent()).startsWith('Saved'), 'saved');
    const stored = await options.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(stored[`rule_${stored.order[0]}`].folder, `${bar}/E2E`);
    await tab.goto(`${base}/artifact/two`);
    const e2eId = await options.evaluate(async (t) => {
      const b = (await chrome.bookmarks.getTree())[0].children[0];
      return (await chrome.bookmarks.getChildren(b.id)).find((n) => n.title === t).id;
    }, 'E2E');
    await poll(async () => (await bookmarksFor('/artifact/two')).some((b) => b.parentId === e2eId), 'bookmark lands in the picked folder');
  });

  await step('options: preset adds the claude.ai rule', async () => {
    // claude.ai access is not granted here and the prompt cannot be answered
    // from automation, so answer the request with "denied".
    await options.evaluate(() => { chrome.permissions.request = async () => false; });
    await options.click('#preset');
    await poll(async () => (await options.locator('.card').count()) === 2, 'preset card');
    const stored = await options.evaluate(() => chrome.storage.sync.get(null));
    const preset = stored[`rule_${stored.order[1]}`];
    assert.equal(preset.pattern, '^https://claude\\.ai/(code/)?artifact/');
    assert.equal(preset.matchType, 'regex');
    assert.equal(preset.folder, 'Bookmarks bar/Claude Artifacts');
    assert.match(await options.locator('#status').textContent(), /access to claude\.ai was not granted/);
    await poll(async () => (await options.locator(`[data-access="${preset.id}"]`).textContent()) === 'no site access', 'preset shows no access');
    await options.click('#preset');
    assert.equal(await options.locator('#status').textContent(), 'The Claude Artifacts rule is already in the list.');
    assert.equal(await options.locator('.card').count(), 2);
  });

  await step('light and dark themes: different palettes, readable contrast in both', async () => {
    await options.locator('.card >> nth=0').getByRole('button', { name: 'Edit' }).click();
    const selectors = ['h1', '.sub', '.desc', '#add', '.field label', '.field .hint', '.badge.warn', '#access-text', '#f-pattern'];
    const seen = {};
    for (const scheme of ['light', 'dark']) {
      await options.emulateMedia({ colorScheme: scheme });
      seen[scheme] = (await contrastOf(options, 'h1')).bg;
      for (const sel of selectors) {
        const c = await contrastOf(options, sel);
        assert.ok(c, `${sel} exists`);
        assert.ok(c.ratio >= 4.5, `${scheme} ${sel}: contrast ${c.ratio.toFixed(2)} on ${c.bg}`);
      }
      await options.screenshot({ path: join(SHOTS, `options-${scheme}.png`), fullPage: true });
    }
    assert.notEqual(seen.light, seen.dark);
  });

  await step('no page errors, and the extension made no network requests', async () => {
    assert.deepEqual(errors, []);
    const requests = await options.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name));
    assert.deepEqual(requests.filter((u) => !u.startsWith(`chrome-extension://`)), []);
  });

  await context.close();
  server.close();
  console.log(`\n${passed.length} steps passed. Screenshots in ${SHOTS}`);
}

main().catch((e) => {
  console.error(`\nFAILED after ${passed.length} passed steps:\n`, e);
  process.exit(1);
});
