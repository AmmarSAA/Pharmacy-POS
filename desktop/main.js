// Pharmacy POS desktop shell: runs the web app (same data as the website) in its own window and
// prints receipts straight to the chosen receipt printer, without the print dialog.
const { app, BrowserWindow, Menu, session, shell, dialog, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULT_URL = 'https://pharmacy.z88.tech'

// <userData>/config.json → { "url": "https://…", "receiptPrinter": "EPSON TM-T20" }
const configFile = () => path.join(app.getPath('userData'), 'config.json')
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  } catch {
    return {}
  }
}
function writeConfig(patch) {
  try {
    fs.writeFileSync(configFile(), JSON.stringify({ ...readConfig(), ...patch }, null, 2))
  } catch { /* ignore */ }
}
const APP_URL = process.env.PHARMACY_URL || readConfig().url || DEFAULT_URL
const APP_ORIGIN = new URL(APP_URL).origin

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')
function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    return { width: 1360, height: 860 }
  }
}

let win

// Microphone (assistant voice), camera (barcode scanning), copying and fullscreen are allowed for the
// pharmacy site only; every other permission and every other site is refused.
const ALLOWED = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])
const originOf = (url) => { try { return new URL(url).origin } catch { return '' } }
function allowAppPermissionsOnly() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(ALLOWED.has(permission) && originOf(details.requestingUrl || wc.getURL()) === APP_ORIGIN))
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    ALLOWED.has(permission) && originOf(requestingOrigin) === APP_ORIGIN)
}

// ---- receipt printing ----
const escAttr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c])

async function printReceipt({ html, css }) {
  const printer = readConfig().receiptPrinter || ''
  // Scripts off: the window only lays out the receipt the app sent.
  const pw = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    const cssLink = originOf(css) === APP_ORIGIN ? `<link rel="stylesheet" href="${escAttr(css)}">` : ''
    const page = `<!doctype html><html><head><meta charset="utf-8">${cssLink}
      <style>body{margin:0;background:#fff;color:#000} #print-area{display:block!important}</style></head>
      <body><div id="print-area">${html}</div></body></html>`
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
    const ok = await new Promise((resolve) => {
      pw.webContents.print(
        { silent: Boolean(printer), deviceName: printer || undefined, printBackground: false, margins: { marginType: 'none' } },
        (success, reason) => resolve(success ? { ok: true, printer } : { ok: false, error: reason || 'Printing failed' }),
      )
    })
    return ok
  } finally {
    pw.destroy()
  }
}

async function choosePrinter() {
  const printers = await win.webContents.getPrintersAsync()
  if (!printers.length) {
    await dialog.showMessageBox(win, { type: 'info', message: 'No printers are installed on this computer.' })
    return
  }
  const current = readConfig().receiptPrinter || ''
  const names = printers.map((p) => p.name)
  const buttons = ['Ask every time (print dialog)', ...names, 'Cancel']
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Receipt printer',
    message: 'Print receipts directly to:',
    detail: current ? `Now: ${current}` : 'Now: the print dialog opens for each receipt.',
    buttons,
    cancelId: buttons.length - 1,
    noLink: true,
  })
  if (response === buttons.length - 1) return
  writeConfig({ receiptPrinter: response === 0 ? '' : names[response - 1] })
}

function createWindow() {
  const bounds = loadBounds()
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: 'Pharmacy POS',
    backgroundColor: '#0f7b6c',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  if (bounds.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  win.on('close', () => {
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }))
    } catch { /* ignore */ }
  })

  // Links to other sites open in the normal browser; the app itself stays in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (originOf(url) !== APP_ORIGIN) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return
    if (originOf(url) !== APP_ORIGIN) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // No connection and nothing cached yet → friendly offline screen with a retry button.
  // (After the first visit the app's own service worker opens it offline.)
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = navigation aborted, not an error
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL } })
  })

  win.loadURL(APP_URL)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Point of sale', accelerator: 'CmdOrCtrl+Shift+P', click: () => win?.loadURL(`${APP_URL}/#/pos`) },
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+Shift+H', click: () => win?.loadURL(`${APP_URL}/#/home`) },
        { type: 'separator' },
        { label: 'Receipt printer…', click: () => choosePrinter() },
        { label: 'Print page…', accelerator: 'CmdOrCtrl+P', click: () => win?.webContents.print() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => win?.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => win?.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Open in web browser', click: () => shell.openExternal(win?.webContents.getURL().startsWith('http') ? win.webContents.getURL() : APP_URL) },
        {
          label: 'About Pharmacy POS',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'Pharmacy POS',
            message: `Pharmacy POS ${app.getVersion()}`,
            detail: `Server: ${APP_URL}\nReceipt printer: ${readConfig().receiptPrinter || 'print dialog'}`,
          }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// One window only: opening the app again focuses the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(() => {
    allowAppPermissionsOnly()
    // Only the pharmacy site may ask for a receipt to be printed.
    ipcMain.handle('print-receipt', (event, payload) => {
      if (originOf(event.senderFrame?.url || '') !== APP_ORIGIN) return { ok: false, error: 'Not allowed' }
      return printReceipt(payload || {})
    })
    buildMenu()
    createWindow()
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
  })
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
}
