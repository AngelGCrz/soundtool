#!/usr/bin/env node
// Modo navegador (sin Electron): soundtool [carpeta-del-juego] [--port 5177] [--no-open]
import { execFile } from "node:child_process";
import { startServer } from "../server/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? def) : def;
};

if (flag("--help") || flag("-h")) {
    console.log(`SoundTool — reemplazar sonidos de juegos Pixi

Uso: soundtool [carpeta-del-juego] [--port 5177] [--no-open]

Sin carpeta, eliges el juego desde la ventana.`);
    process.exit(0);
}

const gameDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const srv = await startServer({ port: Number(opt("--port", "5177")) });
if (gameDir) {
    try {
        await srv.openGame(gameDir);
    } catch (err) {
        console.error("No se pudo abrir el juego:", (err as Error).message);
    }
}
console.log(`SoundTool listo en ${srv.url}\n(Ctrl+C para salir)`);

if (!flag("--no-open")) {
    const [cmd, cmdArgs]: [string, string[]] =
        process.platform === "darwin" ? ["open", [srv.url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", srv.url]] : ["xdg-open", [srv.url]];
    execFile(cmd, cmdArgs, () => {});
}

const quit = () => {
    srv.close();
    process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
