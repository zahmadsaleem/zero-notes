/* Local Text Notes. Load as a classic script with defer. */
(() => {
  "use strict";

  const script = document.currentScript;
  const excluded = "script, style, noscript, template, [hidden], local-text-notes, local-text-notes-inline";
  const annotationExcluded = '[data-local-notes-ignore], input, textarea, select, button, [contenteditable]:not([contenteditable="false"])';
  const extensionStateEvent = "local-text-notes-extension-state";
  const extensionSelector = "local-text-notes[data-extension]";
  const wordSegmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

  function firstIndex(items, test) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (test(items[mid])) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Map normalized, searchable text to DOM offsets without wrapping text nodes.
  function indexText(root, annotating) {
    const parts = [];
    const runs = [];
    const blocks = [];
    let block = null;
    let position = 0;
    let space = false;

    function addText(node) {
      for (const match of node.data.matchAll(/\s+|\S+/gu)) {
        const value = match[0];
        if (/^\s/u.test(value)) {
          space = Boolean(block);
          continue;
        }
        if ((space || !block) && position) {
          parts.push(" ");
          position++;
        }
        if (!block) {
          block = { start: position, end: position };
          blocks.push(block);
        }
        parts.push(value);
        runs.push({ node, offset: match.index, start: position, end: position + value.length });
        position += value.length;
        block.end = position;
        space = false;
      }
    }

    function walk(element) {
      if (element.matches(excluded) || (annotating && element.matches(annotationExcluded))) return;
      const style = getComputedStyle(element);
      if (style.display === "none") return;
      const separates = element.localName === "br"
        || (style.display !== "contents" && !style.display.startsWith("inline"));
      if (separates) block = null;
      const closed = element.localName === "details" && !element.open;
      const summary = closed && Array.from(element.children).find(child => child.localName === "summary");
      for (const child of element.childNodes) {
        if (closed && child !== summary) continue;
        if (child.nodeType === Node.ELEMENT_NODE) walk(child);
        else if (child.nodeType === Node.TEXT_NODE && style.visibility === "visible") addText(child);
      }
      if (separates) block = null;
    }

    walk(root);
    return { text: parts.join(""), runs, blocks };
  }

  function offsetsFor(index, range) {
    const { runs } = index;
    const start = range.cloneRange();
    const end = range.cloneRange();
    start.collapse(true);
    end.collapse(false);
    const first = runs[firstIndex(runs, run => start.comparePoint(run.node, run.offset + run.end - run.start) > 0)];
    const last = runs[firstIndex(runs, run => end.comparePoint(run.node, run.offset) >= 0) - 1];
    if (!first || !last) return null;
    const from = first.start + (range.startContainer === first.node ? Math.max(0, range.startOffset - first.offset) : 0);
    const to = last.end - (range.endContainer === last.node
      ? Math.max(0, last.offset + last.end - last.start - range.endOffset)
      : 0);
    return from < to ? { from, to } : null;
  }

  function rangeFor(index, { from, to }) {
    const first = index.runs[firstIndex(index.runs, run => run.end > from)];
    const last = index.runs[firstIndex(index.runs, run => run.end >= to)];
    const range = document.createRange();
    range.setStart(first.node, first.offset + from - first.start);
    range.setEnd(last.node, last.offset + to - last.start);
    return range;
  }

  function fingerprint(index) {
    if (index.fingerprint === undefined) {
      let hash = 2166136261;
      for (let i = 0; i < index.text.length; i++) {
        hash = Math.imul(hash ^ index.text.charCodeAt(i), 16777619);
      }
      index.fingerprint = `${index.text.length}:${hash >>> 0}`;
    }
    return index.fingerprint;
  }

  function anchorFor(index, { from, to }) {
    const exact = index.text.slice(from, to);
    return {
      exact,
      before: index.text.slice(Math.max(0, from - 72), from),
      after: index.text.slice(to, to + 72),
      position: from,
      repeated: index.text.indexOf(exact) !== from || index.text.indexOf(exact, from + 1) !== -1,
      fingerprint: fingerprint(index)
    };
  }

  function locate(index, anchor) {
    const { text } = index;
    const { exact, position, before, after } = anchor;
    if (fingerprint(index) === anchor.fingerprint && text.startsWith(exact, position)) {
      return { from: position, to: position + exact.length };
    }
    let best = null;
    let bestScore = -1;
    let tied = false;
    for (let from = text.indexOf(exact); from !== -1; from = text.indexOf(exact, from + 1)) {
      const to = from + exact.length;
      let left = 0;
      let right = 0;
      while (left < before.length && before.at(-1 - left) === text[from - 1 - left]) left++;
      while (right < after.length && after[right] === text[to + right]) right++;
      // A remaining copy of a repeated quote may belong to a different passage.
      if (anchor.repeated && left < 12 && right < 12) continue;
      const score = left + right;
      if (score > bestScore) {
        bestScore = score;
        best = { from, to };
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  function textDirective(index, selection) {
    const { text, blocks } = index;
    const fromBlock = offset => firstIndex(blocks, block => block.end > offset);
    const startBlock = fromBlock(selection.from);
    const endBlock = fromBlock(selection.to - 1);
    const segmentCache = new Map();

    function wordEdge(offset, side) {
      const blockIndex = fromBlock(offset);
      const block = blocks[blockIndex];
      if (!block || offset < block.start) return offset;
      if (!segmentCache.has(blockIndex)) {
        const value = text.slice(block.start, block.end);
        segmentCache.set(blockIndex, wordSegmenter?.segment(value) || value);
      }
      const segments = segmentCache.get(blockIndex);
      if (typeof segments === "string") {
        const left = segments.slice(0, offset - block.start).match(/[\p{L}\p{M}\p{N}_]+$/u)?.[0] || "";
        const right = segments.slice(offset - block.start).match(/^[\p{L}\p{M}\p{N}_]+/u)?.[0] || "";
        if (!right) return offset;
        return side === "start" ? offset - left.length : offset + right.length;
      }
      const segment = segments.containing(offset - block.start);
      if (!segment?.isWordLike) return offset;
      const start = block.start + segment.index;
      return side === "start" ? start : start + segment.segment.length;
    }

    const from = wordEdge(selection.from, "start");
    const to = Math.max(selection.to, wordEdge(selection.to - 1, "end"));
    const quote = text.slice(from, to);
    const prefixEnd = from - (text[from - 1] === " " ? 1 : 0);
    const suffixStart = to + (text[to] === " " ? 1 : 0);
    const prefixBlock = blocks[fromBlock(prefixEnd - 1)];
    const suffixBlock = blocks[fromBlock(suffixStart)];
    const encode = value => encodeURIComponent(value.toWellFormed?.() ?? value).replace(/-/g, "%2D");
    const terms = new Map();

    function matches(term) {
      if (!terms.has(term)) {
        const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const positions = [];
        for (const match of text.matchAll(new RegExp(`(?=${literal})`, "giu"))) {
          const start = match.index;
          const end = start + term.length;
          const block = blocks[fromBlock(start)];
          if (block && end <= block.end && wordEdge(start, "start") === start
            && wordEdge(end, "start") === end) {
            positions.push(start);
          }
        }
        terms.set(term, positions);
      }
      return terms.get(term);
    }

    function pointsToSelection(start, end, prefix, suffix) {
      const starts = matches(start);
      const ends = end ? matches(end) : null;
      const prefixes = prefix ? new Set(matches(prefix)) : null;
      const suffixes = suffix ? new Set(matches(suffix)) : null;
      let found = false;
      for (const startAt of starts) {
        const before = startAt - (text[startAt - 1] === " " ? 1 : 0);
        if (prefixes && !prefixes.has(before - prefix.length)) continue;
        let endAt = startAt + start.length;
        if (ends) {
          let i = firstIndex(ends, position => position >= endAt);
          while (i < ends.length) {
            endAt = ends[i] + end.length;
            const after = endAt + (text[endAt] === " " ? 1 : 0);
            if (!suffixes || suffixes.has(after)) break;
            i++;
          }
          if (i === ends.length) continue;
        } else {
          const after = endAt + (text[endAt] === " " ? 1 : 0);
          if (suffixes && !suffixes.has(after)) continue;
        }
        if (found || startAt !== from || endAt !== to) return false;
        found = true;
      }
      return found;
    }

    function tryTerms(start, end = "") {
      if (pointsToSelection(start, end, "", "")) return [encode(start), end && encode(end)].filter(Boolean).join(",");
      for (const size of [24, 64, 144]) {
        const prefix = prefixBlock && text.slice(wordEdge(Math.max(prefixBlock.start, prefixEnd - size), "start"), prefixEnd).trim();
        const suffix = suffixBlock && text.slice(suffixStart, wordEdge(Math.min(suffixBlock.end, suffixStart + size), "start")).trim();
        for (const [left, right] of [[prefix, ""], ["", suffix], [prefix, suffix]]) {
          if ((left || right) && pointsToSelection(start, end, left, right)) {
            return [left && `${encode(left)}-`, encode(start), end && encode(end), right && `-${encode(right)}`]
              .filter(Boolean).join(",");
          }
        }
      }
      return null;
    }

    if (startBlock === endBlock && quote.length <= 300) {
      const exact = tryTerms(quote);
      if (exact) return exact;
    }
    for (const size of [24, 64, 144]) {
      const startEnd = Math.min(blocks[startBlock].end, from + size, to);
      const endStart = Math.max(blocks[endBlock].start, to - size, from);
      const start = text.slice(from, Math.max(startEnd, wordEdge(startEnd - 1, "end"))).trimEnd();
      const end = text.slice(wordEdge(endStart, "start"), to).trimStart();
      if (start.length + end.length <= quote.length) {
        const directive = tryTerms(start, end);
        if (directive) return directive;
      }
    }
    return null;
  }

  function element(tag, className, label) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (label) item.textContent = label;
    return item;
  }

  function button(label, action, className = "", key = label) {
    const control = element("button", className, label);
    control.type = "button";
    control.dataset.focusKey = key;
    control.addEventListener("click", action);
    return control;
  }

  const logoSource = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAGKADAAQAAAABAAAAGAAAAADiNXWtAAADkklEQVRIDe1UTWxUVRT+7n3vzUz7OsUG6UixrU3DTyJKYiHEFhJDwASjkQ2JKxNj1IVxZeKCBNkQYkwMC9gRd6yILlgQWBirIaht0oCoiUGkqEzpdAi10+kwb9579/Kd9wrMTJvg0gUneS/33XPu953znXMf8MQeo4B6jP8/ua0d8XC7Yz1CbIKnCwjjK2rw0m9yeFUCOw4X68c6kNNdMJl10HqYzwiUMwCrPcCtc92ANVkgLsA2+mHCfjhRN7iDangTJt6mNk5U3Acp2hu7X0S28z3E3hYotwDoNeTPkyqPLtetlSNc/X0JsCFe2GTgF5hb0CB+xCcmjAFCy7UgqgK87FouHhHA2s/QGe9HjYcMAx88GeDsmXl8fKyIm7cCOY3nns3gi0N9eHN/D9BgbLOlnw6CUGqBlpe1Bx2+BrBYB+okaIRAxMy0wfSf9/DhkVv4eybEru157NqRxz+zEfdmMH2DhO4qKmt4yCqyLxOgXO5gN/JSZYt5Cl+fX0BxNsTWzTmc+3II504NYbg/i2IpxFcXFgDGtJhUkNGKWMOyn1SAhQY1x9OsQvYeWWQx8XONJQK7R3z4fRl8P1llBQ1kCDwpPsasMOLzTK/spwQgm6c6WypgjAksbpcpF9cDGzKo3Ynw6fESBkmkCSI+iVl9FlWiR0qgKY+wtlnI7Or1FKCn28HnJ2bxzDoX77+1lgNkEp/ErDAZEIt52U/HVGnO9IowKHIqpiByfHOpismrtaQP3/1YTdQUn8SsMCHVmJH9tAJjlpKxbIv0CNztaziOYkP/xdsHerD5JR9zdzlhxBCfxLSYfEY2RkOXZD8lgBO06C8eAqisxlB/BkFg8PzGHD75gH3jZbo2zfGkX3wS01J9yhcgpxabCAwj5bPNuLdvLJ/oMF+JMfVrDRfHKxj/qQrN+d87Kr62MySmKYRRknzaA6u6QBkQp96HR9jI1/etwSs7fXz7QxWvvTuduCqLMfYQ/I1X+Tdpv8lCaNlbZRPq5SazB3ZZrYfoXHDQfOp8+vggjp4sYeLyUjJsY7wThz/qhf8UMUIG6abERLE6LqoyigKVsNjro70ch1/Q5fQmP6ykAULAg9QfsZGu1qpL8Zw19k7eVxWSz0RhPEcE3jYdkdlojUArXUTNXFDbp3jNmxS0f4y+bBzzjgrNBhvbKl1/Ef6ajc11F6YE37uLXLSIvql7zKopZYF5Yv9nBe4DI+9lle3hiZ0AAAAASUVORK5CYII=";
  const paths = {
    close: "M4 4l8 8m0-8-8 8",
    chevron: "m6 3.5 4 4.5-4 4.5",
    comment: "M2.5 3.5h11v7H8l-3 2.5v-2.5H2.5z",
    highlight: "m4 9 3 3m-3-3 6-6 3 3-6 6H4Zm-2 5h9",
    resolve: "m5 8 2 2 4-4",
    reopen: "M5.3 7a2.8 2.8 0 1 1 .6 3.2m-.6-5v2h2",
    delete: "m6 6 4 4m0-4-4 4",
    jump: "M9 3.5h3.5V7m0-3.5-6 6m5.5-.5v3.5H3.5V4H7",
    link: "m6.5 9.5 3-3M6 6 3.5 8.5a2.8 2.8 0 0 0 4 4L10 10M6 6l2.5-2.5a2.8 2.8 0 0 1 4 4L10 10",
    trash: "M3 4.5h10m-6.5 0V3h3v1.5M4.5 5l.7 8h5.6l.7-8m-5 2.3v3.4m3-3.4v3.4"
  };

  function icon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.35");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (["resolve", "reopen", "delete"].includes(name)) {
      const circle = document.createElementNS(namespace, "circle");
      circle.setAttribute("cx", "8");
      circle.setAttribute("cy", "8");
      circle.setAttribute("r", "6.3");
      svg.append(circle);
    }
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    return svg;
  }

  function iconButton(label, glyph, action, key) {
    const control = button("", action, "icon", key || label);
    control.setAttribute("aria-label", label);
    control.title = label;
    control.append(icon(glyph));
    return control;
  }

  function logo(size) {
    const image = element("img", "logo");
    image.width = size;
    image.height = size;
    image.alt = "";
    image.src = logoSource;
    return image;
  }

  function makeStyle(css) {
    const style = element("style");
    if (script?.nonce) style.nonce = script.nonce;
    style.textContent = css;
    return style;
  }

  function pageStorage(key, signal) {
    const read = () => JSON.parse(localStorage.getItem(key) || "[]");
    return {
      read,
      update(transform) {
        const commit = () => {
          signal.throwIfAborted();
          const next = transform(read());
          localStorage.setItem(key, JSON.stringify(next));
          return next;
        };
        if (!navigator.locks) return commit();
        let ran = false;
        return navigator.locks.request(key, { signal }, () => {
          ran = true;
          return commit();
        }).catch(error => {
          if (ran || signal.aborted) throw error;
          return commit();
        });
      },
      subscribe(listener) {
        window.addEventListener("storage", event => {
          if (event.key === key || event.key === null) listener();
        }, { signal });
      }
    };
  }

  function start({ signal = new AbortController().signal, storage: extensionStorage } = {}) {
    if (document.querySelector(extensionStorage ? extensionSelector : "local-text-notes")) return;
    const scope = script?.dataset.scope ? document.querySelector(script.dataset.scope) : document.body;
    if (!scope || signal.aborted) return;
    const storageKey = `local-text-notes:v1:${script?.dataset.pageKey || location.pathname + location.search}`;
    const storage = extensionStorage || pageStorage(storageKey, signal);
    const canHighlight = Boolean(window.CSS?.highlights && window.Highlight);
    const prefix = extensionStorage ? "local-text-notes-extension" : "local-text-notes";
    const markName = `${prefix}-mark`;
    const commentName = `${prefix}-comment`;
    const activeName = `${prefix}-active`;
    const compact = matchMedia("(max-width: 760px)");
    const railAttribute = "data-local-text-notes-rail";
    const root = document.documentElement;
    const cards = new Map();
    const drafts = new Map();
    const host = element("local-text-notes");
    if (extensionStorage) host.setAttribute("data-extension", "");
    const ui = host.attachShadow({ mode: extensionStorage ? "closed" : "open" });
    const inline = element("local-text-notes-inline");
    const inlineRoot = inline.attachShadow({ mode: extensionStorage ? "closed" : "open" });
    const panel = element("aside", "panel");
    panel.id = "notes-panel";
    panel.setAttribute("aria-labelledby", "notes-title");
    panel.hidden = true;
    const heading = element("h2", "", "Notes");
    heading.id = "notes-title";
    heading.tabIndex = -1;
    heading.dataset.focusKey = "title";
    const headingCount = element("span", "count");
    const header = element("header");
    header.append(logo(24), heading, headingCount, iconButton("Hide notes", "close", close));
    const notice = element("div");
    const railViewport = element("div", "rail-scroll");
    const track = element("div", "rail-track");
    railViewport.append(track);
    panel.append(header, notice, railViewport);
    const toolbar = element("div", "toolbar");
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Mark up selected text");
    toolbar.hidden = true;
    const status = element("div", "status");
    status.setAttribute("role", "status");
    status.hidden = true;
    const launcherLabel = element("span", "", "Show notes");
    const launcher = button("", () => open ? close() : show("all"), "launcher");
    launcher.append(logo(20), launcherLabel);
    launcher.setAttribute("aria-controls", panel.id);
    launcher.setAttribute("aria-expanded", "false");
    let notes = [];
    let persistent = true;
    let index = null;
    let attached = new Map();
    let view = "all";
    let pending = null;
    let open = false;
    let resolved = false;
    let layoutFrame = 0;
    let revealFrame = 0;
    let lastScroll;
    let removing = false;
    let busy = false;
    let readVersion = 0;
    let refreshPending = false;
    let selecting = false;
    let selectionFrame = 0;
    let refreshTimer = 0;
    let statusTimer = 0;
    let selection = null;

    function validNotes(stored) {
      if (!Array.isArray(stored)) throw new Error("Invalid notes");
      return stored.filter(note => typeof note?.id === "string"
        && typeof note.anchor?.exact === "string" && note.anchor.exact
        && typeof note.anchor.before === "string" && typeof note.anchor.after === "string"
        && Array.isArray(note.comments));
    }

    async function refreshNotes() {
      if (!persistent || signal.aborted) return;
      if (busy) {
        refreshPending = true;
        return;
      }
      const version = ++readVersion;
      let next;
      try {
        next = validNotes(await storage.read());
      } catch {
        if (!signal.aborted && version === readVersion) {
          persistent = false;
          render();
        }
        return;
      }
      if (signal.aborted || version !== readVersion) return;
      notes = next;
      paint();
      render();
    }

    async function change(update) {
      if (busy || signal.aborted) return false;
      busy = true;
      readVersion++;
      let next;
      try {
        if (persistent) {
          try {
            next = await storage.update(items => {
              signal.throwIfAborted();
              next = update(validNotes(items));
              return next;
            });
          } catch {
            if (signal.aborted) return false;
            persistent = false;
            announce("Browser storage is unavailable. Changes will last until you reload.");
          }
        }
        if (signal.aborted) return false;
        notes = next ?? update(notes);
        paint();
        return true;
      } finally {
        busy = false;
        if (refreshPending) {
          refreshPending = false;
          void refreshNotes();
        }
      }
    }

    function paint() {
      attached = new Map();
      const marks = canHighlight ? new Highlight() : null;
      const comments = canHighlight ? new Highlight() : null;
      if (notes.length) {
        index ??= indexText(scope, true);
        for (const note of notes) {
          const match = locate(index, note.anchor);
          if (!match) continue;
          const range = rangeFor(index, match);
          attached.set(note.id, { ...match, range });
          const layer = note.comments.some(comment => !comment.resolved) ? comments : marks;
          layer?.add(range);
        }
      }
      if (canHighlight) {
        comments.priority = 1;
        CSS.highlights.set(markName, marks);
        CSS.highlights.set(commentName, comments);
      }
    }

    function announce(message) {
      status.textContent = message;
      status.hidden = false;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.hidden = true; }, 3400);
    }

    function hideToolbar() {
      toolbar.hidden = true;
      selection = null;
    }

    function updateToolbar() {
      if (selectionFrame) return;
      selectionFrame = requestAnimationFrame(() => {
        selectionFrame = 0;
        const current = document.getSelection();
        if (selecting || !current?.rangeCount || current.isCollapsed || !current.toString().trim()) {
          hideToolbar();
          return;
        }
        const range = current.getRangeAt(0);
        const parents = [range.startContainer, range.endContainer].map(node =>
          node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        if (parents.some(parent => !scope.contains(parent) || parent.closest(`${excluded}, ${annotationExcluded}`))) {
          hideToolbar();
          return;
        }
        const width = document.documentElement.clientWidth;
        const height = window.innerHeight;
        const visible = Array.from(range.getClientRects()).filter(rect =>
          rect.width && rect.height && rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width);
        if (!visible.length) {
          hideToolbar();
          return;
        }
        selection = range.cloneRange();
        toolbar.hidden = false;
        const box = visible.at(-1);
        const left = Math.min(width - toolbar.offsetWidth - 8, Math.max(8, (box.left + box.right - toolbar.offsetWidth) / 2));
        const below = box.bottom + 8;
        const top = below + toolbar.offsetHeight < height - 8 ? below : Math.max(8, visible[0].top - toolbar.offsetHeight - 8);
        toolbar.style.left = `${Math.max(8, left)}px`;
        toolbar.style.top = `${top}px`;
      });
    }

    function selectedAnchor() {
      if (!selection) return null;
      index ??= indexText(scope, true);
      const match = offsetsFor(index, selection);
      if (!match) return null;
      return anchorFor(index, match);
    }

    function id() {
      return globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(36)).join("-");
    }

    function matchingNote(items, anchor) {
      index ??= indexText(scope, true);
      const target = locate(index, anchor);
      if (!target) return null;
      return items.find(note => {
        const match = locate(index, note.anchor);
        return match?.from === target.from && match.to === target.to;
      });
    }

    async function saveHighlight() {
      const anchor = selectedAnchor();
      if (!anchor) return;
      hideToolbar();
      document.getSelection()?.removeAllRanges();
      if (await change(items => matchingNote(items, anchor) ? items : [{ id: id(), anchor, comments: [] }, ...items])) {
        render();
        announce(persistent ? "Highlight saved." : "Highlight saved for this tab.");
      }
    }

    function startComment() {
      const anchor = selectedAnchor();
      if (!anchor) return;
      const existing = matchingNote(notes, anchor);
      hideToolbar();
      document.getSelection()?.removeAllRanges();
      show(existing?.id || "new", existing ? null : anchor, "draft");
    }

    function show(nextView, anchor = null, focus = "title") {
      if (view !== nextView || anchor) {
        if (nextView === "new") drafts.delete("new");
        resolved = false;
        removing = false;
      }
      open = true;
      view = nextView;
      pending = anchor;
      render(focus, true);
    }

    function close() {
      view = "all";
      pending = null;
      removing = false;
      resolved = false;
      open = false;
      drafts.delete("new");
      render();
      launcher.focus({ preventScroll: true });
    }

    function collapse(noteId) {
      if (panel.hidden) {
        close();
        return;
      }
      show("all", null, `note-${noteId}`);
    }

    function jump(note) {
      const match = attached.get(note.id);
      if (!match) return;
      const parent = match.range.startContainer.parentElement;
      parent.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = match.range.getClientRects()[0];
      if (rect) window.scrollBy({ top: rect.top - window.innerHeight / 2, behavior: "instant" });
      queueLayout();
    }

    async function copyLink(note) {
      const match = attached.get(note.id);
      if (!match) return;
      const pageIndex = indexText(document.body, false);
      const offsets = offsetsFor(pageIndex, match.range);
      const directive = offsets && textDirective(pageIndex, offsets);
      if (!directive) {
        announce("A unique text link couldn’t be made for this selection.");
        return;
      }
      const url = new URL(location.href);
      const route = /^#(?:\/|!)/u.test(url.hash) ? url.hash.slice(1).split(":~:", 1)[0] : "";
      url.hash = `${route}:~:text=${directive}`;
      try {
        await navigator.clipboard.writeText(url.href);
        announce("Text link copied.");
      } catch {
        const thread = cards.get(note.id)?.querySelector(".thread");
        if (!thread) return;
        thread.querySelector(".copy-field")?.remove();
        const field = element("input", "copy-field");
        field.readOnly = true;
        field.value = url.href;
        field.setAttribute("aria-label", "Text link to copy");
        thread.querySelector(".thread-tools").after(field);
        field.focus();
        field.select();
      }
    }

    async function postComment(event) {
      event.preventDefault();
      const active = view;
      const draft = drafts.get(active);
      const body = draft?.trim();
      if (!body) return;
      const anchor = pending;
      const comment = { id: id(), body, resolved: false };
      let noteId;
      const saved = await change(items => {
        const note = anchor ? matchingNote(items, anchor) : items.find(item => item.id === active);
        noteId = note?.id;
        if (!note && !anchor) return items;
        if (!note) {
          noteId = id();
          return [{ id: noteId, anchor, comments: [comment] }, ...items];
        }
        return items.map(item => item.id === noteId ? { ...item, comments: [...item.comments, comment] } : item);
      });
      if (!saved) return;
      if (drafts.get(active) === draft) drafts.delete(active);
      if (open && active === view && anchor === pending && noteId) {
        pending = null;
        view = noteId;
        resolved = false;
        render("draft");
        const list = cards.get(noteId)?.querySelector(".comment-list");
        if (list) list.scrollTop = list.scrollHeight;
      } else render();
    }

    async function updateComment(noteId, commentId, action, nextId) {
      const saved = await change(items => items.map(note => {
        if (note.id !== noteId) return note;
        const comments = action === "delete"
          ? note.comments.filter(comment => comment.id !== commentId)
          : note.comments.map(comment => comment.id === commentId ? { ...comment, resolved: !comment.resolved } : comment);
        return { ...note, comments };
      }));
      if (saved) render(view === noteId && open ? nextId ? `${action}-${nextId}` : "draft" : undefined);
    }

    function passage(id) {
      if (id !== "new") return attached.get(id);
      index ??= indexText(scope, true);
      const match = pending && locate(index, pending);
      if (match) return { ...match, range: rangeFor(index, match) };
    }

    function inlineTarget(match) {
      if (!compact.matches || !match) return null;
      const end = match.range.endContainer;
      const parent = end.nodeType === Node.ELEMENT_NODE ? end : end.parentElement;
      const block = parent?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, pre");
      if (!block || !scope.contains(block) || block.closest("table, [contenteditable]")) return null;
      const container = block.parentElement;
      if (container && /^(block|flow-root|list-item)$/u.test(getComputedStyle(container).display)) return block;
      return null;
    }

    function render(focus, reveal = false) {
      launcherLabel.textContent = notes.length ? `Show notes · ${notes.length}` : "Show notes";
      const focused = inlineRoot.activeElement || ui.activeElement;
      focus ??= focused?.dataset.focusKey;
      const previous = cards.get(view);
      const commentScroll = previous?.querySelector(".comment-list")?.scrollTop || 0;
      const caret = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd] : null;
      const current = notes.find(note => note.id === view);
      const selected = current || (pending && { id: "new", anchor: pending, comments: [] });
      const match = open && selected ? passage(selected.id) : null;
      const target = inlineTarget(match);
      paintActive(open && selected, match);
      cards.clear();
      inlineRoot.querySelector(".note")?.remove();
      if (target) {
        if (target.nextElementSibling !== inline) target.after(inline);
      } else inline.remove();
      panel.hidden = !open || Boolean(target);
      root.toggleAttribute(railAttribute, !panel.hidden && !compact.matches);
      if (panel.hidden) lastScroll = undefined;
      launcher.hidden = open;
      launcher.setAttribute("aria-expanded", String(open));
      notice.replaceChildren();
      track.replaceChildren();
      if (!open) return;

      if (!persistent) notice.append(element("p", "notice", "Changes last until you reload."));
      if (!canHighlight) notice.append(element("p", "notice", "This browser can save notes but can’t paint highlights."));
      headingCount.textContent = notes.length || "";
      if (target) {
        inlineRoot.append(noteCard(selected, true));
      } else {
        const ordered = selected?.id === "new" ? [...notes, selected] : [...notes];
        ordered.sort((a, b) => (passage(a.id)?.from ?? Infinity) - (passage(b.id)?.from ?? Infinity) || 0);
        if (!ordered.length) track.append(element("p", "notice", "Select text on the page to add a highlight or comment."));
        for (const note of ordered) track.append(noteCard(note, note.id === view));
      }
      const list = cards.get(view)?.querySelector(".comment-list");
      if (list) list.scrollTop = commentScroll;
      queueLayout();
      const surface = target ? inlineRoot : panel;
      const control = Array.from(surface.querySelectorAll("[data-focus-key]"))
        .find(item => item.dataset.focusKey === focus)
        || (target ? cards.get(view).querySelector(".disclosure") : focus && heading);
      control?.focus({ preventScroll: true });
      if (control?.tagName === "TEXTAREA" && caret) control.setSelectionRange(...caret);
      if (reveal) {
        cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(() => {
          const card = cards.get(view);
          if (target) control?.scrollIntoView({ block: "nearest" });
          else if (card) {
            const visiblePart = Math.min(card.offsetHeight, railViewport.clientHeight);
            if (card.offsetTop < railViewport.scrollTop || card.offsetTop + visiblePart > railViewport.scrollTop + railViewport.clientHeight) {
              railViewport.scrollTop = card.offsetTop;
            }
          }
        });
      }
    }

    function paintActive(note, match) {
      if (!canHighlight) return;
      CSS.highlights.delete(activeName);
      CSS.highlights.delete(`${activeName}-thread`);
      if (!note || !match) return;
      const threaded = note.id === "new" || note.comments.some(comment => !comment.resolved);
      const highlight = new Highlight(match.range);
      highlight.priority = 2;
      CSS.highlights.set(threaded ? `${activeName}-thread` : activeName, highlight);
    }

    function noteCard(note, expanded) {
      const card = element("section", "note");
      cards.set(note.id, card);
      const match = passage(note.id);
      if (!match) card.dataset.detached = "";
      if (expanded) card.dataset.open = "";
      const heading = element("div", "note-heading");
      const title = element("h3");
      const disclosure = button("", () => expanded ? collapse(note.id) : show(note.id, null, `note-${note.id}`), "disclosure", `note-${note.id}`);
      disclosure.setAttribute("aria-expanded", String(expanded));
      const threadId = `thread-${cards.size}`;
      disclosure.setAttribute("aria-controls", threadId);
      const isHighlight = note.id !== "new" && !note.comments.length;
      const excerpt = element("span", "excerpt", note.anchor.exact);
      excerpt.title = note.anchor.exact;
      const count = element("span", "count");
      if (isHighlight) {
        count.textContent = "Highlight";
      } else {
        const total = note.comments.length;
        count.append(icon("comment"), document.createTextNode(total));
        count.setAttribute("aria-label", `${total} ${total === 1 ? "comment" : "comments"}`);
      }
      disclosure.append(icon(isHighlight && !expanded ? "highlight" : "chevron"), excerpt, count);
      title.append(disclosure);
      heading.append(title);
      if (expanded && match && note.id !== "new") {
        const jumpButton = iconButton("Jump to passage", "jump", () => jump(note));
        jumpButton.hidden = true;
        jumpButton.dataset.jump = "";
        heading.append(jumpButton);
      }
      card.append(heading);
      const thread = element("div", "thread");
      thread.id = threadId;
      thread.hidden = !expanded;
      if (expanded) renderThread(thread, note);
      card.append(thread);
      return card;
    }

    function renderThread(thread, note) {
      const tools = element("div", "thread-tools");
      const done = note.comments.filter(comment => comment.resolved).length;
      if (!done) resolved = false;
      if (done) {
        const filters = element("div", "filters");
        filters.setAttribute("role", "group");
        filters.setAttribute("aria-label", "Filter comments");
        for (const isResolved of [false, true]) {
          const key = isResolved ? "resolved" : "open";
          const filter = button(isResolved ? `Resolved ${done}` : `Open ${note.comments.length - done}`, () => {
            resolved = isResolved;
            render(key);
            cards.get(note.id).querySelector(".comment-list").scrollTop = 0;
          }, "filter", key);
          filter.setAttribute("aria-pressed", String(resolved === isResolved));
          filters.append(filter);
        }
        tools.append(filters);
      }
      if (note.id !== "new") {
        const actions = element("div", "note-actions");
        if (attached.has(note.id)) actions.append(iconButton("Copy text link", "link", () => copyLink(note)));
        actions.append(iconButton(note.comments.length ? "Remove note" : "Remove highlight", "trash", () => {
          removing = true;
          render("confirm");
        }, "remove"));
        tools.append(actions);
      }
      if (tools.childElementCount) thread.append(tools);
      if (note.id !== "new" && !attached.has(note.id)) thread.append(element("p", "notice", "Text unavailable"));
      if (removing) {
        const confirm = element("div", "confirm");
        confirm.append(button(note.comments.length ? "Delete note and comments" : "Delete highlight", async () => {
          if (!await change(items => items.filter(item => item.id !== note.id))) return;
          drafts.delete(note.id);
          if (open && view === note.id) {
            if (panel.hidden) close();
            else show("all");
          } else render();
        }, "danger", "confirm"), button("Cancel", () => { removing = false; render("remove"); }));
        thread.append(confirm);
      }
      const list = element("div", "comment-list");
      const comments = note.comments.filter(comment => Boolean(comment.resolved) === resolved);
      for (const [i, comment] of comments.entries()) {
        const row = element("article", "comment");
        const nextId = (comments[i + 1] || comments[i - 1])?.id;
        const actions = element("div", "comment-actions");
        actions.append(
          iconButton(comment.resolved ? "Reopen comment" : "Resolve comment", comment.resolved ? "reopen" : "resolve",
            () => updateComment(note.id, comment.id, "resolve", nextId), `resolve-${comment.id}`),
          iconButton("Delete comment", "delete", () => updateComment(note.id, comment.id, "delete", nextId), `delete-${comment.id}`)
        );
        row.append(element("p", "", comment.body), actions);
        list.append(row);
      }
      if (!comments.length && done) list.append(element("p", "notice", "No open comments."));
      if (list.childElementCount) {
        list.tabIndex = 0;
        list.setAttribute("aria-label", "Comments");
      } else list.hidden = true;
      thread.append(list);
      const form = element("form", "composer");
      const input = element("textarea");
      input.setAttribute("aria-label", "Add a comment");
      input.placeholder = "Add a comment…";
      input.dataset.focusKey = "draft";
      input.rows = 1;
      input.required = true;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.value = drafts.get(note.id) || "";
      const submit = element("button", "primary", "Post");
      submit.type = "submit";
      submit.dataset.focusKey = "post";
      submit.disabled = !input.value.trim();
      input.addEventListener("input", () => {
        drafts.set(note.id, input.value);
        submit.disabled = !input.value.trim();
        queueLayout();
      });
      form.addEventListener("submit", postComment);
      form.append(input, submit);
      thread.append(form);
    }

    function passageVisible(range, rects, right, bottom) {
      let left = 0;
      let top = 0;
      let element = range.commonAncestorContainer;
      if (element.nodeType !== Node.ELEMENT_NODE) element = element.parentElement;
      for (; element && element !== root; element = element.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(element);
        const clipsX = overflowX !== "visible";
        const clipsY = overflowY !== "visible";
        if (!clipsX && !clipsY) continue;
        const rect = element.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
        if (clipsY) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      return right > left && bottom > top && rects.some(rect =>
        rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right);
    }

    function queueLayout() {
      if (layoutFrame || panel.hidden) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        if (panel.hidden) return;
        const headerBottom = railViewport.getBoundingClientRect().top;
        const bounds = panel.getBoundingClientRect();
        const right = compact.matches ? innerWidth : bounds.left;
        const bottom = compact.matches ? bounds.top : innerHeight;
        const pageScroll = window.scrollY;
        const entries = [];
        for (const [id, card] of cards) {
          const range = passage(id)?.range;
          const rects = Array.from(range?.getClientRects() || []).filter(rect => rect.width && rect.height);
          const jumpButton = card.querySelector(".note-heading button[data-jump]");
          if (jumpButton) jumpButton.hidden = range && passageVisible(range, rects, right, bottom);
          if (compact.matches) continue;
          const first = rects[0];
          const start = first ? Math.round(first.top + first.height / 2 + pageScroll - headerBottom - 20) : 0;
          entries.push({ id, card, start, height: card.offsetHeight });
        }
        if (compact.matches) return;
        let nextTop = 8;
        let minimumTop = nextTop;
        const gap = 6;
        for (const [i, entry] of entries.entries()) {
          entry.top = Math.max(entry.start, nextTop);
          if (entry.id === view && entry.start) {
            entry.top = Math.max(entry.start, minimumTop);
            let previousBottom = entry.top;
            for (let j = i - 1; j >= 0; j--) {
              const previous = entries[j];
              previous.top = Math.min(previous.top, previousBottom - previous.height - gap);
              previousBottom = previous.top;
            }
          }
          nextTop = entry.top + entry.height + gap;
          minimumTop += entry.height + gap;
        }
        for (const {card, top} of entries) card.style.top = `${top}px`;
        track.style.height = `${Math.max(nextTop, document.documentElement.scrollHeight - innerHeight + railViewport.clientHeight)}px`;
        if (lastScroll !== pageScroll) railViewport.scrollTop = pageScroll;
        lastScroll = pageScroll;
      });
    }

    function installStyle(root, css) {
      if (extensionStorage) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets.push(sheet);
        signal.addEventListener("abort", () => {
          const index = root.adoptedStyleSheets.indexOf(sheet);
          if (index !== -1) root.adoptedStyleSheets.splice(index, 1);
        }, { once: true });
      } else {
        const style = makeStyle(css);
        (root.head || root).append(style);
        signal.addEventListener("abort", () => style.remove(), { once: true });
      }
    }

    toolbar.append(button("Highlight", saveHighlight), button("Comment", startComment));
    toolbar.addEventListener("mousedown", event => { event.preventDefault(); });
    installStyle(ui, UI_CSS);
    installStyle(inlineRoot, UI_CSS);
    installStyle(document, `
      :root[${railAttribute}] { padding-right: clamp(305px, 32vw, 410px) !important; }
    `);
    ui.append(toolbar, panel, status, launcher);
    document.body.append(host);
    if (extensionStorage) document.dispatchEvent(new Event(extensionStateEvent));
    if (canHighlight) {
      installStyle(document, `
        ::highlight(${markName}) { background-color: #f2c73e66; }
        ::highlight(${commentName}) { background-color: #f2c73e80; text-decoration: underline #b58a20; }
        ::highlight(${activeName}) { background-color: #f2c73ebf; }
        ::highlight(${activeName}-thread) { background-color: #f2c73ebf; text-decoration: underline #b58a20; }
        @media (prefers-color-scheme: dark) {
          ::highlight(${markName}) { background-color: #efb83350; }
          ::highlight(${commentName}) { background-color: #efb83366; text-decoration-color: #e2b444; }
          ::highlight(${activeName}) { background-color: #efb8338c; }
          ::highlight(${activeName}-thread) { background-color: #efb8338c; text-decoration-color: #e2b444; }
        }
      `);
    }
    storage.subscribe(refreshNotes);
    void refreshNotes();
    updateToolbar();

    document.addEventListener("selectionchange", updateToolbar, { signal });
    compact.addEventListener("change", () => render(), { signal });
    window.addEventListener("resize", () => { updateToolbar(); queueLayout(); }, { passive: true, signal });
    window.addEventListener("scroll", event => {
      if (event.composedPath().some(node => node === host || node === inline)) return;
      updateToolbar();
      queueLayout();
    }, { passive: true, capture: true, signal });
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(queueLayout) : null;
    resizeObserver?.observe(root);
    resizeObserver?.observe(scope);
    resizeObserver?.observe(railViewport);
    document.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" && event.button === 0 && !event.composedPath().includes(host)) {
        selecting = true;
        hideToolbar();
      }
    }, { passive: true, signal });
    function endSelection() {
      selecting = false;
      updateToolbar();
    }
    window.addEventListener("pointerup", endSelection, { passive: true, signal });
    window.addEventListener("pointercancel", endSelection, { passive: true, signal });
    window.addEventListener("blur", () => { selecting = false; hideToolbar(); }, { signal });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const path = event.composedPath();
      if (open && (path.includes(host) || path.includes(inline))) {
        if (view === "all") close();
        else collapse(view);
      }
      else if (!toolbar.hidden) hideToolbar();
    }, { signal });
    document.addEventListener("click", event => {
      if (event.defaultPrevented || event.detail !== 1 || !attached.size || !scope.contains(event.target)
        || event.composedPath().some(node => node === host || node === inline) || !document.getSelection()?.isCollapsed
        || event.target.closest("a, button, input, label, textarea, select, summary, [role], [contenteditable]")) return;
      const point = document.caretPositionFromPoint?.(event.clientX, event.clientY)
        || document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!point) return;
      const node = point.offsetNode || point.startContainer;
      if (!scope.contains(node)) return;
      const offset = point.offset ?? point.startOffset;
      for (const [noteId, { range }] of attached) {
        if (range.comparePoint(node, offset) !== 0) continue;
        if (Array.from(range.getClientRects()).some(rect => event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom)) {
          show(noteId, null, `note-${noteId}`);
          return;
        }
      }
    }, { signal });
    const observer = new MutationObserver(records => {
      if (records.every(record => record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
        .every(node => node === inline || node === host))) return;
      index = null;
      clearTimeout(refreshTimer);
      if (!notes.length) return;
      refreshTimer = setTimeout(() => {
        const previous = attached;
        paint();
        if (previous.size !== attached.size || Array.from(previous.keys()).some(key => !attached.has(key))) render();
        else {
          const selected = notes.find(note => note.id === view);
          paintActive(open && (selected || (pending && { id: "new" })), passage(view));
          queueLayout();
        }
      }, 150);
    });
    observer.observe(scope, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "contenteditable", "data-local-notes-ignore"]
    });
    signal.addEventListener("abort", () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      cancelAnimationFrame(selectionFrame);
      cancelAnimationFrame(layoutFrame);
      cancelAnimationFrame(revealFrame);
      root.removeAttribute(railAttribute);
      inline.remove();
      clearTimeout(refreshTimer);
      clearTimeout(statusTimer);
      if (canHighlight) {
        for (const name of [markName, commentName, activeName, `${activeName}-thread`]) CSS.highlights.delete(name);
      }
      host.remove();
      if (extensionStorage) document.dispatchEvent(new Event(extensionStateEvent));
    }, { once: true });
  }

  const UI_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      color-scheme: light dark;
      --paper: #fbfaf7;
      --rail: #f3f1eb;
      --ink: #24231f;
      --muted: #635f55;
      --line: #dedbd0;
      --hover: #eeebe1;
      --rule: #ab771d;
      --accent: #efcf6a;
      --accent-ink: #282112;
      --danger: #a12d26;
      --shadow: 0 4px 16px #25211226;
      color: var(--ink);
      font: 14px/1.45 Inter, system-ui, sans-serif;
      direction: ltr;
      text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --paper: #262722;
        --rail: #20211e;
        --ink: #f0ede3;
        --muted: #b8b4a6;
        --line: #3d3e36;
        --hover: #30312a;
        --rule: #d4ad58;
        --danger: #ff9b91;
        --shadow: 0 4px 16px #0007;
      }
    }
    :host(local-text-notes-inline) {
      position: relative;
      inset: auto;
      z-index: auto;
      display: block;
      margin: 0 0 12px;
      pointer-events: auto;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, textarea, input { font: inherit; color: inherit; }
    button {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 6px;
      min-height: 32px;
      padding: 4px 9px;
      cursor: pointer;
    }
    button:hover { background: var(--hover); }
    button:disabled { cursor: default; }
    :focus-visible { outline: 2px solid var(--rule); outline-offset: -2px; }
    svg { display: block; width: 16px; height: 16px; flex: none; }
    .toolbar, .panel, .status, .launcher { position: absolute; background: var(--paper); }
    .toolbar, .status, .launcher { border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .toolbar, .panel, .launcher { pointer-events: auto; }
    .toolbar { display: flex; gap: 4px; padding: 4px; z-index: 2; }
    .toolbar button { border-color: transparent; }
    .toolbar button:first-child { background: var(--accent); color: var(--accent-ink); }
    .launcher { display: flex; align-items: center; gap: 6px; bottom: max(12px, env(safe-area-inset-bottom)); right: max(12px, env(safe-area-inset-right)); }
    .logo { object-fit: contain; flex: none; }
    .panel {
      inset: 0 0 0 auto;
      width: clamp(305px, 32vw, 410px);
      display: flex;
      flex-direction: column;
      background: var(--rail);
      border-inline-start: 1px solid var(--line);
    }
    header { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 14px; }
    header .count { margin-inline-end: auto; }
    .rail-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .rail-track { position: relative; }
    .rail-track .note { position: absolute; inset-inline: 0; }
    .note { overflow: hidden; background: var(--paper); border-block: 1px solid var(--line); }
    :host(local-text-notes-inline) .note { border: 1px solid var(--line); border-radius: 6px; }
    .note[data-open] { border-color: var(--rule); }
    .note-heading { display: flex; align-items: center; }
    .note-heading h3 { min-width: 0; flex: 1; margin: 0; font-size: 13px; }
    .disclosure {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      width: 100%;
      min-height: 40px;
      border: 0;
      border-radius: 0;
      text-align: start;
    }
    .disclosure svg { color: var(--muted); }
    .note[data-open] .disclosure > svg { transform: rotate(90deg); color: var(--rule); }
    .excerpt { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note[data-open] .excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; }
    .count { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
    .count svg { width: 14px; height: 14px; }
    .icon { display: grid; place-items: center; width: 30px; min-height: 30px; padding: 0; background: transparent; color: var(--muted); border: 0; }
    .icon:hover { color: var(--ink); }
    .note-heading > .icon { margin-inline-end: 4px; }
    .thread { border-top: 1px solid var(--line); }
    .thread-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 3px 7px 0; }
    .note-actions, .filters, .confirm { display: flex; align-items: center; gap: 2px; }
    .note-actions { margin-inline-start: auto; }
    .filter { min-height: 27px; padding: 2px 6px; border-color: transparent; background: transparent; color: var(--muted); font-size: 12px; }
    .filter[aria-pressed="true"] { border-color: var(--line); background: var(--hover); color: var(--ink); }
    .confirm { padding: 4px 8px; flex-wrap: wrap; }
    .notice { margin: 0; padding: 6px 10px; color: var(--muted); font-size: 12px; }
    .comment-list { max-height: min(240px, 32dvh); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .comment { padding: 4px 8px 3px 10px; font-size: 13px; }
    .comment + .comment { border-top: 1px solid var(--line); }
    .comment p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .comment-actions { display: flex; justify-content: flex-end; }
    .comment-actions .icon { width: 24px; min-height: 24px; }
    .comment-actions .icon:first-child svg { translate: 2px 0; }
    .comment-actions .icon:last-child svg { translate: -2px 0; }
    .composer { display: flex; align-items: flex-end; gap: 5px; padding: 6px 8px; border-top: 1px solid var(--line); }
    textarea, .copy-field {
      min-width: 0;
      border-radius: 5px;
      border: 1px solid var(--line);
      background: var(--rail);
      padding: 6px 7px;
      font-size: 13px;
    }
    textarea { flex: 1; min-height: 32px; max-height: 84px; resize: none; field-sizing: content; }
    textarea::placeholder { color: var(--muted); }
    .copy-field { display: block; width: calc(100% - 16px); margin: 4px 8px; }
    .primary { background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 650; }
    .primary:hover { background: #f6db8b; }
    .primary:disabled { background: transparent; color: var(--muted); }
    .danger { color: var(--danger); }
    .status { bottom: 52px; right: 12px; max-width: calc(100vw - 24px); padding: 6px 10px; font-size: 13px; z-index: 3; }
    @media (max-width: 760px) {
      .panel { inset: auto 0 0; width: auto; max-height: 55dvh; border-inline-start: 0; border-top: 1px solid var(--line); }
      .rail-track .note { position: static; }
      .comment-actions .icon { width: 30px; min-height: 30px; }
      .comment-actions .icon:first-child svg { translate: 3px 0; }
      .comment-actions .icon:last-child svg { translate: -3px 0; }
    }
  `;

  function initialize() {
    if (globalThis.startLocalTextNotesExtension) {
      globalThis.startLocalTextNotesExtension(start);
      return;
    }
    if (document.querySelector("local-text-notes:not([data-extension])")) return;
    let controller = null;
    function update() {
      if (document.querySelector(extensionSelector)) {
        controller?.abort();
        controller = null;
      } else if (!controller) {
        controller = new AbortController();
        start({ signal: controller.signal });
      }
    }
    document.addEventListener(extensionStateEvent, update);
    update();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
