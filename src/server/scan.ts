// Detecta la estructura de un juego y encuentra todos los sonidos que sus JSON referencian.
// No depende del engine: cualquier string en un JSON que termine en una extensión de audio
// se considera una referencia a un sonido.
import fs from "node:fs";
import path from "node:path";
import { mp3Info } from "./mp3info.ts";
import type { GameInfo, JsonPath, LocalGame, Scope, Sound } from "../shared/types.ts";

export const AUDIO_EXT = [".mp3", ".ogg", ".wav", ".m4a", ".aac", ".webm"];

const MAX_JSON_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);
const GENERIC_KEYS = /^(file|src|url|path|sound|snd|audio|name|mp3)$/i;

const posix = (p: string) => p.split(path.sep).join("/");
const isInside = (root: string, p: string) => {
    const r = path.relative(root, p);
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};
const firstNumber = (s: string) => s.match(/\d+/)?.[0] ?? null;

export function isAudioRef(v: unknown): v is string {
    return typeof v === "string" && AUDIO_EXT.includes(path.extname(v.split("?")[0]!).toLowerCase());
}

/**
 * Acepta la carpeta raíz del juego (gNNN), su carpeta dist/ o cualquier build suelto
 * (index.html + assets/).
 */
export function detectGame(inputDir: string): GameInfo {
    const dir = path.resolve(inputDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`La carpeta no existe: ${dir}`);
    }
    const has = (p: string, base = dir) => fs.existsSync(path.join(base, p));

    let rootDir = dir;
    let publicDir = has("public/assets") ? path.join(dir, "public") : null;
    let distDir = has("dist/index.html") && has("dist/assets") ? path.join(dir, "dist") : null;

    // Eligieron directamente un build (p. ej. g503/dist)
    if (!publicDir && !distDir && has("index.html") && has("assets")) {
        distDir = dir;
        const parent = path.dirname(dir);
        if (path.basename(dir) === "dist" && has("public/assets", parent)) {
            rootDir = parent;
            publicDir = path.join(parent, "public");
        }
    }
    if (!publicDir && !distDir) {
        throw new Error("No parece un juego: no encuentro public/assets ni un build (index.html + assets) en " + dir);
    }

    const commonDir = has("common", rootDir) ? path.join(rootDir, "common") : null;
    const viteBin = has("node_modules/vite/bin/vite.js", rootDir) ? path.join(rootDir, "node_modules/vite/bin/vite.js") : null;
    const viteConfig = ["vite.config.ts", "vite.config.js", "vite.config.mjs"].some((f) => has(f, rootDir));

    return {
        dir: rootDir,
        name: path.basename(rootDir),
        number: firstNumber(path.basename(rootDir)),
        publicDir,
        distDir,
        commonDir,
        viteBin: viteConfig ? viteBin : null,
        gameRoots: [publicDir, distDir].filter((d): d is string => !!d),
    };
}

/** Carpeta principal de los assets del juego (public/ si existe, si no el build). */
export function primaryRoot(game: GameInfo): string {
    const root = game.publicDir ?? game.distDir;
    if (!root) throw new Error("El juego no tiene carpeta de assets");
    return root;
}

function* walkJsonFiles(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walkJsonFiles(p);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) yield p;
    }
}

function walkValues(node: unknown, cb: (value: string, keyPath: JsonPath) => void, keyPath: JsonPath = []): void {
    if (typeof node === "string") {
        if (isAudioRef(node)) cb(node, keyPath);
    } else if (Array.isArray(node)) {
        node.forEach((v, i) => walkValues(v, cb, [...keyPath, i]));
    } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walkValues(v, cb, [...keyPath, k]);
    }
}

/** Nombre legible del sonido a partir de la ruta de claves: ["windup1","file"] -> "windup1" */
export function aliasFor(keyPath: JsonPath): string {
    const parts = [...keyPath];
    const last = () => parts.at(-1);
    while (parts.length > 1 && typeof last() === "string" && GENERIC_KEYS.test(last() as string)) parts.pop();
    let i = parts.length - 1;
    while (i > 0 && typeof parts[i] === "number") i--;
    const head = String(parts[i] ?? "");
    const idx = parts
        .slice(i + 1)
        .map((n) => `[${n}]`)
        .join("");
    return head + idx || "(sin nombre)";
}

interface ScanRootOptions {
    scope: Scope;
    root: string;
    jsonDir: string;
    includeMissing: boolean;
    urlPrefix: string;
    sounds: Map<string, Sound>;
    warnings: string[];
}

