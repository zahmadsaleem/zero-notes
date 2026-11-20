// Firefox runs this as an event page with sites.js loaded first, where importScripts is undefined.
if (typeof importScripts === "function") importScripts("sites.js");

const {
  siteFor, pageUrl, frameId, noteKey, noteRecord, notesForSite, removeNotesForSite, siteKey, embeddedKey
} = LocalTextNotesSites;
const scriptId = "local-text-notes";
const contentFiles = ["sites.js", "content.js", "local-text-notes.js"];
const pendingAccess = chrome.storage.session ?? chrome.storage.local;
const enableRequestPrefix = "enable-request:";
let queue = Promise.resolve();
let cliPort = null;
let cliReady = false;

function serialize(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

async function enabledSites() {
  return (await chrome.storage.local.get(siteKey))[siteKey] || [];
}

// Origin patterns of embedded frames (such as claude.ai artifacts) enabled per top-level site.
async function embeddedFrames() {
  return (await chrome.storage.local.get(embeddedKey))[embeddedKey] || {};
}

function validFramePatterns(site, frames) {
  if (!Array.isArray(frames)) return [];
  const patterns = frames.map(pattern => {
    const frame = siteFor(pattern.replace(/\*$/u, ""));
    return frame && frame.id !== "file:///" && frame.pattern === pattern ? pattern : null;
  });
  return [...new Set(patterns.filter(pattern => pattern && pattern !== site.pattern))];
}

async function hasAccess(site, frames = []) {
  if (site.id === "file:///" && !(await chrome.extension.isAllowedFileSchemeAccess())) return false;
  return chrome.permissions.contains({ origins: [site.pattern, ...frames] });
}

async function matchPatterns(sites) {
  const frames = await embeddedFrames();
  return [...new Set(sites.flatMap(id => [siteFor(id).pattern, ...(frames[id] || [])]))];
}

async function frameContext(sender) {
  const site = siteFor(sender.tab?.url);
  const url = pageUrl(sender.tab?.url);
  const frame = frameId(sender.url);
  if (!site || !url || !frame || !(await enabledSites()).includes(site.id)) return null;
  // Only frames the person enabled from the popup get notes, so ads and widgets stay untouched.
  if (!(await embeddedFrames())[site.id]?.includes(siteFor(sender.url)?.pattern)) return null;
  return { url, frame };
}

async function registerFor(sites) {
  const matches = await matchPatterns(sites);
  const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
  if (!matches.length) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    return;
  }

  const script = {
    id: scriptId,
    js: contentFiles,
    matches,
    allFrames: true,
    runAt: "document_idle",
    persistAcrossSessions: true
  };
  if (registered) {
    if (registered.matches.join() !== matches.join() || registered.js.join() !== contentFiles.join()
      || !registered.allFrames) {
      await chrome.scripting.updateContentScripts([script]);
    }
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
}

async function injectOpenTabs(sites) {
  if (!sites.length) return [];
  const tabs = await chrome.tabs.query({ url: sites.map(id => siteFor(id).pattern) });
  const eligible = tabs.filter(tab => !tab.discarded && sites.includes(siteFor(tab.url)?.id));
  return Promise.all(eligible.map(async tab => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: contentFiles,
        injectImmediately: true
      });
      return tab.id;
    } catch {
      // Chrome may restrict the page, or the tab may have navigated or closed.
      return null;
    }
  }));
}

async function restoreRegistration(activateOpenTabs) {
  const stored = await enabledSites();
  const accessible = await Promise.all(stored.map(async id => {
    const site = siteFor(id);
    return site && await hasAccess(site) ? id : null;
  }));
  const sites = accessible.filter(Boolean);
  if (sites.length !== stored.length) await chrome.storage.local.set({ [siteKey]: sites });
  const frames = await embeddedFrames();
  const grantedFrames = {};
  // A site toggled off with the shortcut can still have granted frame access.
  for (const [id, patterns] of Object.entries(frames)) {
    const site = siteFor(id);
    if (!site || (!sites.includes(id) && !(await hasAccess(site)))) continue;
    const granted = [];
    for (const pattern of patterns) {
      if (await chrome.permissions.contains({ origins: [pattern] })) granted.push(pattern);
    }
    if (granted.length) grantedFrames[id] = granted;
  }
  if (JSON.stringify(grantedFrames) !== JSON.stringify(frames)) {
    await chrome.storage.local.set({ [embeddedKey]: grantedFrames });
  }
  await registerFor(sites);
  if (activateOpenTabs) await injectOpenTabs(sites);
}

function reconcile(activateOpenTabs) {
  void serialize(() => restoreRegistration(activateOpenTabs)).catch(error => console.error("Zero Notes:", error));
}

