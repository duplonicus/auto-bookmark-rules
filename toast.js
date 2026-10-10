// The one thing this extension ever puts into a web page: a small "Bookmarked"
// toast. The service worker injects this function with chrome.scripting, so it
// must be self-contained (no imports, no outer variables). It reads nothing
// from the page and all text is set as text, never as HTML.

export function showToast(folders) {
  const ATTR = 'data-auto-bookmark-rules-toast';
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.remove());

  const host = document.createElement('div');
  host.setAttribute(ATTR, '');
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .toast {
      font: 13px/1.4 system-ui, sans-serif; max-width: 340px; padding: 10px 14px; border-radius: 8px;
      background: #ffffff; color: #1c1c22; border: 1px solid #d9d9e0; border-left: 4px solid #4f46e5;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .18); overflow-wrap: anywhere;
      opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s;
    }
    .toast.in { opacity: 1; transform: none; }
    .head { font-weight: 600; }
    .folder { color: #62626e; }
    @media (prefers-color-scheme: dark) {
      .toast { background: #212127; color: #ececf1; border-color: #3a3a44; border-left-color: #8b85ff; }
      .folder { color: #a0a0ad; }
    }
    @media (prefers-reduced-motion: reduce) { .toast { transition: none; transform: none; } }
  `;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = 'Bookmarked';
  toast.append(head);
  for (const folder of folders) {
    const line = document.createElement('div');
    line.className = 'folder';
    line.textContent = `→ ${folder}`;
    toast.append(line);
  }
  root.append(style, toast);
  (document.body || document.documentElement).append(host);

  requestAnimationFrame(() => toast.classList.add('in'));
  setTimeout(() => toast.classList.remove('in'), 3700);
  setTimeout(() => host.remove(), 4000);
}
