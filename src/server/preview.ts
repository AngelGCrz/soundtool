// Vista previa del juego: archivos estáticos de dist/ o el Vite del propio juego (proxy).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import type { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import type { GameInfo } from "../shared/types.ts";

export const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".ktx2": "image/ktx2",
    ".basis": "application/octet-stream",
    ".atlas": "text/plain; charset=utf-8",
    ".plist": "application/xml",
    ".fnt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
    ".wasm": "application/wasm",
};
export const HTML_TYPE = "text/html; charset=utf-8";
export const JSON_TYPE = "application/json; charset=utf-8";

/** Sirve un archivo con soporte de Range (necesario para <audio> en algunos navegadores). */
export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error("not a file");
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("No encontrado");
        return;
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers = { "Content-Type": type, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
        start = Math.max(0, start);
        end = Math.min(end, stat.size - 1);
        if (start > end) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return;
        }
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
        if (req.method === "HEAD") return void res.end();
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return void res.end();
    fs.createReadStream(file).pipe(res);
}

export const HOOK_TAG = '<script src="/__soundtool/hook.js"></script>';

/** Inserta el script de escucha de SoundTool lo antes posible en el HTML del juego. */
export function injectHook(html: string, tag = HOOK_TAG): string {
    if (!tag || html.includes(tag)) return html;
    const m = /<head[^>]*>/i.exec(html);
    return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
}

/** Resuelve una URL dentro de una carpeta sin permitir salir de ella. */
export function safeJoin(root: string, urlPath: string): string | null {
    const decoded = decodeURIComponent(urlPath.split("?")[0]!);
    const p = path.normalize(path.join(root, decoded));
    return p === root || p.startsWith(root + path.sep) ? p : null;
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, game: GameInfo): void {
    const url = new URL(req.url ?? "/", "http://x");
    let pathname = url.pathname;
    let root = game.distDir;
    if (pathname.startsWith("/common/") && game.commonDir) {
        root = game.commonDir;
        pathname = pathname.slice("/common".length);
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = root ? safeJoin(root, pathname) : null;
    if (!file) {
        res.writeHead(403);
        res.end();
        return;
    }
    if (file.toLowerCase().endsWith(".html") && fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": HTML_TYPE, "Cache-Control": "no-store" });
        res.end(injectHook(fs.readFileSync(file, "utf8")));
        return;
    }
    sendFile(req, res, file);
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
    });
}

function waitForPort(port: number, timeoutMs: number, isAlive: () => boolean): Promise<void> {
    const until = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (!isAlive()) return reject(new Error("Vite se cerró al arrancar"));
            const sock = net.connect(port, "127.0.0.1");
            sock.once("connect", () => {
                sock.destroy();
                resolve();
            });
            sock.once("error", () => {
                sock.destroy();
                if (Date.now() > until) reject(new Error("Vite no respondió a tiempo"));
                else setTimeout(attempt, 300);
            });
        };
        attempt();
    });
}

export interface ViteProcess {
    port: number;
    child: ChildProcess;
    stop: () => void;
}

/** Arranca el Vite del juego en un puerto interno. */
export async function startVite(game: GameInfo, { onLog = (_line: string) => {} } = {}): Promise<ViteProcess> {
    if (!game.viteBin) throw new Error("Este juego no tiene Vite instalado");
    const port = await freePort();
    // Dentro de Electron no hay binario "node": usamos el propio ejecutable en modo Node.
    const child = spawn(process.execPath, [game.viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
        cwd: game.dir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BROWSER: "none", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (d: Buffer) => {
        output = (output + d.toString()).slice(-4000);
        onLog(d.toString());
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let alive = true;
    child.on("exit", () => (alive = false));
    try {
        await waitForPort(port, 90_000, () => alive);
    } catch (err) {
        child.kill();
        const e = err as Error;
        e.message += output ? `\n${output.trim()}` : "";
        throw e;
    }
    return { port, child, stop: () => void (alive && child.kill()) };
}

export function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, port: number): void {
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers["accept-encoding"]; // más simple para depurar; es tráfico local
    const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (up) => {
        if (!String(up.headers["content-type"] ?? "").includes("text/html")) {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
            return;
        }
        // HTML del juego: hay que insertar el script de escucha
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
            const body = Buffer.from(injectHook(Buffer.concat(chunks).toString("utf8")));
            const h: http.OutgoingHttpHeaders = { ...up.headers, "content-length": body.length, "cache-control": "no-store" };
            delete h["transfer-encoding"];
            delete h["etag"];
            res.writeHead(up.statusCode ?? 200, h);
            res.end(body);
        });
    });
    upstream.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Vite no responde: " + err.message);
    });
    req.pipe(upstream);
}

/** Websocket de Vite (HMR): se pasa tal cual. */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
    const up = net.connect(port, "127.0.0.1", () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i]!;
            lines.push(`${k}: ${k.toLowerCase() === "host" ? `127.0.0.1:${port}` : req.rawHeaders[i + 1]}`);
        }
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
    });
    const close = () => {
        up.destroy();
        socket.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
}
