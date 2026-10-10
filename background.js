// Service worker. Holds no state that matters: rules come from storage on every
// event, the debounce map and the title follow-ups live in chrome.storage.session.

import {
  isHttpUrl,
  evaluateRule,
  bookmarkForRule,
  buildTitle,
  normalizeUrl,
  originPatternForUrl,
  cooldownKey,
  inCooldown,
  pruneCooldowns,
} from './lib.js';
import { loadRules, getPaused, getToastEnabled, addActivity, retitleActivity } from './storage.js';
import { showToast } from './toast.js';

// A page that sets its real title after load (most single-page apps) gets its
// bookmark renamed if the title changes within this window.
const TITLE_FOLLOWUP_MS = 30_000;

// Events are handled one at a time so two events for the same page cannot both
// see "not bookmarked yet" and create the folder or the bookmark twice. If the
// worker is restarted the queue is simply empty again, which is fine.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch((e) => console.error('auto-bookmark-rules:', e));
  return run;
}

async function hasSiteAccess(url) {
  try {
    return await chrome.permissions.contains({ origins: [originPatternForUrl(url)] });
  } catch {
    return false;
  }
}

// Tells the user, in the tab it happened in. Site access is already there: a
// rule does not run on a site without it.
async function toast(tabId, folders) {
  if (tabId == null || !folders.length || !(await getToastEnabled())) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showToast, args: [folders] });
  } catch {
    // The tab closed or navigated away. The bookmark is made either way.
  }
}

// -> [{ruleId, ruleName, status, ...}] for every enabled rule that matches.
// status: created | exists | cooldown | no-access | error
async function handleTab(tab, { manual }) {
  if (!tab || !tab.url || !isHttpUrl(tab.url)) return [];
  if (!manual && (await getPaused())) return [];
  const { rules } = await loadRules();
  const now = Date.now();
  const matching = rules.filter((r) => r.enabled && evaluateRule(r, tab).match);
  if (!matching.length) return [];

  const access = await hasSiteAccess(tab.url);
  const stored = await chrome.storage.session.get(['cooldowns', 'followups']);
  const cooldowns = pruneCooldowns(stored.cooldowns || {}, now);
  const results = [];
  const created = [];

  for (const rule of matching) {
    const base = { ruleId: rule.id, ruleName: rule.name };
    if (!access) {
      results.push({ ...base, status: 'no-access' });
      continue;
    }
    const key = cooldownKey(rule.id, normalizeUrl(tab.url, rule));
    if (!manual && inCooldown(cooldowns, key, rule.cooldownSec, now)) {
      results.push({ ...base, status: 'cooldown' });
      continue;
    }
    cooldowns[key] = now;
    try {
      const r = await bookmarkForRule(chrome.bookmarks, rule, tab, new Date(now));
      results.push({ ...base, ...r });
      if (r.status === 'created') created.push({ bookmarkId: r.id, ruleId: rule.id, folder: rule.folder.trim() });
    } catch (e) {
      results.push({ ...base, status: 'error', error: String((e && e.message) || e) });
    }
  }

  const followups = stored.followups || {};
  for (const [id, f] of Object.entries(followups)) {
    if (now - f.at > TITLE_FOLLOWUP_MS) delete followups[id];
  }
  if (created.length && tab.id != null) {
    followups[tab.id] = { at: now, url: tab.url, items: created.map(({ bookmarkId, ruleId }) => ({ bookmarkId, ruleId })) };
  }
  await chrome.storage.session.set({ cooldowns, followups });

  await addActivity(
    results
      .filter((r) => r.status === 'created' || r.status === 'error')
      .map((r) => ({ at: now, rule: r.ruleName, status: r.status, url: r.url || tab.url, title: r.title, error: r.error }))
  );
  await toast(tab.id, [...new Set(created.map((c) => c.folder))]);
  return results;
}

async function followUpTitle(tabId, tab) {
  const { followups = {} } = await chrome.storage.session.get('followups');
  const f = followups[tabId];
  if (!f) return;
  if (Date.now() - f.at > TITLE_FOLLOWUP_MS || f.url !== tab.url) {
    delete followups[tabId];
    await chrome.storage.session.set({ followups });
    return;
  }
  const { rules } = await loadRules();
  for (const item of f.items) {
    const rule = rules.find((r) => r.id === item.ruleId);
    if (!rule || rule.titleMode === 'url') continue;
    try {
      const url = normalizeUrl(tab.url, rule);
      const title = buildTitle(rule, tab, url, new Date(f.at));
      await chrome.bookmarks.update(item.bookmarkId, { title });
      await retitleActivity(f.at, url, title);
    } catch {
      // The bookmark was deleted in the meantime; nothing to rename.
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // "complete" covers page loads, and in Chromium also history.pushState
  // navigations (tests/e2e.mjs passes with the second condition removed). The
  // URL-change condition is a fallback for a browser that reports a pushState
  // as a bare URL change; the cooldown absorbs the case where both fire.
  if (changeInfo.status === 'complete' || (changeInfo.url && tab.status === 'complete')) {
    enqueue(() => handleTab(tab, { manual: false }));
  } else if (changeInfo.title) {
    enqueue(() => followUpTitle(tabId, tab));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'bookmark-now') return;
  enqueue(async () => handleTab(await chrome.tabs.get(msg.tabId), { manual: true })).then(
    (results) => sendResponse({ ok: true, results }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
