/**
 * mini-dom.mjs — the smallest DOM that js/ui/next-up.js can actually run on.
 *
 * The Next Up panel is worth testing through its real rendering path: the bugs
 * it has had are staleness bugs, and staleness only shows up in what ends up on
 * screen. So rather than reaching into module internals, this installs a
 * `document` with just enough behaviour for the module to render into, and lets
 * the test read the rows back out.
 *
 * Not a general-purpose DOM. `innerHTML` is parsed with a regex tuned to the
 * exact markup _buildRow() emits — one flat list of `.nu-row` divs, each with a
 * `.nu-value` and a `.nu-time` span. That is fine for what it is for, and it
 * fails loudly (no rows parsed) if the markup ever stops matching.
 */

class MiniEl {
  constructor(className = '') {
    this.className = className;
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.children = [];
    this.classList = {
      _s: new Set(className.split(/\s+/).filter(Boolean)),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
    };
  }

  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = parseRows(this._html); }

  addEventListener() {}

  querySelectorAll(sel) {
    const want = sel.replace(/^\./, '');
    return this.children.filter(c => c.classList.contains(want));
  }

  querySelector(sel) {
    const want = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (c.classList.contains(want)) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
}

const ROW_RE   = /<div class="(nu-row[^"]*)" data-key="([^"]*)"[^>]*>([\s\S]*?)<\/div><\/div>/g;
const SPAN_RE  = /<span class="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g;

function parseRows(html) {
  const rows = [];
  ROW_RE.lastIndex = 0;
  let m;
  while ((m = ROW_RE.exec(html)) !== null) {
    const row = new MiniEl(m[1]);
    row.dataset.key = unesc(m[2]);
    SPAN_RE.lastIndex = 0;
    let s;
    while ((s = SPAN_RE.exec(m[3])) !== null) {
      const span = new MiniEl(s[1]);
      span.textContent = unesc(s[2]);
      row.children.push(span);
    }
    rows.push(row);
  }
  return rows;
}

function unesc(str) {
  return String(str).replace(/&quot;/g, '"').replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** Install a fake `document` (and `localStorage`) on globalThis. */
export function installMiniDom(ids = []) {
  const els = new Map();
  for (const id of ids) els.set(id, new MiniEl());
  globalThis.document = {
    getElementById: id => els.get(id) || null,
    querySelectorAll: () => [],
  };
  if (!globalThis.localStorage) {
    globalThis.localStorage = {
      _d: {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    };
  }
  return {
    el: id => els.get(id),
    /** Rows currently rendered, as plain { key, verb, value, time } records. */
    rows() {
      const list = els.get('nu-list');
      if (!list) return [];
      return list.querySelectorAll('.nu-row').map(r => ({
        key:   r.dataset.key,
        verb:  textOf(r, 'nu-verb'),
        value: textOf(r, 'nu-value'),
        time:  textOf(r, 'nu-time'),
      }));
    },
  };
}

function textOf(row, cls) {
  const el = row.children.find(c => c.classList.contains(cls));
  return el ? el.textContent : null;
}
