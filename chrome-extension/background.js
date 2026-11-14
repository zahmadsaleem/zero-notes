importScripts("sites.js");

const { siteFor, pageUrl, noteKey, noteRecord, notesForSite, siteKey } = LocalTextNotesSites;
const scriptId = "local-text-notes";
const contentFiles = ["sites.js", "content.js", "local-text-notes.js"];
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

async function hasAccess(site) {
  if (site.id === "file:///" && !(await chrome.extension.isAllowedFileSchemeAccess())) return false;
  return chrome.permissions.contains({ origins: [site.pattern] });
}

function matchPatterns(sites) {
  return [...new Set(sites.map(id => siteFor(id).pattern))];
}

async function registerFor(sites) {
  const matches = matchPatterns(sites);
  const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
  if (!matches.length) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    return;
  }

  const script = {
    id: scriptId,
    js: contentFiles,
    matches,
    runAt: "document_idle",
    persistAcrossSessions: true
  };
  if (registered) {
    if (registered.matches.join() !== matches.join() || registered.js.join() !== contentFiles.join()) {
      await chrome.scripting.updateContentScripts([script]);
    }
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
}

async function injectOpenTabs(sites) {
  if (!sites.length) return [];
  const tabs = await chrome.tabs.query({ url: matchPatterns(sites) });
  const eligible = tabs.filter(tab => !tab.discarded && sites.includes(siteFor(tab.url)?.id));
  return Promise.all(eligible.map(async tab => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
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
  await registerFor(sites);
  if (activateOpenTabs) await injectOpenTabs(sites);
}

function reconcile(activateOpenTabs) {
  void serialize(() => restoreRegistration(activateOpenTabs)).catch(error => console.error("Local Text Notes:", error));
}

chrome.runtime.onInstalled.addListener(() => reconcile(true));
chrome.runtime.onStartup.addListener(() => reconcile(true));
chrome.permissions.onRemoved.addListener(permissions => {
  if (permissions.permissions?.includes("nativeMessaging")) controlCLI("disconnect");
  if (permissions.origins?.length) reconcile(false);
});

async function changeSite(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site) throw new Error("This page cannot be enabled.");
  const stored = await enabledSites();
  if (!message.enabled) {
    const remaining = stored.filter(id => id !== site.id);
    await chrome.storage.local.set({ [siteKey]: remaining });
    try {
      await registerFor(remaining);
    } finally {
      if (!remaining.some(id => siteFor(id).pattern === site.pattern)) {
        await chrome.permissions.remove({ origins: [site.pattern] }).catch(error => {
          console.warn("Local Text Notes could not release site access:", error.message);
        });
      }
    }
    return {};
  }

  if (!(await hasAccess(site))) throw new Error("Chrome hasn’t granted access to this site.");
  const next = [...new Set([...stored, site.id])];
  await registerFor(next);
  try {
    await chrome.storage.local.set({ [siteKey]: next });
  } catch (error) {
    await registerFor(stored);
    throw error;
  }

  const activated = await injectOpenTabs([site.id]);
  return { reload: !activated.includes(message.tabId) };
}

async function writeNotes(message, sender) {
  const site = siteFor(sender.url);
  const url = pageUrl(message.url);
  if (!site || !url || sender.frameId !== 0 || siteFor(url)?.id !== site.id
    || !(await enabledSites()).includes(site.id)) {
    throw new Error("Local Text Notes is disabled here.");
  }
  if (!Number.isSafeInteger(message.revision) || !Array.isArray(message.notes)) {
    throw new Error("Invalid notes update.");
  }

  const key = noteKey(url);
  const current = noteRecord((await chrome.storage.local.get(key))[key]);
  if (current.revision !== message.revision) return { current };
  await chrome.storage.local.set({ [key]: { revision: current.revision + 1, notes: message.notes } });
  return { saved: true };
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
        ? "Native host not found. Run zero-notes install for this browser and extension ID. See the README."
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
  if (message?.type === "cli" && sender.url === chrome.runtime.getURL("popup.html")) {
    Promise.resolve().then(() => controlCLI(message.action)).then(
      respond,
      error => respond({ error: error.message })
    );
    return true;
  }
  let task;
  if (message?.type === "set-site" && sender.url === chrome.runtime.getURL("popup.html")) {
    task = () => changeSite(message);
  } else if (message?.type === "write-notes" && sender.tab) {
    task = () => writeNotes(message, sender);
  } else {
    return false;
  }
  serialize(task).then(
    result => respond(result),
    error => respond({ error: error.message })
  );
  return true;
});
