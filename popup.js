import { isHttpUrl, evaluateRule, originPatternForUrl } from './lib.js';
import { loadRules, getPaused, setPaused, getActivity } from './storage.js';

const $ = (id) => document.getElementById(id);

function line(text, cls) {
  const el = document.createElement('div');
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

const RESULT_TEXT = {
  created: (r) => `Bookmarked by "${r.ruleName}"${r.elsewhere ? ' (it was already bookmarked in another folder)' : ''}.`,
  exists: (r) => `"${r.ruleName}": already in its folder.`,
  'no-access': (r) => `"${r.ruleName}": no access to this site.`,
  error: (r) => `"${r.ruleName}" failed: ${r.error}`,
};

async function showActivity() {
  const box = $('activity');
  box.replaceChildren();
  const items = (await getActivity()).slice(0, 5);
  if (!items.length) box.textContent = 'Nothing bookmarked yet.';
  for (const a of items) {
    const when = new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const el = line(`${when} · ${a.status === 'error' ? 'failed: ' + a.error : a.title || a.url}`);
    el.title = `${a.rule}\n${a.url}`;
    box.append(el);
  }
}

async function init() {
  $('paused').checked = await getPaused();
  $('paused').addEventListener('change', (e) => setPaused(e.target.checked));
  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  showActivity();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const box = $('matches');
  if (!tab || !tab.url || !isHttpUrl(tab.url)) {
    box.append(line('Rules only apply to http and https pages.', 'muted'));
    return;
  }
  const { rules } = await loadRules();
  const matching = rules.filter((r) => r.enabled && evaluateRule(r, tab).match);
  if (!matching.length) {
    box.append(line('No enabled rule matches this page.', 'muted'));
    return;
  }
  box.append(line(`${matching.length} matching rule${matching.length === 1 ? '' : 's'}:`));
  const ul = document.createElement('ul');
  for (const r of matching) {
    const li = document.createElement('li');
    li.textContent = `${r.name} → ${r.folder}`;
    ul.append(li);
  }
  box.append(ul);

  const origin = originPatternForUrl(tab.url);
  const button = $('now');
  button.disabled = false;
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    box.append(line('No access to this site yet. The button below asks for it.', 'bad'));
  }

  button.addEventListener('click', async () => {
    const result = $('result');
    result.replaceChildren();
    // First await in the click handler, so the permission prompt may show.
    // It resolves true straight away when access is already granted.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      result.append(line(`Could not request site access: ${e.message}`, 'bad'));
      return;
    }
    if (!granted) {
      result.append(line('Site access was not granted.', 'bad'));
      return;
    }
    button.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'bookmark-now', tabId: tab.id });
    button.disabled = false;
    if (!res || !res.ok) {
      result.append(line(`Failed: ${res ? res.error : 'no response from the extension'}`, 'bad'));
      return;
    }
    for (const r of res.results) {
      const text = RESULT_TEXT[r.status];
      if (text) result.append(line(text(r), r.status === 'created' || r.status === 'exists' ? 'ok' : 'bad'));
    }
    showActivity();
  });
}

init();
