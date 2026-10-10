import {
  MATCH_TYPES,
  ALL_SITES,
  sanitizeRule,
  presetClaudeArtifacts,
  validateRule,
  evaluateRule,
  originsForRule,
  canDeriveOrigins,
  resolveFolder,
  listFolderPaths,
  newId,
} from './lib.js';
import { loadRules, saveRules, getPaused, setPaused, getToastEnabled, setToastEnabled, isRuleKey } from './storage.js';

const MATCH_LABELS = {
  prefix: 'URL starts with',
  domain: 'Domain is',
  contains: 'URL contains',
  regex: 'Regex',
};
const REASONS = {
  'not-http': 'not an http or https URL',
  invalid: 'the rule has an invalid regex',
  'no-match': 'the pattern does not match',
  excluded: 'the exclude pattern matches',
};

let rules = [];
let draft = null; // the rule being edited, a copy
let draftIsNew = false;
let testInput = { url: '', title: '' };
let editorRefresh = null; // re-validates the open editor without rebuilding it

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid);
  }
  return el;
}

function setStatus(text, bad = false) {
  $('status').textContent = text;
  $('status').className = bad ? 'bad' : '';
}

async function persist() {
  const info = await saveRules(rules);
  showStorageNotice(info);
}

function showStorageNotice(info) {
  const el = $('storage-notice');
  el.hidden = info.area !== 'local';
  el.textContent =
    info.area === 'local'
      ? 'Rules are saved on this device only: browser sync storage refused them' +
        (info.error ? ` (${info.error})` : '') +
        '. The next save tries sync again.'
      : '';
}

// ---- site access ------------------------------------------------------------

async function hasAccess(rule) {
  try {
    return await chrome.permissions.contains({ origins: originsForRule(rule) });
  } catch {
    return false;
  }
}