chrome.runtime.onInstalled.addListener(() => reconcile(true));
chrome.runtime.onStartup.addListener(() => reconcile(true));
chrome.permissions.onRemoved.addListener(permissions => {
  if (permissions.permissions?.includes("nativeMessaging")) controlCLI("disconnect");
  if (permissions.origins?.length) reconcile(false);
});
chrome.permissions.onAdded.addListener(permissions => {
  if (permissions.origins?.length) {
    void serialize(enableGrantedSites).catch(error => console.error("Zero Notes:", error));
  }
});

async function changeSite(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site) throw new Error("This page cannot be enabled.");
  const stored = await enabledSites();
  const frames = await embeddedFrames();
  if (!message.enabled) {
    await pendingAccess.remove(enableRequestPrefix + site.id);
    const remaining = stored.filter(id => id !== site.id);
    const { [site.id]: released = [], ...remainingFrames } = frames;
    await chrome.storage.local.set({
      [siteKey]: remaining,
      [embeddedKey]: message.keepAccess ? frames : remainingFrames
    });
    try {
      await registerFor(remaining);
    } finally {
      if (!message.keepAccess) {
        const kept = new Set(await matchPatterns([...remaining, ...Object.keys(remainingFrames)]));
        const unused = [site.pattern, ...released].filter(pattern => !kept.has(pattern));
        if (unused.length) {
          await chrome.permissions.remove({ origins: unused }).catch(error => {
            console.warn("Zero Notes could not release site access:", error.message);
          });
        }
      }
    }
    return {};
  }

  const requested = validFramePatterns(site, message.frames);
  if (!(await hasAccess(site, requested))) throw new Error("Chrome hasn’t granted access to this site.");
  const next = [...new Set([...stored, site.id])];
  const nextFrames = requested.length
    ? { ...frames, [site.id]: [...new Set([...(frames[site.id] || []), ...requested])] }
    : frames;
  await chrome.storage.local.set({ [embeddedKey]: nextFrames });
  try {
    await registerFor(next);
    await chrome.storage.local.set({ [siteKey]: next });
  } catch (error) {
    await chrome.storage.local.set({ [embeddedKey]: frames });
    await registerFor(stored);
    throw error;
  }

  const activated = await injectOpenTabs([site.id]);
  return { reload: !activated.includes(message.tabId) };
}

async function enableGrantedSites() {
  const requests = await pendingAccess.get(null);
  for (const [key, request] of Object.entries(requests)) {
    if (!key.startsWith(enableRequestPrefix)) continue;
    const site = siteFor(request?.site);
    if (!site || key !== enableRequestPrefix + site.id || !(request.expires > Date.now())) {
      await pendingAccess.remove(key);
    } else if (!request.result && await hasAccess(site, validFramePatterns(site, request.frames))) {
      const result = await changeSite({ ...request, enabled: true });
      await pendingAccess.set({ [key]: { ...request, result } });
    }
  }
}

async function requestSiteEnable(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site || typeof message.requestId !== "string") {
    throw new Error("Could not identify the site.");
  }
  const key = enableRequestPrefix + site.id;
  if (message.type === "prepare-site-enable") {
    const frames = validFramePatterns(site, message.frames);
    if (await hasAccess(site, frames)) return { ...await changeSite({ ...message, enabled: true }), enabled: true };
    const request = {
      site: site.id, frames, tabId: message.tabId, requestId: message.requestId, expires: Date.now() + 5 * 60_000
    };
    await pendingAccess.set({ [key]: request });
    return { pending: true };
  }

  const request = (await pendingAccess.get(key))[key];
  if (message.type === "cancel-site-enable") {
    if (request?.requestId === message.requestId && !request.result) await pendingAccess.remove(key);
    return {};
  }
  const result = request?.requestId === message.requestId ? request.result : undefined;
  const activated = result ?? await changeSite({ ...message, enabled: true });
  if (request?.requestId === message.requestId) await pendingAccess.remove(key);
  return { ...activated, enabled: true };
}

