/* Local Text Notes. Load as a classic script with defer. */
(() => {
  "use strict";

  const script = document.currentScript;
  const excluded = "script, style, noscript, template, [hidden], local-text-notes";
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
    const focusName = `${prefix}-focus`;
    const host = element("local-text-notes");
    if (extensionStorage) host.setAttribute("data-extension", "");
    const ui = host.attachShadow({ mode: extensionStorage ? "closed" : "open" });
    const panel = element("section", "panel");
    panel.id = "notes-panel";
    panel.setAttribute("aria-labelledby", "notes-title");
    panel.hidden = true;
    const toolbar = element("div", "toolbar");
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Mark up selected text");
    toolbar.hidden = true;
    const status = element("div", "status");
    status.setAttribute("role", "status");
    status.hidden = true;
    const launcher = button("Notes", () => panel.hidden ? show("all") : close(), "launcher");
    launcher.setAttribute("aria-controls", panel.id);
    launcher.setAttribute("aria-expanded", "false");
    let notes = [];
    let persistent = true;
    let index = null;
    let attached = new Map();
    let view = "all";
    let pending = null;
    let draft = "";
    let removing = false;
    let busy = false;
    let readVersion = 0;
    let refreshPending = false;
    let selecting = false;
    let selectionFrame = 0;
    let refreshTimer = 0;
    let statusTimer = 0;
    let flashTimer = 0;
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
      view = nextView;
      pending = anchor;
      draft = "";
      removing = false;
      panel.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
      render(focus);
    }

    function close() {
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      panel.replaceChildren();
      view = "all";
      pending = null;
      draft = "";
      removing = false;
      launcher.focus({ preventScroll: true });
    }

    function jump(note) {
      const match = attached.get(note.id);
      if (!match) return;
      close();
      const parent = match.range.startContainer.parentElement;
      parent.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = match.range.getClientRects()[0];
      if (rect) window.scrollBy({ top: rect.top - window.innerHeight / 2, behavior: "instant" });
      if (canHighlight) {
        const highlight = new Highlight(match.range);
        highlight.priority = 2;
        CSS.highlights.set(focusName, highlight);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => CSS.highlights.delete(focusName), 1100);
      }
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
        const existing = panel.querySelector(".copy-field");
        existing?.remove();
        const field = element("input", "copy-field");
        field.readOnly = true;
        field.value = url.href;
        field.setAttribute("aria-label", "Text link to copy");
        panel.append(field);
        field.focus();
        field.select();
      }
    }

    async function postComment(event) {
      event.preventDefault();
      const body = draft.trim();
      if (!body) return;
      const active = view;
      const anchor = pending;
      let noteId = active;
      const saved = await change(items => {
        const note = anchor ? matchingNote(items, anchor) : items.find(item => item.id === active);
        const comment = { id: id(), body, resolved: false };
        noteId = note?.id || id();
        if (!note && !anchor) return items;
        if (!note) return [{ id: noteId, anchor, comments: [comment] }, ...items];
        return items.map(item => item.id === noteId ? { ...item, comments: [...item.comments, comment] } : item);
      });
      if (!saved) return;
      if (!panel.hidden && active === view) show(noteId, null, "draft");
      else render();
    }

    async function updateComment(noteId, commentId, action) {
      const saved = await change(items => items.map(note => {
        if (note.id !== noteId) return note;
        const comments = action === "delete"
          ? note.comments.filter(comment => comment.id !== commentId)
          : note.comments.map(comment => comment.id === commentId ? { ...comment, resolved: !comment.resolved } : comment);
        return { ...note, comments };
      }));
      if (saved) render(action === "delete" ? "draft" : `resolve-${commentId}`);
    }

    function render(focus) {
      launcher.textContent = notes.length ? `Notes · ${notes.length}` : "Notes";
      if (panel.hidden) return;
      const focused = ui.activeElement;
      focus ??= focused?.dataset.focusKey;
      const caret = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd] : null;
      const scroll = panel.scrollTop;
      const note = notes.find(item => item.id === view);
      const anchor = note?.anchor || pending;
      const heading = element("h2", "", anchor ? "Note" : "Notes");
      heading.id = "notes-title";
      heading.tabIndex = -1;
      heading.dataset.focusKey = "title";
      const header = element("header");
      if (anchor) header.append(button("All notes", () => show("all"), "quiet"));
      header.append(heading, button("Close", close, "quiet"));
      panel.replaceChildren(header);

      if (!persistent) panel.append(element("p", "notice", "Browser storage is unavailable. Changes last until you reload."));
      if (!canHighlight) panel.append(element("p", "notice", "This browser can save notes but can’t paint highlights."));
      if (!anchor) {
        if (!notes.length) panel.append(element("p", "empty", "Select text on the page to add a highlight or comment."));
        for (const item of notes) {
          const row = button("", () => show(item.id), "note-row", item.id);
          const open = item.comments.filter(comment => !comment.resolved).length;
          const resolved = item.comments.length - open;
          const meta = [open && `${open} open`, resolved && `${resolved} resolved`].filter(Boolean).join(" · ") || "Highlight";
          row.append(element("span", "excerpt", item.anchor.exact),
            element("span", "meta", attached.has(item.id) ? meta : `${meta} · Text unavailable`));
          panel.append(row);
        }
      } else {
        panel.append(element("blockquote", "", anchor.exact));
        if (note) {
          const actions = element("div", "actions");
          if (attached.has(note.id)) {
            actions.append(button("Jump to text", () => jump(note)), button("Copy text link", () => copyLink(note)));
          } else {
            panel.append(element("p", "notice", "The original text could not be located on this page."));
          }
          if (removing) {
            actions.append(
              button(note.comments.length ? "Delete note and comments" : "Delete highlight", async () => {
                if (await change(items => items.filter(item => item.id !== note.id))) show("all");
              }, "danger", "confirm"),
              button("Cancel", () => { removing = false; render("remove"); })
            );
          } else {
            actions.append(button(note.comments.length ? "Remove note" : "Remove highlight",
              () => { removing = true; render("confirm"); }, "quiet", "remove"));
          }
          panel.append(actions);
          for (const comment of note.comments) {
            const item = element("article", "comment");
            const body = element("p", "", comment.body);
            const controls = element("div", "actions");
            if (comment.resolved) controls.append(element("span", "meta", "Resolved"));
            controls.append(button(comment.resolved ? "Reopen" : "Resolve",
              () => updateComment(note.id, comment.id, "resolve"), "quiet", `resolve-${comment.id}`),
            button("Delete", () => updateComment(note.id, comment.id, "delete"), "quiet", `delete-${comment.id}`));
            item.append(body, controls);
            panel.append(item);
          }
        }
        const form = element("form");
        const input = element("textarea");
        const label = element("label", "", "Comment");
        input.id = "note-comment";
        input.dataset.focusKey = "draft";
        label.htmlFor = input.id;
        input.rows = 3;
        input.required = true;
        input.spellcheck = false;
        input.autocomplete = "off";
        input.value = draft;
        input.addEventListener("input", () => { draft = input.value; });
        const submit = element("button", "primary", "Post comment");
        submit.type = "submit";
        submit.dataset.focusKey = "post";
        form.addEventListener("submit", postComment);
        form.append(label, input, submit);
        panel.append(form);
      }
      panel.scrollTop = scroll;
      if (focus) {
        const target = Array.from(panel.querySelectorAll("[data-focus-key]"))
          .find(item => item.dataset.focusKey === focus);
        target?.focus({ preventScroll: focus !== "draft" });
        if (target?.tagName === "TEXTAREA" && caret) target.setSelectionRange(...caret);
      }
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
    ui.append(toolbar, panel, status, launcher);
    document.body.append(host);
    if (extensionStorage) document.dispatchEvent(new Event(extensionStateEvent));
    if (canHighlight) {
      installStyle(document, `
        ::highlight(${markName}) { background-color: #f2c73e66; }
        ::highlight(${commentName}) { background-color: #f2c73e80; text-decoration: underline #b58a20; }
        ::highlight(${focusName}) { background-color: #f2c73ebf; }
        @media (prefers-color-scheme: dark) {
          ::highlight(${markName}) { background-color: #efb83350; }
          ::highlight(${commentName}) { background-color: #efb83366; text-decoration-color: #e2b444; }
        }
      `);
    }
    storage.subscribe(refreshNotes);
    void refreshNotes();
    updateToolbar();

    document.addEventListener("selectionchange", updateToolbar, { signal });
    window.addEventListener("resize", updateToolbar, { passive: true, signal });
    window.addEventListener("scroll", updateToolbar, { passive: true, capture: true, signal });
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
      if (!panel.hidden && event.composedPath().includes(host)) close();
      else if (!toolbar.hidden) hideToolbar();
    }, { signal });
    document.addEventListener("click", event => {
      if (event.defaultPrevented || event.detail !== 1 || !attached.size || !panel.hidden || !scope.contains(event.target)
        || event.composedPath().includes(host) || !document.getSelection()?.isCollapsed
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
          show(noteId);
          return;
        }
      }
    }, { signal });
    const observer = new MutationObserver(() => {
      index = null;
      clearTimeout(refreshTimer);
      if (!notes.length) return;
      refreshTimer = setTimeout(() => {
        const previous = attached;
        paint();
        if (previous.size !== attached.size || Array.from(previous.keys()).some(key => !attached.has(key))) render();
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
      cancelAnimationFrame(selectionFrame);
      clearTimeout(refreshTimer);
      clearTimeout(statusTimer);
      clearTimeout(flashTimer);
      if (canHighlight) {
        for (const name of [markName, commentName, focusName]) CSS.highlights.delete(name);
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
      --paper: #fffefa;
      --ink: #292820;
      --muted: #605e52;
      --line: #e6e1d4;
      --hover: #f4f0e4;
      --accent: #efcf6a;
      --accent-ink: #282112;
      --danger: #a12d26;
      --shadow: 0 8px 32px #25211226, 0 1px 4px #2521121f;
      color: var(--ink);
      font: 14px/1.45 Inter, system-ui, sans-serif;
      direction: ltr;
      text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --paper: #24231f;
        --ink: #f6f0e3;
        --muted: #c3bbab;
        --line: #454239;
        --hover: #37342c;
        --danger: #ff9b91;
        --shadow: 0 8px 32px #0007;
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, textarea, input { font: inherit; color: inherit; }
    button {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 7px;
      min-height: 32px;
      padding: 4px 9px;
      cursor: pointer;
    }
    button:hover { background: var(--hover); }
    :focus-visible { outline: 2px solid #a87922; outline-offset: 2px; }
    .toolbar, .panel, .status, .launcher {
      position: absolute;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 11px;
      box-shadow: var(--shadow);
    }
    .toolbar, .panel, .launcher { pointer-events: auto; }
    .toolbar { display: flex; gap: 4px; padding: 4px; z-index: 2; }
    .toolbar button { border-color: transparent; }
    .toolbar button:first-child { background: var(--accent); color: var(--accent-ink); }
    .launcher { bottom: max(14px, env(safe-area-inset-bottom)); right: max(14px, env(safe-area-inset-right)); padding: 5px 12px; }
    .panel {
      bottom: calc(max(14px, env(safe-area-inset-bottom)) + 42px);
      right: max(14px, env(safe-area-inset-right));
      width: min(350px, calc(100vw - 28px));
      max-height: min(620px, calc(100dvh - 70px));
      overflow: auto;
      overscroll-behavior: contain;
      padding: 0 14px 14px;
    }
    header {
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--paper);
      border-bottom: 1px solid var(--line);
      padding: 10px 0;
      margin-bottom: 12px;
    }
    h2 { margin: 0; flex: 1; font-size: 17px; }
    .quiet { background: transparent; border-color: transparent; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .meta, .notice, .empty { color: var(--muted); }
    .meta, .notice { font-size: 12px; }
    .note-row { display: block; width: 100%; margin-top: 7px; padding: 9px 10px; text-align: left; }
    .excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
    .note-row .meta { display: block; margin-top: 3px; }
    blockquote {
      margin: 0 0 10px;
      padding: 5px 9px;
      border-inline-start: 3px solid var(--accent);
      max-height: 115px;
      overflow: auto;
      overflow-wrap: anywhere;
    }
    .comment { margin-top: 12px; padding-top: 9px; border-top: 1px solid var(--line); }
    .comment p { margin: 0 0 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
    form { display: grid; gap: 6px; margin-top: 14px; }
    label { font-weight: 600; }
    textarea, .copy-field {
      display: block;
      width: 100%;
      border-radius: 7px;
      border: 1px solid var(--line);
      background: var(--paper);
      padding: 7px;
    }
    textarea { resize: vertical; }
    .copy-field { margin-top: 10px; }
    .primary { justify-self: start; background: var(--accent); color: var(--accent-ink); font-weight: 600; }
    .primary:hover { background: #f6db8b; }
    .danger { color: var(--danger); }
    .status { bottom: 15px; right: 100px; max-width: calc(100vw - 120px); padding: 6px 10px; font-size: 13px; z-index: 3; }
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
