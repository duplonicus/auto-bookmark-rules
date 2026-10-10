// Where rules live. Each rule is its own storage item ("rule_<id>") plus an
// "order" list, because chrome.storage.sync caps a single item at 8 KB and one
// big array would hit that after a few dozen rules.
//
// Every save tries sync first. If sync refuses (quota, write rate limit, sync
// unavailable) the rules go to chrome.storage.local and a "storageArea" flag in
// local says so; the next successful sync save clears the flag.
//
// The pause switch, the toast switch and the activity log are per-device and
// always local.

import { sanitizeRule } from './lib.js';

const RULE_PREFIX = 'rule_';
const ACTIVITY_MAX = 20;

async function rulesArea() {
  const { storageArea } = await chrome.storage.local.get('storageArea');
  return storageArea === 'local' ? 'local' : 'sync';
}

export async function loadRules() {
  const area = await rulesArea();
  const all = await chrome.storage[area].get(null);
  const order = Array.isArray(all.order) ? all.order : [];
  const ids = [...order];
  for (const key of Object.keys(all)) {
    // A rule missing from "order" (a half-synced write) is kept, at the end.
    if (key.startsWith(RULE_PREFIX) && !ids.includes(key.slice(RULE_PREFIX.length))) {
      ids.push(key.slice(RULE_PREFIX.length));
    }
  }
  const rules = ids
    .map((id) => all[RULE_PREFIX + id])
    .filter((r) => r && typeof r === 'object')
    .map(sanitizeRule);
  return { rules, area };
}

async function writeRules(area, rules) {
  const payload = { order: rules.map((r) => r.id) };
  for (const r of rules) payload[RULE_PREFIX + r.id] = r;
  // Remove deleted rules first so their bytes do not count against the quota.
  const stale = Object.keys(await area.get(null)).filter((k) => k.startsWith(RULE_PREFIX) && !(k in payload));
  if (stale.length) await area.remove(stale);
  await area.set(payload);
}

// -> {area: 'sync'} or {area: 'local', error}
export async function saveRules(rules) {
  try {
    await writeRules(chrome.storage.sync, rules);
  } catch (e) {
    await writeRules(chrome.storage.local, rules);
    await chrome.storage.local.set({ storageArea: 'local' });
    return { area: 'local', error: String((e && e.message) || e) };
  }
  const local = Object.keys(await chrome.storage.local.get(null));
  const leftovers = local.filter((k) => k === 'storageArea' || k === 'order' || k.startsWith(RULE_PREFIX));
  if (leftovers.length) await chrome.storage.local.remove(leftovers);
  return { area: 'sync' };
}

export async function getPaused() {
  const { paused } = await chrome.storage.local.get('paused');
  return paused === true;
}

export async function setPaused(paused) {
  await chrome.storage.local.set({ paused: !!paused });
}

// On unless switched off.
export async function getToastEnabled() {
  const { toast } = await chrome.storage.local.get('toast');
  return toast !== false;
}

export async function setToastEnabled(on) {
  await chrome.storage.local.set({ toast: !!on });
}

export async function getActivity() {
  const { activity } = await chrome.storage.local.get('activity');
  return Array.isArray(activity) ? activity : [];
}

export async function addActivity(entries) {
  if (!entries.length) return;
  const activity = [...entries.reverse(), ...(await getActivity())].slice(0, ACTIVITY_MAX);
  await chrome.storage.local.set({ activity });
}

// A bookmark was renamed after the fact (late page title); keep the log in step.
export async function retitleActivity(at, url, title) {
  const activity = await getActivity();
  const hit = activity.filter((a) => a.at === at && a.url === url && a.status === 'created');
  if (!hit.length) return;
  for (const a of hit) a.title = title;
  await chrome.storage.local.set({ activity });
}

export function isRuleKey(key) {
  return key === 'order' || key === 'storageArea' || key.startsWith(RULE_PREFIX);
}