function toggleFromShortcut(tab) {
  const site = siteFor(tab?.url);
  if (!site) return;
  // permissions.request needs the shortcut's user gesture, so it must start before any await.
  const request = chrome.permissions.request({ origins: [site.pattern] });
  void (async () => {
    if (!(await enabledSites()).includes(site.id) && !(await hasAccess(site))) {
      const granted = await request.catch(() => null);
      // Some browsers only show the access prompt from the popup, so fall back to it for new sites.
      if (granted === null) await chrome.action.openPopup?.({ windowId: tab.windowId });
      if (!granted) return;
    } else {
      request.catch(() => {});
    }
    await serialize(async () => {
      if ((await enabledSites()).includes(site.id)) {
        // Keep the site's access so the shortcut can turn notes back on without another prompt.
        await changeSite({ site: site.id, enabled: false, keepAccess: true, tabId: tab.id });
      } else if (await hasAccess(site)) {
        const { reload } = await changeSite({ site: site.id, enabled: true, tabId: tab.id });
        if (reload) await chrome.tabs.reload(tab.id);
      }
    });
  })().catch(error => console.error("Zero Notes:", error));
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-notes") toggleFromShortcut(tab);
});

async function writeNotes(message, sender) {
  const url = pageUrl(message.url);
  let frame = null;
  if (sender.frameId === 0) {
    const site = siteFor(sender.url);
    if (!site || !url || siteFor(url)?.id !== site.id || !(await enabledSites()).includes(site.id)) {
      throw new Error("Zero Notes is disabled here.");
    }
  } else {
    const context = await frameContext(sender);
    if (!context || context.url !== url) throw new Error("Zero Notes is disabled here.");
    frame = context.frame;
  }
  if (!Number.isSafeInteger(message.revision) || !Array.isArray(message.notes)) {
    throw new Error("Invalid notes update.");
  }

  // Each frame of a page owns its own notes within the page's record.
  const key = noteKey(url);
  const current = noteRecord((await chrome.storage.local.get(key))[key]);
  if (current.revision !== message.revision) return { current };
  const others = current.notes.filter(note => (note?.frame ?? null) !== frame);
  const own = message.notes.map(({ frame: _, ...note }) => frame ? { ...note, frame } : note);
  const record = { revision: current.revision + 1, notes: [...others, ...own] };
  const title = (typeof message.title === "string" ? message.title.trim().slice(0, 250) : "")
    || (typeof current.title === "string" ? current.title : "");
  if (record.notes.length && title) record.title = title;
  await chrome.storage.local.set({ [key]: record });
  return { saved: true };
}

async function deleteSiteNotes(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site) throw new Error("Could not identify the site.");
  await removeNotesForSite(site);
  return {};
}

function controlCLI(action) {
  if (action === "disconnect") {
    cliPort?.disconnect();
    cliPort = null;
    cliReady = false;
  }
  if (action !== "connect" || cliPort) return { connected: cliReady };

  return new Promise(resolve => {
    const port = chrome.runtime.connectNative("com.madsolame.zero_notes");
    cliPort = port;
    const timer = setTimeout(() => fail("CLI host timed out. Check the installation and try again."), 5000);

    function fail(error) {
      clearTimeout(timer);
      if (cliPort === port) {
        cliPort = null;
        cliReady = false;
      }
      port.disconnect();
      resolve({ error });
    }

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      fail(error?.includes("not found")
        ? "Native host not found. Run zero-notes install with this Chrome extension ID. See the README."
        : error || "CLI host disconnected.");
    });
    port.onMessage.addListener(async message => {
      if (cliPort !== port) return;
      if (!cliReady) {
        if (message?.ready !== true) {
          fail(message?.error || "Could not start the CLI host.");
          return;
        }
        clearTimeout(timer);
        cliReady = true;
        resolve({ connected: true });
        return;
      }
      const site = siteFor(message?.site);
      let reply = { error: "Use an HTTP(S) site URL or file:///." };
      if (site) {
        try {
          reply = { data: await notesForSite(site) };
        } catch {
          reply = { error: "Could not read saved notes." };
        }
      }
      if (cliPort === port) port.postMessage(reply);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromPopup = sender.url === chrome.runtime.getURL("popup.html");
  if (message?.type === "cli" && fromPopup) {
    Promise.resolve().then(() => controlCLI(message.action)).then(
      respond,
      error => respond({ error: error.message })
    );
    return true;
  }
  let task;
  if (message?.type === "set-site" && fromPopup) {
    task = () => changeSite(message);
  } else if (fromPopup && ["prepare-site-enable", "finish-site-enable", "cancel-site-enable"].includes(message?.type)) {
    task = () => requestSiteEnable(message);
  } else if (message?.type === "delete-site-notes" && fromPopup) {
    task = () => deleteSiteNotes(message);
  } else if (message?.type === "write-notes" && sender.tab) {
    task = () => writeNotes(message, sender);
  } else if (message?.type === "frame-context" && sender.tab && sender.frameId !== 0) {
    task = () => frameContext(sender).then(context => context ?? {});
  } else {
    return false;
  }
  serialize(task).then(
    result => respond(result),
    error => respond({ error: error.message })
  );
  return true;
});
