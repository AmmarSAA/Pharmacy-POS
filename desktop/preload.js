// Tells the web app it runs inside the desktop shell and offers direct receipt printing.
// Only these two calls are exposed; the page gets no Node access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pharmacyDesktop', {
  platform: process.platform,
  // html: the receipt markup; css: absolute URL of the app stylesheet. Resolves { ok, printer } or { ok:false, error }.
  printReceipt: (html, css) => ipcRenderer.invoke('print-receipt', { html: String(html), css: String(css || '') }),
})
