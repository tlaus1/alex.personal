// alexdb - the dashboard as a native Mac app.
//
// WHY ELECTRON AND NOT A SWIFT/WKWebView WRAPPER:
//   The dashboard talks to the TI-84 over Web Serial and WebUSB. Safari and
//   WKWebView implement neither, so a native wrapper (or Tauri, which also uses
//   WKWebView on macOS) would silently break the calculator features. Electron
//   ships Chromium, so they behave exactly as they do in Chrome.
//
// The website at alexdb.xyz is unaffected; this loads a bundled copy of the
// same dashboard over a custom scheme so it has a stable origin (file:// sends
// "Origin: null", which upsets CORS on the Supabase calls).

const { app, BrowserWindow, session, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, 'app');
const SCHEME = 'alexdb';

// A standard scheme gets a real origin, secure context (needed for Web Serial),
// and normal fetch/localStorage behaviour.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// The calculator's CDC serial ids, as Electron reports them (decimal strings).
const CALC_VENDOR = String(0x16C0);   // 5824
const CALC_PRODUCT = String(0x05E1);  // 1505

let win = null;
const widgets = new Map();          // type -> BrowserWindow

// Translucency is a taste thing, so it is a toggle rather than a fixed choice.
const prefsFile = require('path').join(require('electron').app.getPath('userData'), 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(require('fs').readFileSync(prefsFile, 'utf8')); } catch (e) { return {}; }
}
function savePrefs(p) {
  try { require('fs').writeFileSync(prefsFile, JSON.stringify(p)); } catch (e) {}
}
let translucent = loadPrefs().translucent === true;    // off: vibrancy glitches on macOS 26+

// Small frameless panels that live on the desktop. They float above the
// wallpaper but below normal windows, so they behave like desktop widgets
// rather than always-on-top clutter.
const WIDGET_SIZES = {
  clock:  { width: 200, height: 118 },
  status: { width: 250, height: 168 },
  music:  { width: 258, height: 236 },
  chat:   { width: 340, height: 430 },
};

function toggleWidget(type) {
  const existing = widgets.get(type);
  if (existing && !existing.isDestroyed()) { existing.close(); return; }

  const size = WIDGET_SIZES[type] || WIDGET_SIZES.clock;
  const w = new BrowserWindow({
    ...size,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Every widget lives on the desktop: visible on all Spaces, below ordinary
  // windows. The chat is still clickable, but you need the desktop in view to
  // reach it - that is the trade for it never covering your work.
  w.setAlwaysOnTop(true, 'desktop');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  w.loadURL(`${SCHEME}://dashboard/widgets/widget.html?type=${encodeURIComponent(type)}`);
  w.on('closed', () => widgets.delete(type));
  widgets.set(type, w);
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'Widgets',
      submenu: [
        { label: 'Clock on Desktop', accelerator: 'Cmd+Alt+1', click: () => toggleWidget('clock') },
        { label: 'PC Status on Desktop', accelerator: 'Cmd+Alt+2', click: () => toggleWidget('status') },
        { label: 'Ambient Sound on Desktop', accelerator: 'Cmd+Alt+3', click: () => toggleWidget('music') },
        { label: 'Claude Chat on Desktop', accelerator: 'Cmd+Alt+4', click: () => toggleWidget('chat') },
        { type: 'separator' },
        { label: 'Close All Widgets', click: () => { for (const w of widgets.values()) if (!w.isDestroyed()) w.close(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: 'Translucent Background (experimental)',
          type: 'checkbox',
          checked: translucent,
          click: (item) => {
            translucent = item.checked;
            savePrefs({ ...loadPrefs(), translucent });
            // Vibrancy can only be set at creation time, so rebuild the window.
            const old = win;
            createWindow();
            if (old && !old.isDestroyed()) old.close();
            buildMenu();
          },
        },
        { type: 'separator' }, { role: 'togglefullscreen' },
        { label: 'Toggle Developer Tools', accelerator: 'Cmd+Alt+I',
          click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    titleBarStyle: 'hiddenInset',      // keeps the traffic lights, drops the bar
    // NB: do NOT set transparent:true alongside vibrancy - together they cause
    // macOS repaint artifacts (smearing squares). Vibrancy alone is correct.
    backgroundColor: '#000000',
    ...(translucent ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const ses = win.webContents.session;

  // ---- Web Serial: Chromium asks us which port the user picked ----
  // Without this handler the picker never resolves and connect() hangs.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    const calc = portList.find(p => p.vendorId === CALC_VENDOR && p.productId === CALC_PRODUCT);
    if (calc) return callback(calc.portId);
    // No calculator: cancel rather than handing back an unrelated port.
    callback('');
  });

  // ---- WebUSB (the file-transfer path) ----
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const d = details.deviceList[0];
    callback(d ? d.deviceId : undefined);
  });

  // Grant only what the dashboard actually uses.
  const ALLOWED = new Set(['serial', 'usb', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);
  ses.setPermissionRequestHandler((wc, permission, done) => done(ALLOWED.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
  ses.setDevicePermissionHandler(() => true);

  // Links to real sites open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Surface renderer errors in the terminal - the app has no visible devtools.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer ${level === 3 ? 'error' : 'warn'}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[load failed] ${code} ${desc} ${url}`);
  });
  win.webContents.on('did-finish-load', () => console.log('[ok] dashboard loaded'));

  win.loadURL(`${SCHEME}://dashboard/index.html`);
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    // Strip the leading slash and refuse anything trying to climb out.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.join(APP_DIR, rel);
    if (!path.resolve(full).startsWith(path.resolve(APP_DIR))) {
      return new Response('forbidden', { status: 403 });
    }
    if (!fs.existsSync(full)) return new Response('not found', { status: 404 });
    const ext = path.extname(full).toLowerCase();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
                    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    return new Response(fs.readFileSync(full), {
      headers: { 'Content-Type': types[ext] || 'application/octet-stream' },
    });
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
