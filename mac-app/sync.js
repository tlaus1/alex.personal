// Copy the dashboard into the app bundle, applying Mac-app-only tweaks.
// The website source is never modified - every change happens on the copy.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'index.source.html');
const DST = path.join(__dirname, 'app', 'index.html');
if (!fs.existsSync(SRC)) { console.error('missing ' + SRC); process.exit(1); }

let html = fs.readFileSync(SRC, 'utf8');
const applied = [];

// 1) No decoy in the native app. The "site can't be reached" screen exists to
//    disguise a public URL; a local app behind the Mac login does not need it,
//    and having it flash up on idle is just noise. The Hide button and the
//    idle timer are neutralised together.
const nativeFlag = `
<script>
  // ---- injected by the Mac app build (see mac-app/sync.js) ----
  window.ALEXDB_NATIVE = true;
  window.addEventListener('DOMContentLoaded', function () {
    var kill = function () {
      var ov = document.getElementById('panicOverlay');
      if (ov) { ov.classList.remove('show'); ov.remove(); }
    };
    kill();
    // The dashboard re-arms an idle timer; blunt it rather than patching the
    // shared source, so the website keeps its disguise untouched.
    try { window.armIdleLock = function () {}; } catch (e) {}
    try { window.showPanic = function () {}; } catch (e) {}
    setTimeout(kill, 300);
    setInterval(kill, 2000);
  });
</script>
<style>
  /* the decoy must never paint in the app */
  #panicOverlay { display: none !important; }

  /* 2) translucency, only when the app asks for it (View menu toggle).
        A solid background is the default look when it is off. */
  html, body { background: #000 !important; }
  html.translucent, html.translucent body { background: transparent !important; }
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(circle at 20% 10%, rgba(10,132,255,0.10) 0%, transparent 45%),
      radial-gradient(circle at 80% 90%, rgba(125,80,240,0.08) 0%, transparent 45%),
      #000;
  }
  /* Enough tint that text stays readable over a busy wallpaper. */
  html.translucent body::before { background:
      radial-gradient(circle at 20% 10%, rgba(10,132,255,0.10) 0%, transparent 45%),
      radial-gradient(circle at 80% 90%, rgba(125,80,240,0.08) 0%, transparent 45%),
      rgba(0,0,0,0.62);
  }

  /* the frameless title area stays draggable */
  .dash-top { -webkit-app-region: drag; }
  .dash-top button, .dash-top input, .dash-top a { -webkit-app-region: no-drag; }
</style>
`;
html = html.replace('</head>', nativeFlag + '</head>');
applied.push('decoy removed', 'translucent background', 'draggable header');

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, html);

// The chat widget needs the same Supabase endpoint the dashboard uses. Pull the
// values out of the source rather than duplicating them, so they cannot drift.
function grab(name) {
  const m = html.match(new RegExp('const ' + name + " = '([^']+)'"));
  return m ? m[1] : '';
}
const cfg = {
  SUPABASE_URL: grab('SUPABASE_URL'),
  SUPABASE_KEY: grab('SUPABASE_KEY'),
  DASHBOARD_TOKEN: grab('DASHBOARD_TOKEN'),
};
if (!cfg.SUPABASE_URL || !cfg.DASHBOARD_TOKEN) {
  console.warn('  ! could not extract Supabase config - the chat widget will not work');
}
const cfgPath = path.join(__dirname, 'app', 'widgets', 'config.js');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, 'window.ALEXDB_CFG = ' + JSON.stringify(cfg, null, 2) + ';\n');
console.log(`synced dashboard -> app/index.html (${(fs.statSync(DST).size / 1024).toFixed(0)} KB)`);
console.log('  tweaks: ' + applied.join(', '));
