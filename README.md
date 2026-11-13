# <img src="chrome-extension/icons/icon-48.png" width="32" height="32" alt=""> Zero Notes

Highlight text and leave comments. Notes stay in your browser.

[Try the live demo](https://madsolame.com/zero-notes/)

![Selecting a passage, posting a comment, and opening the Notes list](assets/demo.gif)

## Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `chrome-extension/` folder.
3. Open the extension on a page and click **Enable on this site**. Saved highlights appear automatically on enabled sites.

## Embed in HTML

Copy `local-text-notes.js` next to your HTML file and add:

```html
<script defer src="./local-text-notes.js"></script>
```

Select text to highlight or comment. Open **Notes** to see your highlights and manage comments.
