const { siteFor, siteKey } = LocalTextNotesSites;
const siteLabel = document.querySelector("#site");
const status = document.querySelector("#status");
const button = document.querySelector("button");
let enabled = false;

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = siteFor(tab?.url);
  if (!site) {
    status.textContent = "Local Text Notes can be enabled on regular web pages and local HTML files.";
    return;
  }

  const isFile = site.id === "file:///";
  siteLabel.textContent = site.label;
  siteLabel.hidden = false;
  if (isFile && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    status.textContent = 'Turn on “Allow access to file URLs” in the extension’s Chrome settings.';
    return;
  }

  const stored = await chrome.storage.local.get(siteKey);
  enabled = Boolean(stored[siteKey]?.includes(site.id))
    && await chrome.permissions.contains({ origins: [site.pattern] });
  render();
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const activate = !enabled;
    try {
      if (activate && !(await chrome.permissions.request({ origins: [site.pattern] }))) {
        status.textContent = "Chrome access was declined. This site is still off.";
        return;
      }
      const result = await chrome.runtime.sendMessage({
        type: "set-site", site: site.id, enabled: activate, tabId: tab.id
      });
      if (!result || result.error) throw new Error(result?.error || "Could not update site access.");
      enabled = activate;
      render(result.reload);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function render(reload) {
    const target = isFile ? "local files" : "this site";
    button.textContent = enabled ? `Disable on ${target}` : `Enable on ${target}`;
    button.toggleAttribute("data-enable", !enabled);
    if (enabled) {
      status.textContent = reload
        ? "Enabled. Reload the page to show saved highlights."
        : "Saved highlights appear automatically here.";
    } else {
      status.textContent = "Select text to highlight or comment once enabled.";
    }
  }
}

void start().catch(() => { status.textContent = "Could not check this page. Open the extension again to retry."; });
