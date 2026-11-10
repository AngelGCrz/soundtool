// Modo portal: abre cualquier juego publicado solo con playerId + gameId.
//
//   loader (HTML con window.initGame)  ->  gpath = CDN del juego, gcommon = versión de common/
//
// El juego se sirve desde SoundTool reescribiendo gpath para que sus assets pasen por aquí:
// así se pueden sustituir sonidos/JSON y escuchar lo que suena, igual que en local.
// JSON y audios se guardan en una caché local con la estructura de un juego
// (<cache>/public/assets/..., <cache>/common/...) sobre la que trabaja SoundSession.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./session.ts";
import { isAudioRef } from "./scan.ts";
import { injectHook } from "./preview.ts";
import type { PortalData, PortalEndpoint, Scope } from "../shared/types.ts";

export const DEFAULT_PORTAL = "https://demorgsv2.gdpteam.com";
// Lo que pasa por SoundTool (y se guarda en caché): JSON y audio, que son lo que se modifica,
// y fuentes/textos de datos, que fallan si se redirigen. Lo demás va directo al CDN.
const CACHE_EXT = /\.(json|mp3|ogg|wav|m4a|aac|webm|ttf|otf|woff2?|fnt|xml|plist|atlas|txt)$/i;
const UA = "SoundTool/0.1";

/** Respuestas del portal (solo los campos que usamos) */
interface PortalConfigResponse {
    demopage_api: string;
    game_loader: string;
}
interface PortalPageResponse {
    Endpoints?: { name: string; skin: string; uid: number; platformId?: string; langs?: string[]; enabled: boolean }[];
    Languages?: { name: string; code: string }[];
    Versions?: { game_id: string; game_name: string; game_tech?: string; latest_version?: { game_version?: string } }[];
}

export interface LoaderInfo {
    gpath: string;
    gcommon?: string;
    game?: string;
    gversion?: string;
}

async function getJson<T>(url: string): Promise<T> {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`${url} respondió ${r.status}`);
    return (await r.json()) as T;
}

let portalCache: { portal: string; at: number; data: PortalData } | null = null;

/** Configuración y lista de juegos del portal (se guarda 5 minutos). */
export async function fetchPortal(portal = DEFAULT_PORTAL): Promise<PortalData> {
    if (portalCache && portalCache.portal === portal && Date.now() - portalCache.at < 5 * 60_000) return portalCache.data;
    const base = portal.replace(/\/+$/, "");
    const cfg = await getJson<PortalConfigResponse>(base + "/config.json");
    const page = await getJson<PortalPageResponse>(cfg.demopage_api);
    const data: PortalData = {
        loader: cfg.game_loader,
        endpoints: (page.Endpoints ?? [])
            .map((e, index) => ({ index, name: e.name, skin: e.skin, uid: e.uid, platformId: e.platformId ?? "", langs: e.langs ?? ["eng"], enabled: e.enabled }))
            .filter((e) => e.enabled),
        langs: page.Languages ?? [],
        games: (page.Versions ?? []).map((g) => ({
            id: g.game_id,
            number: String(g.game_id).match(/\d+/)?.[0] ?? null,
            name: g.game_name,
            tech: g.game_tech || "cocos",
            version: g.latest_version?.game_version,
        })),
    };
    portalCache = { portal, at: Date.now(), data };
    return data;
}

export interface LoaderUrlOptions {
    loader: string;
    playerId: string;
    gameId: string;
    endpoint: Pick<PortalEndpoint, "skin" | "uid" | "platformId">;
    lang?: string;
    variation?: number;
    tech?: string;
}

/** Igual que el portal: intloadgame si el casino tiene platformId, si no loadgame (legacy). */
export function buildLoaderUrl({ loader, playerId, gameId, endpoint, lang = "eng", variation = 0, tech = "pixi" }: LoaderUrlOptions): string {
    const q = (o: Record<string, string | number>) =>
        Object.entries(o)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join("&");
    if (endpoint.platformId) {
        return `${loader}/intloadgame?${q({ mode: "real", playerId, variation: Number(variation) || 0, gameId, gameTech: tech, skin: endpoint.skin, lang, uid: endpoint.uid, platformId: endpoint.platformId })}`;
    }
    return `${loader}/loadgame?${q({ playerid: playerId, variation, gameid: gameId, skin: endpoint.skin, lang, uid: endpoint.uid })}`;
}

/** Extrae los datos de window.initGame del HTML del loader. */
export function parseLoader(html: string): LoaderInfo {
    const field = (k: string) => new RegExp(`\\b${k}\\s*:\\s*"([^"]*)"`).exec(html)?.[1];
    const gpath = field("gpath");
    if (!gpath) {
        const msg = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        throw new Error("El portal no devolvió el juego" + (msg ? `: ${msg}` : ". Revisa el playerId y el número de juego."));
    }
    return { gpath: gpath.replace(/\/+$/, ""), gcommon: field("gcommon"), game: field("game"), gversion: field("gversion") };
}