function describeOrigins(origins) {
  if (origins.includes(ALL_SITES)) return 'all sites';
  return origins.map((o) => o.replace(/^\*:\/\/\*\./, '').replace(/^https?:\/\//, '').replace(/\/\*$/, '')).join(', ');
}

// Must be called straight from a click handler: the browser only shows the
// permission prompt while it still counts as a user gesture.
async function requestAccess(origins) {
  try {
    return await chrome.permissions.request({ origins });
  } catch (e) {
    setStatus(`Could not request site access: ${e.message}`, true);
    return false;
  }
}

async function refreshAccess() {
  const missing = new Set();
  for (const rule of rules) {
    const badge = document.querySelector(`[data-access="${rule.id}"]`);
    const errors = Object.keys(validateRule(rule)).length;
    const ok = await hasAccess(rule);
    if (!ok && rule.enabled && !errors) originsForRule(rule).forEach((o) => missing.add(o));
    if (!badge) continue;
    badge.hidden = ok && !errors;
    badge.className = 'badge ' + (errors ? 'bad' : 'warn');
    badge.textContent = errors ? 'has errors' : 'no site access';
    badge.title = errors
      ? 'This rule has a problem and will not match. Open it to fix.'
      : `Needs access to ${describeOrigins(originsForRule(rule))}. It will not bookmark automatically until you grant it.`;
  }
  $('access-notice').hidden = missing.size === 0;
  $('access-text').textContent = `Some rules cannot run yet: no access to ${describeOrigins([...missing])}.`;
  $('grant-all').onclick = async () => {
    await requestAccess([...missing]);
    refreshAccess();
  };
}

// ---- rule list --------------------------------------------------------------

function render() {
  const list = $('rules');
  list.replaceChildren();
  editorRefresh = null;
  if (!rules.length && !draft) {
    list.append(h('div', { class: 'empty' }, 'No rules yet. Add one, or start from the Claude Artifacts preset.'));
  }
  rules.forEach((rule, i) => list.append(ruleCard(rule, i)));
  if (draft && draftIsNew) list.append(h('div', { class: 'card' }, editor()));
  refreshAccess();
}

function ruleCard(rule, i) {
  const open = draft && !draftIsNew && draft.id === rule.id;
  let confirmDelete = false;
  const del = h('button', {
    class: 'small danger',
    onclick: async () => {
      if (!confirmDelete) {
        confirmDelete = true;
        del.textContent = 'Really delete?';
        setTimeout(() => {
          confirmDelete = false;
          del.textContent = 'Delete';
        }, 3000);
        return;
      }
      rules = rules.filter((r) => r.id !== rule.id);
      if (open) draft = null;
      await persist();
      render();
      setStatus(`Deleted "${rule.name}".`);
    },
  }, 'Delete');

  const move = async (delta) => {
    const j = i + delta;
    if (j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    await persist();
    render();
  };

  return h('div', { class: 'card' + (rule.enabled ? '' : ' off'), 'data-rule': rule.id },
    h('div', { class: 'summary' },
      h('input', {
        type: 'checkbox',
        title: 'Enabled',
        'aria-label': `Enable ${rule.name}`,
        checked: rule.enabled,
        onchange: async (e) => {
          rule.enabled = e.target.checked;
          if (open) draft.enabled = rule.enabled;
          await persist();
          render();
        },
      }),
      h('div', { class: 'summary-text' },
        h('div', { class: 'name' }, rule.name, h('span', { 'data-access': rule.id, hidden: true })),
        h('div', { class: 'desc' },
          `${MATCH_LABELS[rule.matchType]} `, h('span', { class: 'mono' }, rule.pattern || '(empty)'),
          ' → ', rule.folder)),
      h('div', { class: 'actions' },
        h('button', { class: 'small', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
        h('button', { class: 'small', title: 'Move down', 'aria-label': 'Move down', disabled: i === rules.length - 1, onclick: () => move(1) }, '↓'),
        h('button', {
          class: 'small',
          onclick: () => {
            draft = open ? null : { ...rule };
            draftIsNew = false;
            testInput = { url: '', title: '' };
            render();
          },
        }, open ? 'Close' : 'Edit'),
        del)),
    open ? editor() : null);
}

// ---- editor -----------------------------------------------------------------

function editor() {
  const errEls = {};
  const inputs = {};

  const field = (key, label, input, hint) => {
    inputs[key] = input;
    errEls[key] = h('div', { class: 'err' });
    return h('div', { class: 'field', 'data-field': key },
      h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null, errEls[key]);
  };
  const text = (key, extra = {}) =>
    h('input', {
      type: 'text', id: `f-${key}`, value: draft[key], spellcheck: 'false', autocomplete: 'off', ...extra,
      oninput: (e) => { draft[key] = e.target.value; refresh(); },
    });
  const select = (key, options) => {
    const el = h('select', { id: `f-${key}`, onchange: (e) => { draft[key] = e.target.value; refresh(); } },
      options.map(([v, label]) => h('option', { value: v }, label)));
    el.value = draft[key];
    return el;
  };
  const check = (key, label) =>
    h('label', {}, h('input', {
      type: 'checkbox', checked: draft[key],
      onchange: (e) => { draft[key] = e.target.checked; refresh(); },
    }), label);
  const matchOptions = MATCH_TYPES.map((t) => [t, MATCH_LABELS[t]]);

  const sitesField = field('sites', 'Sites this rule covers', text('sites', { placeholder: 'example.com, another.org' }),
    'This kind of pattern does not name a site, so list the domains it should run on. Leave empty to ask for access to all sites.');
  const templateField = field('titleTemplate', 'Title template', text('titleTemplate'),
    'Placeholders: {title} {host} {date} {url}');
  const accessHint = h('div', { class: 'hint' });

  const folderInput = text('folder', { placeholder: 'Bookmarks bar/Folder/Subfolder' });
  const folderPick = h('select', {
    id: 'folder-pick', 'aria-label': 'Pick an existing folder',
    onchange: (e) => {
      if (!e.target.value) return;
      draft.folder = folderInput.value = e.target.value;
      e.target.value = '';
      refresh();
    },
  }, h('option', { value: '' }, 'Pick existing folder…'));
  listFolderPaths(chrome.bookmarks).then((paths) => folderPick.append(...paths.map((p) => h('option', { value: p }, p))));
  const folderField = field('folder', 'Target folder', folderInput,
    'Pick a folder, or type a path: add "/New folder" to make one inside it. Missing folders are created.');
  const folderRow = h('div', { class: 'with-pick' });
  folderInput.before(folderRow);
  folderRow.append(folderInput, folderPick);

  const testOut = h('div', { class: 'test-out' });
  const testBox = h('div', { class: 'test' },
    h('h3', {}, 'Test'),
    h('input', {
      type: 'text', class: 'mono', id: 'test-url', placeholder: 'Paste a URL to test against this rule',
      'aria-label': 'Test URL', value: testInput.url, spellcheck: 'false',
      oninput: (e) => { testInput.url = e.target.value.trim(); refresh(); },
    }),
    h('input', {
      type: 'text', id: 'test-title', placeholder: 'Page title (optional, used for the bookmark title)',
      'aria-label': 'Test page title', value: testInput.title,
      oninput: (e) => { testInput.title = e.target.value; refresh(); },
    }),
    testOut);

  let testRun = 0;
  async function refreshTest() {
    const run = ++testRun;
    testOut.replaceChildren();
    if (!testInput.url) return;
    const ev = evaluateRule(draft, { url: testInput.url, title: testInput.title || 'Example page title' });
    if (!ev.match) {
      testOut.append(h('span', { class: 'no' }, 'No match'), `: ${REASONS[ev.reason]}.`);
      return;
    }
    const folderNote = h('span', { class: 'hint' });
    testOut.append(
      h('span', { class: 'yes' }, 'Match'),
      h('dl', {},
        h('dt', {}, 'Bookmark URL'), h('dd', { class: 'mono' }, ev.url),
        h('dt', {}, 'Folder'), h('dd', {}, draft.folder.trim(), ' ', folderNote),
        h('dt', {}, 'Title'), h('dd', {}, ev.title)));
    try {
      const folder = await resolveFolder(chrome.bookmarks, draft.folder, false);
      if (run === testRun) folderNote.textContent = folder ? '(exists)' : '(will be created)';
    } catch {
      // Folder path is empty; the field error already says so.
    }
  }

  function refresh() {
    const errors = validateRule(draft);
    for (const key of Object.keys(errEls)) {
      errEls[key].textContent = errors[key] || '';
      inputs[key].classList.toggle('invalid', !!errors[key]);
    }
    sitesField.hidden = canDeriveOrigins(draft);
    templateField.hidden = draft.titleMode !== 'template';
    accessHint.textContent = `Saving asks the browser for access to: ${describeOrigins(originsForRule(draft))}.`;
    refreshTest();
    return errors;
  }
  editorRefresh = refresh;

  async function save() {
    draft.cooldownSec = Number(draft.cooldownSec);
    const errors = refresh();
    if (Object.keys(errors).length) {
      setStatus('Fix the highlighted fields first.', true);
      return;
    }
    // First await in the click handler, so the prompt is allowed to show.
    const granted = await requestAccess(originsForRule(draft));
    const saved = sanitizeRule(draft);
    rules = draftIsNew ? [...rules, saved] : rules.map((r) => (r.id === saved.id ? saved : r));
    draft = null;
    await persist();
    render();
    setStatus(granted
      ? `Saved "${saved.name}".`
      : `Saved "${saved.name}", but site access was not granted, so it will not bookmark automatically.`, !granted);
  }

  const el = h('div', { class: 'editor' },
    field('name', 'Name', text('name')),
    h('div', { class: 'row' },
      field('matchType', 'Match', select('matchType', matchOptions)),
      field('pattern', 'Pattern', text('pattern', { class: 'mono', placeholder: 'https://example.com/docs/' }),
        'Prefix, contains and regex are case-sensitive and test the full URL.')),
    h('div', { class: 'row' },
      field('excludeType', 'Exclude', select('excludeType', matchOptions)),
      field('excludePattern', 'Exclude pattern (optional)', text('excludePattern', { class: 'mono' }),
        'A page that matches this is skipped.')),
    sitesField,
    folderField,
    h('div', { class: 'row' },
      field('titleMode', 'Bookmark title', select('titleMode', [['title', 'Tab title'], ['url', 'Page URL'], ['template', 'Template']])),
      templateField),
    h('div', { class: 'row' },
      field('cooldownSec', 'Cooldown (seconds)', h('input', {
        type: 'number', id: 'f-cooldownSec', min: '0', max: '3600', step: '1', value: draft.cooldownSec,
        oninput: (e) => { draft.cooldownSec = e.target.value === '' ? NaN : Number(e.target.value); refresh(); },
      }), 'Ignore repeat events for the same page within this time.'),
      h('div', { class: 'field' },
        h('label', {}, 'Before bookmarking'),
        h('div', { class: 'checks' }, check('stripHash', 'Strip #hash'), check('stripQuery', 'Strip ?query')))),
    testBox,
    accessHint,
    h('div', { class: 'editor-buttons' },
      h('button', { class: 'primary', id: 'save-rule', onclick: save }, 'Save rule'),
      h('button', { onclick: () => { draft = null; render(); } }, 'Cancel')));
  refresh();
  return el;
}

// ---- toolbar ----------------------------------------------------------------

$('add').addEventListener('click', () => {
  draft = sanitizeRule({ name: 'New rule' });
  draftIsNew = true;
  testInput = { url: '', title: '' };
  render();
  $('f-name').focus();
  $('f-name').select();
});

$('preset').addEventListener('click', async () => {
  const preset = presetClaudeArtifacts();
  if (rules.some((r) => r.matchType === preset.matchType && r.pattern === preset.pattern && r.folder === preset.folder)) {
    setStatus('The Claude Artifacts rule is already in the list.');
    return;
  }
  const granted = await requestAccess(originsForRule(preset));
  rules = [...rules, preset];
  await persist();
  render();
  setStatus(granted
    ? 'Added the Claude Artifacts rule.'
    : 'Added the Claude Artifacts rule, but access to claude.ai was not granted, so it will not bookmark automatically.', !granted);
});

$('export').addEventListener('click', () => {
  const data = { app: 'auto-bookmark-rules', version: 1, rules };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  h('a', { href: url, download: 'auto-bookmark-rules.json' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Exported ${rules.length} rule${rules.length === 1 ? '' : 's'}.`);
});

$('import').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let list;
  try {
    const data = JSON.parse(await file.text());
    list = Array.isArray(data) ? data : data && data.rules;
    if (!Array.isArray(list)) throw new Error('no "rules" list in the file');
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
    return;
  }
  const replace = $('import-replace').checked;
  const taken = new Set(replace ? [] : rules.map((r) => r.id));
  const imported = list.map((raw) => {
    const rule = sanitizeRule(raw);
    if (taken.has(rule.id)) rule.id = newId();
    taken.add(rule.id);
    return rule;
  });
  const broken = imported.filter((r) => Object.keys(validateRule(r)).length).length;
  rules = replace ? imported : [...rules, ...imported];
  draft = null;
  await persist();
  render();
  setStatus(`Imported ${imported.length} rule${imported.length === 1 ? '' : 's'}` +
    (broken ? `; ${broken} with errors, open them to fix.` : '.'), broken > 0);
});

$('paused').addEventListener('change', (e) => setPaused(e.target.checked));
$('toast').addEventListener('change', (e) => setToastEnabled(e.target.checked));

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.paused) $('paused').checked = changes.paused.newValue === true;
  if (area === 'local' && changes.toast) $('toast').checked = changes.toast.newValue !== false;
  // Rules changed somewhere else (another device through sync). Don't yank the
  // list out from under an open editor.
  if (!draft && Object.keys(changes).some(isRuleKey)) {
    const loaded = await loadRules();
    if (JSON.stringify(loaded.rules) !== JSON.stringify(rules)) {
      rules = loaded.rules;
      render();
    }
  }
});
chrome.permissions.onAdded.addListener(refreshAccess);
chrome.permissions.onRemoved.addListener(refreshAccess);

(async () => {
  const loaded = await loadRules();
  rules = loaded.rules;
  showStorageNotice({ area: loaded.area });
  $('paused').checked = await getPaused();
  $('toast').checked = await getToastEnabled();
  render();
})();
