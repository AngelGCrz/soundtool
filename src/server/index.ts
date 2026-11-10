// Servidor local de SoundTool.
//   /__soundtool/...      interfaz y API
//   todo lo demás         el juego (dist/ estático, proxy al Vite del juego o juego del portal),
//                         con los cambios pendientes sustituidos al vuelo.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type net from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { listGames } from "./scan.ts";
import { SoundSession, DATA_DIR } from "./session.ts";
import { HOOK_TAG, HTML_TYPE, JSON_TYPE, sendFile, safeJoin, serveStatic, startVite, proxyHttp, proxyUpgrade, type ViteProcess } from "./preview.ts";
import { RemoteGame, fetchPortal, buildLoaderUrl, DEFAULT_PORTAL } from "./remote.ts";
import type { AppConfig, AppState, DiscoverResponse, JsonPath, PreviewMode, PreviewState, RemoteSettings, RestoreResponse, SaveResponse, Scope, SoundView } from "../shared/types.ts";

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
// Codificador MP3 para el navegador (convierte WAV/OGG/… a MP3 antes de subirlo)
const VENDOR: Record<string, string> = { "lame.min.js": createRequire(import.meta.url).resolve("lamejs/lame.min.js") };
const PREFIX = "/__soundtool";
const MAX_UPLOAD = 100 * 1024 * 1024;
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const IMAGE_RE = /\.(png|webp|jpe?g|gif|ktx2|basis|avif)$/i;

const DEFAULT_REMOTE: RemoteSettings = { portal: DEFAULT_PORTAL, playerId: "", endpointIndex: 0, lang: "eng", recent: [] };

/** Error con código HTTP */
class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function loadConfig(): AppConfig {
    let cfg: Partial<AppConfig> = {};
    try {
        cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<AppConfig>;
    } catch {
        // primera vez: sin configuración
    }
    return { gamesDir: null, recent: [], ...cfg, remote: { ...DEFAULT_REMOTE, ...(cfg.remote ?? {}) } };
}

function saveConfig(cfg: AppConfig): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export type PickFolder = (prompt: string) => Promise<string | null>;

/** Selector de carpeta nativo cuando no estamos dentro de Electron. */
const nativePickFolder: PickFolder = (prompt) => {
    const run = (cmd: string, args: string[]) =>
        new Promise<string | null>((resolve) =>
            execFile(cmd, args, (err, stdout) => resolve(err ? null : stdout.trim().replace(/[\\/]$/, "") || null))
        );
    if (process.platform === "darwin") {
        return run("osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
    }
    if (process.platform === "win32") {
        const ps =
            "Add-Type -AssemblyName System.Windows.Forms;" +
            "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
            `$d.Description=${JSON.stringify(prompt).replace(/"/g, "'")};` +
            "if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}";
        return run("powershell", ["-NoProfile", "-STA", "-Command", ps]);
    }
    return run("zenity", ["--file-selection", "--directory", `--title=${prompt}`]);
};

function readBody(req: http.IncomingMessage, limit = MAX_UPLOAD): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > limit) {
                reject(new HttpError(413, "Archivo demasiado grande (máx. 100 MB)"));
                req.destroy();
            } else chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
}

function placeholder(msg: string, refresh = false): string {
    return `<!doctype html><html><head><meta charset="utf-8">${refresh ? '<meta http-equiv="refresh" content="2">' : ""}
<style>html,body{height:100%;margin:0;background:#101114;color:#9aa0aa;font:15px system-ui,sans-serif;display:grid;place-items:center;text-align:center}</style>
</head><body><div>${msg}</div></body></html>`;
}

/** Cuerpos JSON que acepta la API */
interface Bodies {
    config: { gamesDir?: string | null };
    "pick-folder": { prompt?: string };
    open: { dir: string };
    "remote-config": { playerId?: string; endpointIndex?: number; lang?: string };
    "open-remote": { gameId: string };
    preview: { mode: PreviewMode };
    discover: { urls?: string[] };
    value: { json: string; path: JsonPath; value?: unknown; reset?: boolean };
    restore: { id: string };
    cues: { cues: unknown };
}

export interface ServerOptions {
    port?: number;
    host?: string;
    pickFolder?: PickFolder;
    log?: (...args: unknown[]) => void;
}

export interface SoundToolServer {
    url: string;
    port: number;
    openGame: (dir: string) => Promise<void>;
    close: () => void;
}

