/**
 * PRD-6 — a TINY, hermetic fixture DOM for the selector tests.
 *
 * This package has NO DOM library available (no jsdom/happy-dom) and installs
 * nothing, so the selector tests cannot use a real `document`. Instead this
 * module parses a captured Meet HTML fixture into a minimal node tree that
 * implements EXACTLY the read-only {@link ParentNode}/`Element` surface the
 * selectors in ../selectors.ts touch:
 *   - querySelector / querySelectorAll
 *   - matches
 *   - getAttribute
 *   - textContent
 *
 * It supports the small CSS-selector subset the selectors use: a comma list of
 * compound selectors, each a (possibly descendant-combined) chain of simple
 * selectors built from `tag`, `.class`, `#id`, `[attr]`, and `[attr='value']`
 * (also `[attr="value"]`). This is a TEST DOUBLE, not a general HTML/CSS engine
 * — it is intentionally small and is the documented hermetic substitute for a
 * live Meet page. The production selectors run against a real browser DOM, which
 * is a strict superset of this surface.
 */

interface RawAttrs {
  [name: string]: string;
}

class FakeElement {
  readonly tag: string;
  readonly attrs: RawAttrs;
  readonly children: FakeElement[] = [];
  text = "";
  parent: FakeElement | null = null;

  constructor(tag: string, attrs: RawAttrs) {
    this.tag = tag.toLowerCase();
    this.attrs = attrs;
  }

  getAttribute(name: string): string | null {
    const v = this.attrs[name.toLowerCase()];
    return v === undefined ? null : v;
  }

  get textContent(): string {
    let acc = this.text;
    for (const c of this.children) acc += c.textContent;
    return acc;
  }

  /** All descendants in document order (excludes self). */
  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const c of el.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  matches(selector: string): boolean {
    return parseSelectorList(selector).some((compound) =>
      matchesCompoundChain(this, compound),
    );
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const compounds = parseSelectorList(selector);
    const candidates = this.descendants();
    return candidates.filter((el) =>
      compounds.some((chain) => matchesChainEndingAt(el, chain)),
    );
  }
}

// --- selector parsing (the small subset) ------------------------------------

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

/** A descendant chain, e.g. `div[role=list] span.zWGUib` => [div[...], span.zWGUib]. */
type SelectorChain = SimpleSelector[];

function parseSelectorList(list: string): SelectorChain[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseChain);
}

function parseChain(chain: string): SelectorChain {
  return chain
    .split(/\s+/)
    .filter(Boolean)
    .map(parseSimple);
}

function parseSimple(token: string): SimpleSelector {
  const sel: SimpleSelector = { classes: [], attrs: [] };
  // Pull out [attr] / [attr='v'] / [attr="v"] groups first.
  const attrRe = /\[([a-zA-Z0-9_-]+)(?:\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]/g;
  let m: RegExpExecArray | null;
  let rest = token;
  while ((m = attrRe.exec(token)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name) continue;
    const value = m[2] ?? m[3] ?? m[4];
    sel.attrs.push(value === undefined ? { name } : { name, value });
  }
  rest = token.replace(attrRe, "");
  // Now parse tag / #id / .class from what remains.
  const partRe = /([.#]?)([a-zA-Z0-9_-]+)/g;
  let p: RegExpExecArray | null;
  while ((p = partRe.exec(rest)) !== null) {
    const prefix = p[1] ?? "";
    const ident = p[2] ?? "";
    if (!ident) continue;
    if (prefix === ".") sel.classes.push(ident);
    else if (prefix === "#") sel.id = ident;
    else sel.tag = ident.toLowerCase();
  }
  return sel;
}

function matchesSimple(el: FakeElement, sel: SimpleSelector): boolean {
  if (sel.tag && el.tag !== sel.tag) return false;
  if (sel.id && el.getAttribute("id") !== sel.id) return false;
  if (sel.classes.length > 0) {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    for (const c of sel.classes) if (!cls.includes(c)) return false;
  }
  for (const a of sel.attrs) {
    const actual = el.getAttribute(a.name);
    if (actual === null) return false;
    if (a.value !== undefined && actual !== a.value) return false;
  }
  return true;
}

/** Does this element (as the rightmost) satisfy the descendant chain? */
function matchesChainEndingAt(el: FakeElement, chain: SelectorChain): boolean {
  const last = chain[chain.length - 1];
  if (!last) return false;
  if (!matchesSimple(el, last)) return false;
  // Walk up the ancestor chain matching the remaining simple selectors in order.
  let ancestorIdx = chain.length - 2;
  let cur = el.parent;
  while (ancestorIdx >= 0 && cur) {
    const want = chain[ancestorIdx];
    if (want && matchesSimple(cur, want)) ancestorIdx -= 1;
    cur = cur.parent;
  }
  return ancestorIdx < 0;
}

/** For `el.matches(sel)`: the whole chain must end at `el`. */
function matchesCompoundChain(el: FakeElement, chain: SelectorChain): boolean {
  return matchesChainEndingAt(el, chain);
}

// --- minimal HTML parser ------------------------------------------------------

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Parse a fragment of HTML into a root {@link FakeElement} (a synthetic
 * `<root>`). Handles tags, attributes (single/double/unquoted), void/self-closing
 * elements, and text. Ignores comments. Sufficient for hand-authored Meet
 * fixtures — NOT a spec-compliant parser.
 */
export function parseFixtureHtml(html: string): ParentNode {
  const root = new FakeElement("root", {});
  const stack: FakeElement[] = [root];
  let i = 0;
  const n = html.length;

  const top = (): FakeElement => stack[stack.length - 1] ?? root;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      top().text += html.slice(i);
      break;
    }
    if (lt > i) {
      top().text += html.slice(i, lt);
    }
    // Comment?
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Doctype / processing — skip to '>'.
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      top().text += html.slice(lt);
      break;
    }
    const rawTag = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (rawTag.startsWith("/")) {
      // Closing tag — pop to the matching open (best-effort).
      const name = rawTag.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s]?.tag === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const { tag, attrs } = parseTag(body);
    const el = new FakeElement(tag, attrs);
    el.parent = top();
    top().children.push(el);
    if (!selfClosing && !VOID_TAGS.has(el.tag)) {
      stack.push(el);
    }
  }

  return root as unknown as ParentNode;
}

function parseTag(body: string): { tag: string; attrs: RawAttrs } {
  const spaceIdx = body.search(/\s/);
  if (spaceIdx === -1) return { tag: body.toLowerCase(), attrs: {} };
  const tag = body.slice(0, spaceIdx).toLowerCase();
  const attrStr = body.slice(spaceIdx + 1);
  const attrs: RawAttrs = {};
  const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrStr)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[name] = value;
  }
  return { tag, attrs };
}
