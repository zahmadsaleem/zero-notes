(() => {
  if (globalThis.startLocalTextNotesExtension) return;
  const { siteFor, pageUrl, noteKey, noteRecord, siteKey } = LocalTextNotesSites;

  function storageFor(url, signal) {
    const key = noteKey(url);
    const read = async () => noteRecord((await chrome.storage.local.get(key))[key]);
    return {
      async read() {
        return (await read()).notes;
      },
      async update(transform) {
        let current = await read();
        for (let attempt = 0; attempt < 8; attempt++) {
          signal.throwIfAborted();
          const notes = transform(current.notes);
          const result = await chrome.runtime.sendMessage({
            type: "write-notes", url, revision: current.revision, notes
          });
          if (result?.saved) return notes;
          if (!result?.current) throw new Error(result?.error || "Could not save notes.");
          current = result.current;
        }
        throw new Error("Notes changed too quickly to save.");
      },
      subscribe(listener) {
        const changed = (changes, area) => {
          if (area === "local" && key in changes) listener();
        };
        chrome.storage.onChanged.addListener(changed);
        signal.addEventListener("abort", () => chrome.storage.onChanged.removeListener(changed), { once: true });
      }
    };
  }

  let listening = false;
  globalThis.startLocalTextNotesExtension = start => {
    if (listening || document.contentType !== "text/html") return;
    const site = siteFor(location.href);
    if (!site) return;
    listening = true;
    let enabled = false;
    let receivedChange = false;
    let activePage = null;
    let controller = null;

    function refreshPage() {
      const url = enabled ? pageUrl(location.href) : null;
      if (url === activePage) return;
      controller?.abort();
      controller = null;
      activePage = url;
      if (!url) return;
      controller = new AbortController();
      start({ signal: controller.signal, storage: storageFor(url, controller.signal) });
    }

    function applySites(sites) {
      enabled = Boolean(sites?.includes(site.id));
      refreshPage();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(siteKey in changes)) return;
      receivedChange = true;
      applySites(changes[siteKey].newValue);
    });
    void chrome.storage.local.get(siteKey).then(items => {
      if (!receivedChange) applySites(items[siteKey]);
    }).catch(() => {});
    window.navigation?.addEventListener("currententrychange", refreshPage);
    window.addEventListener("pageshow", refreshPage);
    window.addEventListener("popstate", refreshPage);
    window.addEventListener("hashchange", refreshPage);
  };
})();
