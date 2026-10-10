// In-memory stand-ins for the chrome.* APIs the logic uses.

// Mirrors Chrome's tree: root "0" -> "1" Bookmarks bar, "2" Other bookmarks.
export function fakeBookmarks({ barTitle = 'Bookmarks bar', folderTypes = true } = {}) {
  let nextId = 10;
  const nodes = new Map();
  const add = (node) => {
    nodes.set(node.id, node);
    return node;
  };
  add({ id: '0', title: '' });
  add({ id: '1', parentId: '0', title: barTitle, ...(folderTypes ? { folderType: 'bookmarks-bar' } : {}) });
  add({ id: '2', parentId: '0', title: 'Other bookmarks', ...(folderTypes ? { folderType: 'other' } : {}) });
  const childrenOf = (id) => [...nodes.values()].filter((n) => n.parentId === id);
  const tree = (n) => (n.url ? { ...n } : { ...n, children: childrenOf(n.id).map(tree) });
  return {
    nodes,
    calls: { create: 0 },
    async getTree() {
      return [tree(nodes.get('0'))];
    },
    async getChildren(id) {
      return childrenOf(id).map((n) => ({ ...n }));
    },
    async search(query) {
      // The real API matches a url query verbatim.
      return [...nodes.values()].filter((n) => n.url && n.url === query.url).map((n) => ({ ...n }));
    },
    async create({ parentId, title, url }) {
      if (parentId === '0') throw new Error("Can't modify the root bookmark folders.");
      if (!nodes.has(parentId)) throw new Error("Can't find parent bookmark for id.");
      this.calls.create++;
      return { ...add({ id: String(nextId++), parentId, title, ...(url ? { url } : {}) }) };
    },
    // Test helpers
    urlsIn(folderId) {
      return childrenOf(folderId).filter((n) => n.url).map((n) => n.url);
    },
    folderByPath(...titles) {
      let id = '0';
      for (const t of titles) {
        const next = childrenOf(id).find((n) => !n.url && n.title === t);
        if (!next) return null;
        id = next.id;
      }
      return nodes.get(id);
    },
  };
}

// One chrome.storage area. `quotaBytesPerItem` makes set() reject the way sync
// does when an item is too large; `failAll` rejects every write.
export function fakeArea({ quotaBytesPerItem = Infinity, failAll = false } = {}) {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      if (failAll) throw new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
      for (const [k, v] of Object.entries(items)) {
        if (k.length + JSON.stringify(v).length > quotaBytesPerItem) {
          throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
        }
      }
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}
