import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRule } from '../lib.js';
import { loadRules, saveRules, getPaused, setPaused, getToastEnabled, setToastEnabled, addActivity, getActivity } from '../storage.js';
import { fakeArea } from './fakes.mjs';

const rule = (id, over) => sanitizeRule({ id, name: id, pattern: `https://${id}.example/`, ...over });

function install(syncOpts) {
  globalThis.chrome = { storage: { sync: fakeArea(syncOpts), local: fakeArea() } };
  return globalThis.chrome.storage;
}

beforeEach(() => install());

test('nothing stored yet: no rules, not paused', async () => {
  assert.deepEqual(await loadRules(), { rules: [], area: 'sync' });
  assert.equal(await getPaused(), false);
});

test('save then load: same rules in the same order, in sync, one item per rule', async () => {
  const { sync, local } = chrome.storage;
  const rules = [rule('b'), rule('a'), rule('c')];
  assert.deepEqual(await saveRules(rules), { area: 'sync' });
  assert.deepEqual(Object.keys(sync.data).sort(), ['order', 'rule_a', 'rule_b', 'rule_c']);
  assert.deepEqual(local.data, {});
  assert.deepEqual(await loadRules(), { rules, area: 'sync' });
});

test('reorder and delete: the stored order follows and deleted rules are removed', async () => {
  const [a, b, c] = [rule('a'), rule('b'), rule('c')];
  await saveRules([a, b, c]);
  await saveRules([c, a]);
  assert.deepEqual((await loadRules()).rules, [c, a]);
  assert.equal('rule_b' in chrome.storage.sync.data, false);
});

test('sync quota exceeded: rules fall back to local and load from there', async () => {
  const { sync, local } = install({ quotaBytesPerItem: 8192 });
  const small = [rule('a')];
  await saveRules(small);
  const big = [rule('a'), rule('huge', { matchType: 'regex', pattern: 'x'.repeat(9000) })];
  const info = await saveRules(big);
  assert.equal(info.area, 'local');
  assert.match(info.error, /QUOTA_BYTES_PER_ITEM/);
  assert.equal(local.data.storageArea, 'local');
  assert.deepEqual(await loadRules(), { rules: big, area: 'local' });
  assert.equal('rule_huge' in sync.data, false);
});

test('after a fallback, the next save that fits goes back to sync and clears local', async () => {
  const { sync, local } = install({ quotaBytesPerItem: 8192 });
  await setPaused(true);
  await saveRules([rule('huge', { pattern: 'https://' + 'x'.repeat(9000) })]);
  assert.equal((await loadRules()).area, 'local');
  const fits = [rule('a'), rule('b')];
  assert.deepEqual(await saveRules(fits), { area: 'sync' });
  assert.deepEqual(await loadRules(), { rules: fits, area: 'sync' });
  assert.deepEqual(Object.keys(sync.data).sort(), ['order', 'rule_a', 'rule_b']);
  // Only the rule copies leave local; per-device settings stay.
  assert.deepEqual(local.data, { paused: true });
});

test('sync refusing every write (rate limit, sync off) also falls back', async () => {
  install({ failAll: true });
  const rules = [rule('a')];
  assert.equal((await saveRules(rules)).area, 'local');
  assert.deepEqual((await loadRules()).rules, rules);
});

test('load: a rule missing from the order list is kept at the end, junk is skipped or repaired', async () => {
  Object.assign(chrome.storage.sync.data, {
    order: ['b', 'gone'],
    rule_a: rule('a'),
    rule_b: rule('b'),
    rule_bad: 'not a rule',
    rule_partial: { id: 'partial', pattern: 'https://p.example/' },
    unrelated: 1,
  });
  const { rules } = await loadRules();
  assert.deepEqual(rules.map((r) => r.id), ['b', 'a', 'partial']);
  assert.equal(rules[2].cooldownSec, 3);
});

test('pause is stored locally and survives a rules save', async () => {
  await setPaused(true);
  await saveRules([rule('a')]);
  assert.equal(await getPaused(), true);
  assert.equal('paused' in chrome.storage.sync.data, false);
  await setPaused(false);
  assert.equal(await getPaused(), false);
});

test('toast switch: on by default, stored locally, survives a rules save', async () => {
  assert.equal(await getToastEnabled(), true);
  await setToastEnabled(false);
  await saveRules([rule('a')]);
  assert.equal(await getToastEnabled(), false);
  assert.equal('toast' in chrome.storage.sync.data, false);
  await setToastEnabled(true);
  assert.equal(await getToastEnabled(), true);
});

test('activity log: newest first, capped at 20', async () => {
  for (let i = 0; i < 12; i++) await addActivity([{ at: i, url: `u${i}a` }, { at: i, url: `u${i}b` }]);
  const log = await getActivity();
  assert.equal(log.length, 20);
  assert.deepEqual(log.slice(0, 3).map((e) => e.url), ['u11b', 'u11a', 'u10b']);
  assert.equal(log[19].url, 'u2a');
});