export class RemoteGame {
    readonly loaderUrl: string;
    readonly loaderBase: string;
    readonly gameId: string;
    readonly dataDir: string;
    /** Se cachearon JSON nuevos: hay que volver a escanear */
    dirty = false;

    // Se rellenan en prepare()
    gpath = "";
    version = "";
    commonBase = "";
    cacheDir = "";
    publicDir = "";
    commonDir = "";

    constructor({ loaderUrl, gameId, dataDir = DATA_DIR }: { loaderUrl: string; gameId: string; dataDir?: string }) {
        this.loaderUrl = loaderUrl;
        this.loaderBase = loaderUrl.slice(0, loaderUrl.lastIndexOf("/") + 1);
        this.gameId = gameId;
        this.dataDir = dataDir;
    }

    async #fetchLoader(): Promise<string> {
        const r = await fetch(this.loaderUrl, { headers: { "User-Agent": UA } });
        if (!r.ok) throw new Error(`El portal respondió ${r.status} al abrir ${this.gameId}`);
        return r.text();
    }

    /** Pide el juego al portal, prepara la caché y descarga JSON y sonidos. */
    async prepare(onProgress: (done: number, total: number) => void = () => {}): Promise<this> {
        const info = parseLoader(await this.#fetchLoader());
        this.gpath = info.gpath;
        this.version = info.gversion ?? "0";
        // CDN de common: el engine la calcula como origin(gpath) + /common/v<gcommon>/
        this.commonBase = `${new URL(info.gpath).origin}/common/v${info.gcommon}`;
        this.cacheDir = path.join(this.dataDir, "remote", `${this.gameId}-v${this.version}`);
        this.publicDir = path.join(this.cacheDir, "public");
        this.commonDir = path.join(this.cacheDir, "common");
        fs.mkdirSync(path.join(this.publicDir, "assets"), { recursive: true });
        fs.mkdirSync(this.commonDir, { recursive: true });

        const manifest = await this.cached("game", "assets/gameassets.json");
        await this.cached("game", "assets/json/config.json").catch(() => null);
        const refs = new Set<string>();
        const walk = (n: unknown): void => {
            if (typeof n === "string") {
                if ((n.endsWith(".json") || isAudioRef(n)) && n.startsWith("assets/") && !n.includes("{")) refs.add(n.split("?")[0]!);
            } else if (Array.isArray(n)) n.forEach(walk);
            else if (n && typeof n === "object") Object.values(n).forEach(walk);
        };
        walk(JSON.parse(manifest.toString("utf8")));
        const list = [...refs];
        let done = 0;
        await pool(list, 8, async (rel) => {
            await this.cached("game", rel).catch(() => null); // algún asset puede no existir en el CDN
            onProgress(++done, list.length);
        });
        this.dirty = false;
        return this;
    }

    #paths(kind: Scope, rel: string): { file: string; url: string; cacheable: boolean } {
        const clean = rel.replace(/^\/+/, "").replace(/\/{2,}/g, "/").split("?")[0]!;
        const root = kind === "common" ? this.commonDir : this.publicDir;
        const file = path.resolve(root, decodeURIComponent(clean));
        if (!file.startsWith(root + path.sep)) throw new Error("Ruta inválida");
        const url = `${kind === "common" ? this.commonBase : this.gpath}/${clean}`;
        return { file, url, cacheable: CACHE_EXT.test(clean) };
    }

    /** Devuelve el contenido (desde la caché o descargándolo y guardándolo). */
    async cached(kind: Scope, rel: string): Promise<Buffer> {
        const { file, url } = this.#paths(kind, rel);
        if (fs.existsSync(file)) return fs.readFileSync(file);
        const r = await fetch(url, { headers: { "User-Agent": UA } });
        if (!r.ok) throw Object.assign(new Error(`${url} → ${r.status}`), { status: r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        if (file.endsWith(".json")) this.dirty = true;
        return buf;
    }

    /** Ruta local en caché si ese recurso se cachea (JSON/audio/fuentes…), si no null. */
    cachePathFor(kind: Scope, rel: string): string | null {
        const p = this.#paths(kind, rel);
        return p.cacheable ? p.file : null;
    }

    upstreamUrl(kind: Scope, rel: string): string {
        return this.#paths(kind, rel).url;
    }

    /** HTML del loader (con token nuevo) reescrito para servirse desde SoundTool. */
    async pageHtml(hookTag: string): Promise<string> {
        let html = await this.#fetchLoader();
        const fresh = parseLoader(html);
        // gpath tiene que ser absoluto: el engine hace new URL(gpath) para calcular common/
        html = html.replace(/(\bgpath\s*:\s*)"[^"]*"/, `$1(location.origin + "/__remote/g")`);
        html = html
            .split(fresh.gpath + "/")
            .join("/__remote/g/")
            .split(fresh.gpath)
            .join("/__remote/g");
        return injectHook(html, hookTag);
    }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]!);
    });
    await Promise.all(workers);
}