interface Preview extends PreviewState {
    vite?: ViteProcess;
}

export async function startServer({ port = 5177, host = "127.0.0.1", pickFolder = nativePickFolder, log = console.log }: ServerOptions = {}): Promise<SoundToolServer> {
    const config = loadConfig();
    let session: SoundSession | null = null;
    /** Juego abierto desde el portal (null en modo local) */
    let remote: RemoteGame | null = null;
    let preview: Preview = { mode: "none", status: "ready", available: [] };

    const needGame = (): SoundSession => {
        if (!session) throw new HttpError(409, "No hay juego abierto");
        return session;
    };

    const stopPreview = () => {
        preview.vite?.stop();
        preview = { mode: "none", status: "ready", available: [] };
    };

    const setPreview = async (wanted: PreviewMode): Promise<void> => {
        preview.vite?.stop();
        const game = needGame().game;
        const available: PreviewMode[] = [];
        if (game.distDir) available.push("dist");
        if (game.viteBin) available.push("vite");
        const mode = available.includes(wanted) ? wanted : (available[0] ?? "none");
        const current: Preview = { mode, status: mode === "vite" ? "starting" : "ready", available };
        preview = current;
        if (mode !== "vite") return;
        try {
            const vite = await startVite(game);
            if (preview !== current) return vite.stop(); // cambiaron de juego mientras arrancaba
            current.vite = vite;
            current.status = "ready";
        } catch (err) {
            if (preview !== current) return;
            current.status = "error";
            current.error = (err as Error).message;
            log("[soundtool] Vite:", current.error);
        }
    };

    const replaceSession = (next: SoundSession, nextRemote: RemoteGame | null) => {
        stopPreview();
        session?.dispose();
        session = next;
        remote = nextRemote;
    };

    const openGame = async (dir: string): Promise<void> => {
        const next = new SoundSession(dir);
        replaceSession(next, null);
        config.recent = [next.game.dir, ...config.recent.filter((d) => d !== next.game.dir)].slice(0, 8);
        saveConfig(config);
        // dist/ es instantáneo y no necesita nada instalado; Vite queda como alternativa
        void setPreview(next.game.distDir ? "dist" : "vite");
    };

    const openRemote = async (gameId: string): Promise<void> => {
        const r = config.remote;
        if (!/^\w+$/.test(String(r.playerId ?? ""))) throw new Error("Escribe tu playerId.");
        const portal = await fetchPortal(r.portal);
        const endpoint = portal.endpoints.find((e) => e.index === Number(r.endpointIndex)) ?? portal.endpoints[0];
        if (!endpoint) throw new Error("El portal no tiene casinos habilitados.");
        const wanted = String(gameId).toUpperCase();
        const game = portal.games.find((g) => g.id.toUpperCase() === wanted || g.number === String(gameId));
        if (!game) throw new Error(`El juego ${gameId} no está en el portal.`);
        const loaderUrl = buildLoaderUrl({ loader: portal.loader, playerId: r.playerId, gameId: game.id, endpoint, lang: r.lang, tech: game.tech });
        const rg = await new RemoteGame({ loaderUrl, gameId: game.id }).prepare();
        const next = new SoundSession(rg.cacheDir, {
            remote: { gameId: game.id, name: game.name, version: rg.version, loaderUrl, casino: endpoint.name },
        });
        replaceSession(next, rg);
        preview = { mode: "remote", status: "ready", available: [] };
        r.recent = [game.id, ...r.recent.filter((x) => x !== game.id)].slice(0, 8);
        saveConfig(config);
    };

    const state = (): AppState => {
        const base = { config, dataDir: DATA_DIR };
        if (!session) {
            return {
                ...base,
                game: null,
                preview: { mode: "none", status: "ready", available: [] },
                warnings: [],
                sounds: [],
                moments: [],
                aliases: [],
                pendingCount: 0,
                pendingSummary: [],
                cues: [],
                cuesChanged: false,
            };
        }
        const s = session;
        const sounds: SoundView[] = [...s.sounds.values()].map((snd) => {
            const p = s.pending.get(snd.id);
            return { ...snd, pending: p ? { name: p.name, ext: p.ext, size: p.size } : null };
        });
        for (const [alias, n] of s.pendingNew) {
            sounds.unshift({
                id: "new:" + alias,
                scope: "game",
                rel: n.rel,
                url: n.url,
                ext: n.ext,
                size: n.size,
                mtime: 0,
                missing: false,
                audio: null,
                isNew: true,
                refs: [{ alias, json: s.manifest?.json ?? "", key: "", value: n.rel, path: [] }],
                pending: { name: n.name, ext: n.ext, size: n.size },
            });
        }
        return {
            ...base,
            game: {
                ...s.game,
                backups: s.remote ? 0 : s.listBackups().length,
                manifest: s.manifest,
                remote: s.remote,
                ...(s.remote && { name: s.remote.gameId, number: s.remote.gameId.match(/\d+/)?.[0] ?? null }),
            },
            preview: { mode: preview.mode, status: preview.status, error: preview.error, available: preview.available },
            warnings: s.warnings,
            sounds,
            aliases: [...s.aliases.keys(), ...s.pendingNew.keys()].sort(new Intl.Collator("es", { numeric: true }).compare),
            moments: s.momentsView(),
            pendingCount: s.pendingCount,
            pendingSummary: s.pendingSummary(),
            cues: s.cues,
            cuesChanged: s.pendingCues !== null,
        };
    };

    async function api(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void> {
        const body = async <K extends keyof Bodies>(_route: K): Promise<Partial<Bodies[K]>> =>
            JSON.parse((await readBody(req, 1e6)).toString("utf8") || "{}") as Partial<Bodies[K]>;
        const param = (k: string) => url.searchParams.get(k) ?? "";
        const route_ = `${req.method} ${route}`;

        switch (route_) {
            case "GET state":
                return sendJson(res, 200, state());

            case "GET games":
                return sendJson(res, 200, listGames(config.gamesDir));

            case "POST config": {
                const { gamesDir } = await body("config");
                if (gamesDir && !fs.existsSync(gamesDir)) throw new Error("La carpeta no existe");
                config.gamesDir = gamesDir || null;
                saveConfig(config);
                return sendJson(res, 200, state());
            }

            case "POST pick-folder": {
                const { prompt } = await body("pick-folder");
                return sendJson(res, 200, { path: await pickFolder(prompt || "Elige una carpeta") });
            }

            case "POST open": {
                const { dir } = await body("open");
                if (!dir) throw new Error("Falta la carpeta");
                await openGame(dir);
                return sendJson(res, 200, state());
            }

            case "GET portal": {
                const portal = await fetchPortal(config.remote.portal);
                return sendJson(res, 200, { ...portal, settings: config.remote });
            }

            case "POST remote-config": {
                const { playerId, endpointIndex, lang } = await body("remote-config");
                if (playerId !== undefined) config.remote.playerId = String(playerId).trim();
                if (endpointIndex !== undefined) config.remote.endpointIndex = Number(endpointIndex);
                if (lang !== undefined) config.remote.lang = String(lang);
                saveConfig(config);
                return sendJson(res, 200, { settings: config.remote });
            }

            case "POST open-remote": {
                const { gameId } = await body("open-remote");
                if (!gameId) throw new Error("Falta el número de juego");
                await openRemote(gameId);
                return sendJson(res, 200, state());
            }

            case "GET remote-dirty":
                return sendJson(res, 200, { dirty: !!remote?.dirty });

            case "GET export": {
                const { name, zip } = needGame().exportZip();
                res.writeHead(200, {
                    "Content-Type": "application/zip",
                    "Content-Length": zip.length,
                    "Content-Disposition": `attachment; filename="${name}"`,
                    "Cache-Control": "no-store",
                });
                res.end(zip);
                return;
            }

            case "POST preview": {
                needGame();
                const { mode } = await body("preview");
                await setPreview(mode ?? "none");
                return sendJson(res, 200, state());
            }

            case "POST rescan":
                needGame().rescan();
                if (remote) remote.dirty = false;
                return sendJson(res, 200, state());

            case "GET file": {
                const s = needGame();
                const alias = param("alias");
                if (alias) {
                    const f = s.fileForAlias(alias);
                    return f ? sendFile(req, res, f) : sendJson(res, 404, { error: "Sonido desconocido" });
                }
                const id = param("id");
                if (id.startsWith("new:")) {
                    const n = s.pendingNew.get(id.slice(4));
                    return n ? sendFile(req, res, n.file) : sendJson(res, 404, { error: "Sin cambio pendiente" });
                }
                if (param("which") === "pending") {
                    const p = s.pending.get(id);
                    return p ? sendFile(req, res, p.file) : sendJson(res, 404, { error: "Sin cambio pendiente" });
                }
                const f = s.originalFile(id);
                return f ? sendFile(req, res, f) : sendJson(res, 404, { error: "El archivo original no existe" });
            }

            case "PUT pending":
                needGame().stage(param("id"), await readBody(req), param("name"));
                return sendJson(res, 200, state());

            case "DELETE pending": {
                const s = needGame();
                const id = param("id");
                if (id.startsWith("new:")) s.unstageNew(id.slice(4));
                else if (id) s.unstage(id);
                else s.discardAll();
                return sendJson(res, 200, state());
            }

            case "PUT new-sound":
                needGame().stageNew(param("alias"), await readBody(req), param("name"));
                return sendJson(res, 200, state());

            case "POST discover": {
                const { urls } = await body("discover");
                const s = needGame();
                const added = (urls ?? []).filter((u) => s.discover(u));
                const result: DiscoverResponse = added.length ? state() : { unchanged: true };
                return sendJson(res, 200, result);
            }

            case "POST value": {
                const s = needGame();
                const { json: jsonRel, path: p, value, reset } = await body("value");
                if (!jsonRel || !Array.isArray(p)) throw new Error("Ruta inválida");
                if (reset) s.resetValue(jsonRel, p);
                else s.setValue(jsonRel, p, value);
                return sendJson(res, 200, state());
            }

            case "PUT cues": {
                const { cues } = await body("cues");
                needGame().setCues(cues);
                return sendJson(res, 200, state());
            }

            case "POST save": {
                const result: SaveResponse = { saved: needGame().save(), state: state() };
                return sendJson(res, 200, result);
            }

            case "GET backups":
                return sendJson(res, 200, needGame().listBackups());

            case "POST restore": {
                const { id } = await body("restore");
                const s = needGame();
                if (s.pendingCount) throw new Error("Primero guarda o descarta los cambios pendientes");
                if (!id) throw new Error("Falta el guardado a restaurar");
                const result: RestoreResponse = { restored: s.restore(id), state: state() };
                return sendJson(res, 200, result);
            }

            default:
                return sendJson(res, 404, { error: "Ruta desconocida" });
        }
    }

    async function pipeUpstream(res: http.ServerResponse, upstream: string): Promise<void> {
        let r: Response;
        try {
            r = await fetch(upstream, { headers: { "User-Agent": "SoundTool/0.1" } });
        } catch (err) {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            res.end((err as Error).message);
            return;
        }
        const headers: Record<string, string> = { "Cache-Control": "no-store" };
        for (const h of ["content-type", "last-modified"]) {
            const v = r.headers.get(h);
            if (v) headers[h] = v;
        }
        res.writeHead(r.status, headers);
        if (!r.body) return void res.end();
        Readable.fromWeb(r.body as WebReadableStream).pipe(res);
    }

    /** Juego del portal: página reescrita, assets del CDN (con caché) y cambios pendientes. */
    async function serveRemote(req: http.IncomingMessage, res: http.ServerResponse, url: URL, s: SoundSession, rg: RemoteGame): Promise<void> {
        const p = url.pathname;
        if (p === "/" || p === "/index.html") {
            res.writeHead(200, { "Content-Type": HTML_TYPE, "Cache-Control": "no-store" });
            res.end(await rg.pageHtml(HOOK_TAG));
            return;
        }
        let kind: Scope | null = null;
        let rel = "";
        if (p.startsWith("/__remote/g/")) {
            kind = "game";
            rel = p.slice("/__remote/g/".length);
        } else if (/^\/common\/v[^/]+\//.test(p)) {
            kind = "common";
            rel = p.replace(/^\/common\/v[^/]+\//, "");
        }
        if (!kind) {
            // Recursos del propio loader (gdputils/…, favicon)
            return pipeUpstream(res, rg.loaderBase + p.replace(/^\/+/, "") + url.search);
        }
        rel = rel.replace(/^\/+/, "").replace(/\/{2,}/g, "/"); // el CDN usa rutas como common/v1//snds/…
        const localUrl = (kind === "common" ? "/common/" : "/") + decodeURIComponent(rel);
        const override = s.overrideForUrl(localUrl);
        if (override) return sendFile(req, res, override.file);

        const cachePath = rg.cachePathFor(kind, rel);
        if (!cachePath) {
            if (IMAGE_RE.test(rel)) {
                // Las imágenes (la mayoría de las descargas) van directo al CDN: HTTP/2 y permite CORS.
                // Por aquí el navegador solo abre 6 conexiones y el juego tarda mucho más en cargar.
                res.writeHead(302, { Location: rg.upstreamUrl(kind, rel) + url.search, "Cache-Control": "no-store" });
                res.end();
                return;
            }
            // El JS NO se puede redirigir: los módulos quedarían cargados desde dos orígenes
            // (dos copias del engine) y el juego falla al arrancar.
            return pipeUpstream(res, rg.upstreamUrl(kind, rel) + url.search);
        }
        try {
            await rg.cached(kind, rel);
        } catch (err) {
            res.writeHead((err as { status?: number }).status ?? 502, { "Content-Type": "text/plain; charset=utf-8" });
            res.end((err as Error).message);
            return;
        }
        if (kind === "game") {
            const patched = s.patchedJsonForUrl(localUrl, rg.publicDir);
            if (patched != null) {
                res.writeHead(200, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" });
                res.end(patched);
                return;
            }
        }
        sendFile(req, res, cachePath);
    }

    /** Juego local: dist/ o Vite, con sonidos y JSON pendientes sustituidos. */
    function serveLocal(req: http.IncomingMessage, res: http.ServerResponse, url: URL, s: SoundSession): void {
        const urlPath = decodeURIComponent(url.pathname);
        const override = s.overrideForUrl(urlPath);
        if (override) return sendFile(req, res, override.file); // el juego pide el mp3 original y recibe el nuevo
        const servedRoot = preview.mode === "dist" ? s.game.distDir : s.game.publicDir;
        const patched = s.patchedJsonForUrl(urlPath, servedRoot);
        if (patched != null) {
            res.writeHead(200, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" });
            res.end(patched);
            return;
        }
        if (preview.mode === "dist") return serveStatic(req, res, s.game);
        if (preview.mode === "vite" && preview.status === "ready" && preview.vite) return proxyHttp(req, res, preview.vite.port);

        res.writeHead(200, { "Content-Type": HTML_TYPE, "Cache-Control": "no-store" });
        const msg =
            preview.status === "starting"
                ? "Arrancando el juego…"
                : preview.status === "error"
                  ? "No se pudo arrancar el juego."
                  : "Este juego no tiene vista previa (no hay dist/ ni Vite instalado).<br>Puedes reemplazar sonidos igualmente.";
        res.end(placeholder(msg, preview.status === "starting"));
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
            if (url.pathname === "/favicon.ico" && !session) return void res.writeHead(204).end();

            if (url.pathname === PREFIX || url.pathname === PREFIX + "/") {
                return sendFile(req, res, path.join(UI_DIR, "index.html"));
            }
            if (url.pathname.startsWith(PREFIX + "/vendor/")) {
                const f = VENDOR[url.pathname.slice((PREFIX + "/vendor/").length)];
                return f ? sendFile(req, res, f) : void res.writeHead(404).end();
            }
            if (url.pathname.startsWith(PREFIX + "/api/")) {
                return await api(req, res, url.pathname.slice((PREFIX + "/api/").length), url);
            }
            if (url.pathname.startsWith(PREFIX + "/")) {
                const f = safeJoin(UI_DIR, url.pathname.slice(PREFIX.length));
                return f ? sendFile(req, res, f) : void res.writeHead(403).end();
            }

            // ---- Juego ----
            if (!session) {
                res.writeHead(200, { "Content-Type": HTML_TYPE });
                res.end(placeholder("Elige un juego para verlo aquí."));
                return;
            }
            if (remote) return await serveRemote(req, res, url, session, remote);
            serveLocal(req, res, url, session);
        } catch (err) {
            if (!res.headersSent) sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
            else res.end();
        }
    });

    server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        if (preview.mode === "vite" && preview.status === "ready" && preview.vite) proxyUpgrade(req, socket, head, preview.vite.port);
        else socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    }).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE" || port === 0) throw err;
        await new Promise<void>((resolve) => server.listen(0, host, resolve));
    });

    const actual = (server.address() as net.AddressInfo).port;
    return {
        url: `http://${host}:${actual}${PREFIX}/`,
        port: actual,
        openGame,
        close: () => {
            stopPreview();
            session?.dispose();
            server.close();
        },
    };
}