function scanRoot({ scope, root, jsonDir, includeMissing, urlPrefix, sounds, warnings }: ScanRootOptions): void {
    if (!fs.existsSync(jsonDir)) return;
    for (const jsonPath of walkJsonFiles(jsonDir)) {
        if (fs.statSync(jsonPath).size > MAX_JSON_BYTES) continue;
        const text = fs.readFileSync(jsonPath, "utf8");
        if (!AUDIO_EXT.some((ext) => text.toLowerCase().includes(ext))) continue;
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch (err) {
            warnings.push(`No se pudo leer ${posix(path.relative(root, jsonPath))}: ${(err as Error).message}`);
            continue;
        }
        walkValues(data, (value, keyPath) => {
            const clean = value.split("?")[0]!;
            const candidates = [path.join(root, clean), path.join(path.dirname(jsonPath), clean)];
            let file = candidates.find((c) => isInside(root, c) && fs.existsSync(c));
            const missing = !file;
            if (!file) {
                if (!includeMissing) return;
                file = candidates.find((c) => isInside(root, c));
                if (!file) return;
            }
            const rel = posix(path.relative(root, file));
            const id = `${scope}:${rel}`;
            let s = sounds.get(id);
            if (!s) {
                const st = missing ? null : fs.statSync(file);
                s = {
                    id,
                    scope,
                    rel,
                    url: urlPrefix + rel,
                    ext: path.extname(rel).toLowerCase(),
                    size: st ? st.size : 0,
                    mtime: st ? st.mtimeMs : 0,
                    missing,
                    audio: !missing && rel.toLowerCase().endsWith(".mp3") ? mp3Info(file) : null,
                    refs: [],
                };
                sounds.set(id, s);
            }
            s.refs.push({
                json: posix(path.relative(root, jsonPath)),
                path: keyPath,
                key: keyPath.join("."),
                alias: aliasFor(keyPath),
                value,
            });
        });
    }
}

/** Entrada de un audio que ningún JSON nombra */
export function looseSound(scope: Scope, rel: string, url: string, file: string): Sound {
    const st = fs.statSync(file);
    return {
        id: `${scope}:${rel}`,
        scope,
        rel,
        url,
        ext: path.extname(rel).toLowerCase(),
        size: st.size,
        mtime: st.mtimeMs,
        missing: false,
        unreferenced: true,
        audio: rel.toLowerCase().endsWith(".mp3") ? mp3Info(file) : null,
        refs: [],
    };
}

/**
 * Audios que existen en assets/ pero ningún JSON nombra (p. ej. los rollup, que el engine
 * construye con una plantilla). Se listan para poder oírlos, reemplazarlos y reconocerlos en vivo.
 */
function addUnreferenced(root: string, dir: string, sounds: Map<string, Sound>): void {
    if (!fs.existsSync(dir)) return;
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && AUDIO_EXT.includes(path.extname(e.name).toLowerCase())) {
                const rel = posix(path.relative(root, p));
                if (!sounds.has(`game:${rel}`)) sounds.set(`game:${rel}`, looseSound("game", rel, "/" + rel, p));
            }
        }
    };
    walk(dir);
}

const labelOf = (s: Sound) => s.refs[0]?.alias ?? s.rel.split("/").pop() ?? s.rel;

const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

export function scanSounds(game: GameInfo): { sounds: Sound[]; warnings: string[] } {
    const sounds = new Map<string, Sound>();
    const warnings: string[] = [];
    const primary = primaryRoot(game);
    scanRoot({ scope: "game", root: primary, jsonDir: path.join(primary, "assets"), includeMissing: true, urlPrefix: "/", sounds, warnings });
    addUnreferenced(primary, path.join(primary, "assets"), sounds);
    if (game.commonDir) {
        scanRoot({
            scope: "common",
            root: game.commonDir,
            jsonDir: game.commonDir,
            includeMissing: false, // common/ tiene referencias heredadas que no existen
            urlPrefix: "/common/",
            sounds,
            warnings,
        });
    }
    const list = [...sounds.values()].sort(
        (a, b) =>
            (a.scope === b.scope ? 0 : a.scope === "game" ? -1 : 1) ||
            (!!a.unreferenced === !!b.unreferenced ? 0 : a.unreferenced ? 1 : -1) ||
            collator.compare(labelOf(a), labelOf(b))
    );
    return { sounds: list, warnings };
}

/** Lista los juegos de una carpeta (p. ej. DPI/pixi -> g490, g491, ...) */
export function listGames(gamesDir: string | null): LocalGame[] {
    if (!gamesDir || !fs.existsSync(gamesDir)) return [];
    const out: LocalGame[] = [];
    for (const e of fs.readdirSync(gamesDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const dir = path.join(gamesDir, e.name);
        const hasPublic = fs.existsSync(path.join(dir, "public/assets"));
        const hasDist = fs.existsSync(path.join(dir, "dist/index.html"));
        if (!hasPublic && !hasDist) continue;
        out.push({
            name: e.name,
            dir,
            number: firstNumber(e.name),
            hasDist,
            hasVite: fs.existsSync(path.join(dir, "node_modules/vite/bin/vite.js")),
        });
    }
    return out.sort((a, b) => collator.compare(a.name, b.name));
}
