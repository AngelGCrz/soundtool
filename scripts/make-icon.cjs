// Genera build/icon.png (1024×1024) a partir del logo. Uso: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232733"/><stop offset="1" stop-color="#121419"/></linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ea4ff"/><stop offset="1" stop-color="#3e6fe6"/></linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="184" fill="url(#bg)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="3"/>
  <g stroke="url(#bar)" stroke-width="72" stroke-linecap="round">
    <path d="M272 452v120M392 362v300M512 272v480M632 392v240M752 482v60"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html," + encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`));
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    const out = path.join(__dirname, "..", "build", "icon.png");
    fs.writeFileSync(out, img.resize({ width: 1024, height: 1024 }).toPNG());
    console.log("icono:", out, img.getSize());
    app.exit(0);
});
