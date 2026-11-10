// Compila SoundTool a dist/:
//   dist/server, dist/electron, dist/bin, dist/shared   ← tsc (src/ excepto ui/)
//   dist/ui/app.js (módulo), dist/ui/hook.js (script clásico), index.html, styles.css   ← esbuild
// Uso: node scripts/build.ts   (Node ≥ 22.18 ejecuta TypeScript directamente)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const ui = path.join(root, "src/ui");
const require = createRequire(import.meta.url);

fs.rmSync(dist, { recursive: true, force: true });

// 1. Servidor, Electron y CLI
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(root, "tsconfig.json")], { stdio: "inherit" });

// 2. Interfaz
const out = path.join(dist, "ui");
await build({
    entryPoints: [path.join(ui, "app.ts")],
    outfile: path.join(out, "app.js"),
    bundle: true,
    format: "esm",
    target: "es2022",
    sourcemap: true,
    logLevel: "warning",
});
// El hook se inyecta en el juego como <script> normal: tiene que ejecutarse antes que sus módulos
await build({
    entryPoints: [path.join(ui, "hook.ts")],
    outfile: path.join(out, "hook.js"),
    bundle: true,
    format: "iife",
    target: "es2020",
    logLevel: "warning",
});
for (const f of ["index.html", "styles.css"]) fs.copyFileSync(path.join(ui, f), path.join(out, f));

console.log("SoundTool compilado en dist/");
