// Sesión de edición de un juego: cambios pendientes, guardado con copia de seguridad y restauración.
//
// Tres tipos de cambio pendiente:
//   replace  un sonido existente recibe otro archivo
//   new      un sonido nuevo: archivo + alias añadido al manifiesto (gameassets.json)
//   moment   un valor de un JSON de configuración (qué alias suena en un momento, timesbet…)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { detectGame, scanSounds, isAudioRef, looseSound, primaryRoot } from "./scan.ts";
import { findMoments, prettyPath } from "./moments.ts";
import { applyEdits, locate, pathKey, type JsonEdit } from "./jsontext.ts";
import { createZip, type ZipEntry } from "./zip.ts";
import { CUES_JSON, normalizeCues, readCues, sameCues, serializeCues } from "./cues.ts";
import type {
    BackupManifest,
    Change,
    GameInfo,
    JsonPath,
    JsonPrimitive,
    ManifestTarget,
    Moment,
    MomentView,
    PendingSummaryItem,
    RemoteInfo,
    Scope,
    Sound,
    SoundCue,
} from "../shared/types.ts";

export const DATA_DIR = path.join(os.homedir(), ".soundtool");
export const ALIAS_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Archivo subido, guardado en una carpeta temporal hasta que se guarda o exporta */
interface StagedFile {
    file: string;
    name: string;
    ext: string;
    size: number;
}
interface StagedNewSound extends StagedFile {
    rel: string;
    url: string;
}
interface JsonValueEdit {
    path: JsonPath;
    value: JsonPrimitive;
    original: JsonPrimitive;
}

interface ExportMeta {
    game: string;
    version?: string;
    source: string;
    exportedAt: string;
    changes: Change[];
}

/** Detecta el formato real por sus primeros bytes (no confiamos en la extensión del nombre). */
export function sniffAudio(buf: Buffer): string | null {
    if (!buf || buf.length < 4) return null;
    const str = (a: number, b: number) => buf.toString("latin1", a, b);
    const b0 = buf[0]!;
    const b1 = buf[1]!;
    if (str(0, 3) === "ID3") return ".mp3";
    if (b0 === 0xff && (b1 & 0xe0) === 0xe0 && ((b1 >> 1) & 3) !== 0) return ".mp3";
    if (str(0, 4) === "RIFF" && str(8, 12) === "WAVE") return ".wav";
    if (str(0, 4) === "OggS") return ".ogg";
    if (str(4, 8) === "ftyp") return ".m4a";
    if (b0 === 0x1a && b1 === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return ".webm";
    if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return ".aac";
    return null;
}

function changesMarkdown(meta: ExportMeta, entries: ZipEntry[]): string {
    const line = (c: Change) => {
        if (c.type === "new") return `- **Sonido nuevo** \`${c.alias}\` → \`${c.to}\` (añadido a \`${c.manifest}\`). Archivo original: ${c.source}`;
        if (c.type === "moment") return `- **Momento** \`${c.json}\` › ${c.label}: \`${c.from}\` → \`${c.to}\``;
        if (c.type === "cues")
            return `- **Reglas de sonido** \`${c.json}\`: ${c.count} regla(s) (antes ${c.previous}). Para que suenen en el juego, el engine tiene que leer este archivo.`;
        const where = c.scope === "common" ? "common/" : "";
        const formatNote = c.from !== c.to ? ` — cambia de formato: antes \`${c.from}\`` : "";
        return `- **Reemplazo** \`${c.aliases[0] ?? c.from}\` (${where}${c.to})${formatNote}. Archivo original: ${c.source}`;
    };
    const files = entries.filter((e) => e.name.startsWith("public/") || e.name.startsWith("common/")).map((e) => `- \`${e.name}\``);
    return [
        `# Cambios de sonido — ${meta.game}${meta.version ? " v" + meta.version : ""}`,
        "",
        `Exportado con SoundTool el ${new Date(meta.exportedAt).toLocaleString("es")}.`,
        `Origen: ${meta.source}`,
        "",
        "## Cambios",
        "",
        ...meta.changes.map(line),
        "",
        "## Cómo aplicarlos",
        "",
        "1. Copia el contenido de `public/` sobre la carpeta `public/` del juego (respeta las rutas).",
        "2. Si hay carpeta `common/`, esos sonidos son compartidos: cópialos sobre `common/` sabiendo que afectan a otros juegos.",
        "3. Los JSON van completos, ya modificados: sustituyen al archivo del juego. Si el juego cambió desde entonces, aplica solo las líneas indicadas arriba.",
        "",
        "## Archivos incluidos",
        "",
        ...files,
        "",
    ].join("\n");
}

const posix = (p: string) => p.split(path.sep).join("/");
const withExt = (p: string, ext: string) => p.slice(0, p.length - path.extname(p).length) + ext;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const readText = (f: string) => fs.readFileSync(f, "utf8");

export interface SessionOptions {
    dataDir?: string;
    /** Si viene del portal */
    remote?: RemoteInfo | null;
}

interface ApplyOptions {
    /** Carpetas donde escribir ("game" -> public/ y dist/, "common" -> common/) */
    targets: (scope: Scope) => string[];
    /** Si se da, de dónde copiar un JSON que el destino aún no tiene (exportar) */
    sourceFor?: ((scope: Scope) => string) | null;
    /** Se llama antes de pisar o crear cada archivo (copia de seguridad) */
    onWrite?: (abs: string) => void;
}

export class SoundSession {
    readonly game: GameInfo;
    readonly remote: RemoteInfo | null;
    /** Carpeta principal de los assets (public/ o el build) */
    readonly primary: string;
    readonly backupDir: string;
    readonly tmpDir: string;

    sounds = new Map<string, Sound>();
    warnings: string[] = [];
    /** URL que pide el juego -> id del sonido */
    urlIndex = new Map<string, string>();
    /** alias -> id del sonido */
    aliases = new Map<string, string>();
    manifest: ManifestTarget | null = null;
    moments: Moment[] = [];

    readonly pending = new Map<string, StagedFile>();
    readonly pendingNew = new Map<string, StagedNewSound>();
    /** jsonRel -> (pathKey -> edición) */
    readonly pendingJson = new Map<string, Map<string, JsonValueEdit>>();
    /** URLs de audio que sonaron en vivo pero ningún JSON nombra (p. ej. rollups de common/) */
    readonly discovered = new Set<string>();
    /** Reglas de sonido guardadas en el juego (assets/json/soundcues.json) */
    savedCues: SoundCue[] = [];
    /** Reglas editadas sin guardar (null = sin cambios) */
    pendingCues: SoundCue[] | null = null;

    constructor(dir: string, { dataDir = DATA_DIR, remote = null }: SessionOptions = {}) {
        this.game = detectGame(dir);
        this.remote = remote;
        this.primary = primaryRoot(this.game);
        const hash = crypto.createHash("sha1").update(this.game.dir).digest("hex").slice(0, 8);
        this.backupDir = path.join(dataDir, "backups", `${this.game.name}-${hash}`);
        this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundtool-"));
        this.rescan();
    }

    /** Registra un audio que el juego reprodujo y no estaba en la lista. Devuelve true si se añadió. */
    discover(urlPath: string): boolean {
        if (this.urlIndex.has(urlPath) || !isAudioRef(urlPath)) return false;
        const commonDir = urlPath.startsWith("/common/") ? this.game.commonDir : null;
        const root = commonDir ?? this.primary;
        const rel = commonDir ? urlPath.slice("/common/".length) : urlPath.replace(/^\/+/, "");
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return false;
        this.discovered.add(urlPath);
        const s = looseSound(commonDir ? "common" : "game", posix(path.relative(root, file)), urlPath, file);
        this.sounds.set(s.id, s);
        this.urlIndex.set(urlPath, s.id);
        return true;
    }

    rescan(): void {
        const { sounds, warnings } = scanSounds(this.game);
        this.sounds = new Map(sounds.map((s) => [s.id, s]));
        this.warnings = warnings;
        this.urlIndex = new Map(sounds.map((s) => [s.url, s.id]));
        const discovered = [...this.discovered];
        this.discovered.clear();
        for (const url of discovered) this.discover(url);

        // Alias de sonido del juego y el objeto del manifiesto donde viven
        this.aliases = new Map();
        const groups = new Map<string, { json: string; path: JsonPath; count: number; dirs: Map<string, number> }>();
        for (const s of sounds) {
            if (s.scope !== "game") continue;
            for (const r of s.refs) {
                if (r.alias.includes("[")) continue;
                if (!this.aliases.has(r.alias)) this.aliases.set(r.alias, s.id);
                if (typeof r.path.at(-1) === "string") {
                    const parentPath = r.path.slice(0, -1);
                    const k = `${r.json}#${pathKey(parentPath)}`;
                    const g = groups.get(k) ?? { json: r.json, path: parentPath, count: 0, dirs: new Map<string, number>() };
                    g.count++;
                    const dir = path.posix.dirname(s.rel);
                    g.dirs.set(dir, (g.dirs.get(dir) ?? 0) + 1);
                    groups.set(k, g);
                }
            }
        }
        const best = [...groups.values()].sort((a, b) => b.count - a.count)[0];
        const soundDir = best && [...best.dirs].sort((a, b) => b[1] - a[1])[0]?.[0];
        this.manifest = best && soundDir ? { json: best.json, path: best.path, soundDir } : null;
        this.moments = findMoments(this.primary, new Set(this.aliases.keys()));
        this.savedCues = readCues(this.primary);
    }

    /** Reglas actuales (con los cambios pendientes) */
    get cues(): SoundCue[] {
        return this.pendingCues ?? this.savedCues;
    }

    #soundExists = (alias: string) => this.aliases.has(alias) || this.pendingNew.has(alias);

    setCues(input: unknown): void {
        const cues = normalizeCues(input, this.#soundExists);
        this.pendingCues = sameCues(cues, this.savedCues) ? null : cues;
    }

    /** Carpetas donde vive un archivo de ese scope */
    #roots(scope: Scope): string[] {
        if (scope === "common") return this.game.commonDir ? [this.game.commonDir] : [];
        return this.game.gameRoots;
    }

    get pendingCount(): number {
        let n = this.pending.size + this.pendingNew.size + (this.pendingCues ? 1 : 0);
        for (const m of this.pendingJson.values()) n += m.size;
        return n;
    }

    /** Archivo físico original (para escucharlo) */
    originalFile(id: string): string | null {
        const s = this.sounds.get(id);
        if (!s) return null;
        for (const root of this.#roots(s.scope)) {
            const f = path.join(root, s.rel);
            if (fs.existsSync(f)) return f;
        }
        return null;
    }

    /** Archivo que hay que servir para un alias (con cambios pendientes aplicados) */
    fileForAlias(alias: string): string | null {
        const n = this.pendingNew.get(alias);
        if (n) return n.file;
        const id = this.aliases.get(alias);
        if (!id) return null;
        return this.pending.get(id)?.file ?? this.originalFile(id);
    }

    /** Si la URL pedida por el juego es un sonido con cambio pendiente, devuelve ese archivo */
    overrideForUrl(urlPath: string): StagedFile | undefined {
        const id = this.urlIndex.get(urlPath);
        if (id && this.pending.has(id)) return this.pending.get(id);
        for (const n of this.pendingNew.values()) if (n.url === urlPath) return n;
        return undefined;
    }

    // ------------------------------------------------------------ reemplazos

    stage(id: string, buffer: Buffer, originalName = ""): StagedFile {
        const s = this.sounds.get(id);
        if (!s) throw new Error("Sonido desconocido: " + id);
        const ext = sniffAudio(buffer);
        if (!ext) throw new Error("El archivo no parece audio válido (mp3, wav, ogg o m4a).");
        if (s.unreferenced && ext !== s.ext) {
            throw new Error(
                `Este sonido no aparece en ningún JSON (el código lo busca por su nombre), así que tiene que seguir siendo ${s.ext.slice(1).toUpperCase()}.`
            );
        }
        const entry = this.#storeTmp(buffer, ext, originalName);
        const prev = this.pending.get(id);
        if (prev) fs.rmSync(prev.file, { force: true });
        this.pending.set(id, entry);
        return entry;
    }

    unstage(id: string): void {
        const prev = this.pending.get(id);
        if (prev) fs.rmSync(prev.file, { force: true });
        this.pending.delete(id);
    }

    #storeTmp(buffer: Buffer, ext: string, originalName: string): StagedFile {
        const file = path.join(this.tmpDir, crypto.randomUUID() + ext);
        fs.writeFileSync(file, buffer);
        return { file, name: path.basename(originalName) || "audio" + ext, ext, size: buffer.length };
    }

    // ------------------------------------------------------------ sonidos nuevos

    stageNew(alias: string, buffer: Buffer, originalName = ""): StagedNewSound {
        if (!this.manifest) throw new Error("No encuentro dónde declara este juego sus sonidos.");
        if (!ALIAS_RE.test(alias)) throw new Error("El nombre solo puede tener letras, números, _ - y . (sin espacios).");
        if (this.aliases.has(alias) || this.pendingNew.has(alias)) throw new Error(`Ya existe un sonido llamado "${alias}".`);
        const ext = sniffAudio(buffer);
        if (!ext) throw new Error("El archivo no parece audio válido (mp3, wav, ogg o m4a).");
        const rel = `${this.manifest.soundDir}/${alias}${ext}`;
        if (this.game.gameRoots.some((r) => fs.existsSync(path.join(r, rel)))) {
            throw new Error(`Ya hay un archivo ${rel}. Elige otro nombre.`);
        }
        const entry = { ...this.#storeTmp(buffer, ext, originalName), rel, url: "/" + rel };
        this.pendingNew.set(alias, entry);
        return entry;
    }

    unstageNew(alias: string): void {
        const prev = this.pendingNew.get(alias);
        if (prev) fs.rmSync(prev.file, { force: true });
        this.pendingNew.delete(alias);
        // Los momentos que apuntaban a ese sonido vuelven a su valor, y sus reglas desaparecen
        for (const [json, edits] of this.pendingJson) {
            for (const [k, e] of edits) if (e.value === alias) edits.delete(k);
            if (!edits.size) this.pendingJson.delete(json);
        }
        if (this.pendingCues) {
            const kept = this.pendingCues.filter((c) => c.sound !== alias);
            this.pendingCues = sameCues(kept, this.savedCues) ? null : kept;
        }
    }

    // ------------------------------------------------------------ momentos (valores de JSON)

    #readValue(jsonRel: string, p: JsonPath): JsonPrimitive {
        const text = readText(path.join(this.primary, jsonRel));
        const node = locate(text).get(pathKey(p));
        if (!node || node.kind !== "primitive") throw new Error("Ese valor ya no existe en " + jsonRel);
        return JSON.parse(text.slice(node.start, node.end)) as JsonPrimitive;
    }

    setValue(jsonRel: string, p: JsonPath, input: unknown): void {
        if (!Array.isArray(p) || jsonRel.includes("..")) throw new Error("Ruta inválida");
        const original = this.#readValue(jsonRel, p);
        let value: JsonPrimitive;
        if (typeof original === "string") {
            if (typeof input !== "string" || !(this.aliases.has(input) || this.pendingNew.has(input))) {
                throw new Error(`"${String(input)}" no es un sonido de este juego.`);
            }
            value = input;
        } else if (typeof original === "number") {
            value = Number(input);
            if (!Number.isFinite(value)) throw new Error("Tiene que ser un número.");
        } else if (typeof original === "boolean") {
            value = input === true || input === "true";
        } else {
            throw new Error("Solo se pueden cambiar textos, números o sí/no.");
        }
        const edits = this.pendingJson.get(jsonRel) ?? new Map<string, JsonValueEdit>();
        if (value === original) edits.delete(pathKey(p));
        else edits.set(pathKey(p), { path: p, value, original });
        if (edits.size) this.pendingJson.set(jsonRel, edits);
        else this.pendingJson.delete(jsonRel);
    }

    resetValue(jsonRel: string, p: JsonPath): void {
        const edits = this.pendingJson.get(jsonRel);
        if (!edits) return;
        edits.delete(pathKey(p));
        if (!edits.size) this.pendingJson.delete(jsonRel);
    }

    #editsFor(jsonRel: string): JsonEdit[] {
        const edits: JsonEdit[] = [...(this.pendingJson.get(jsonRel)?.values() ?? [])].map((e) => ({ op: "set", path: e.path, value: e.value }));
        if (this.manifest && jsonRel === this.manifest.json) {
            for (const [alias, n] of this.pendingNew) edits.push({ op: "add", path: this.manifest.path, key: alias, value: n.rel });
        }
        return edits;
    }

    /** JSON con los cambios pendientes aplicados, para servirlo al juego antes de guardar. */
    patchedJsonForUrl(urlPath: string, root?: string | null): string | null {
        if (!urlPath.toLowerCase().endsWith(".json")) return null;
        const jsonRel = urlPath.replace(/^\/+/, "");
        if (jsonRel === CUES_JSON && this.pendingCues) return serializeCues(this.pendingCues);
        const edits = this.#editsFor(jsonRel);
        if (!edits.length) return null;
        const file = path.join(root ?? this.primary, jsonRel);
        if (!fs.existsSync(file)) return null;
        try {
            return applyEdits(readText(file), edits).text;
        } catch {
            return null;
        }
    }

    /** Momentos con su valor pendiente (si lo hay) */
    momentsView(): MomentView[] {
        return this.moments.map((m) => {
            const edits = this.pendingJson.get(m.json);
            return {
                ...m,
                pendingValue: edits?.get(pathKey(m.path))?.value,
                fields: m.fields.map((f) => ({ ...f, pendingValue: edits?.get(pathKey(f.path))?.value })),
            };
        });
    }

    /** Lista legible de todo lo pendiente (para confirmar antes de guardar) */
    pendingSummary(): PendingSummaryItem[] {
        const out: PendingSummaryItem[] = [];
        for (const [id, p] of this.pending) {
            const s = this.sounds.get(id);
            out.push({ kind: "replace", text: `${s?.refs[0]?.alias ?? s?.rel ?? id} ← ${p.name}` });
        }
        for (const [alias, n] of this.pendingNew) out.push({ kind: "new", text: `Nuevo sonido "${alias}" (${n.rel})` });
        for (const [json, edits] of this.pendingJson) {
            for (const e of edits.values()) out.push({ kind: "moment", text: `${json} › ${prettyPath(e.path)}: ${e.original} → ${e.value}` });
        }
        if (this.pendingCues) {
            out.push({ kind: "cues", text: `Reglas de sonido: ${this.pendingCues.length} (antes ${this.savedCues.length}) en ${CUES_JSON}` });
        }
        return out;
    }

    discardAll(): void {
        for (const id of [...this.pending.keys()]) this.unstage(id);
        for (const a of [...this.pendingNew.keys()]) this.unstageNew(a);
        this.pendingJson.clear();
        this.pendingCues = null;
    }

    // ------------------------------------------------------------ guardar / exportar / restaurar

    /** Aplica los cambios pendientes sobre unas carpetas destino. Lo usan save() y exportZip(). */
    #applyChanges({ targets, sourceFor = null, onWrite = () => {} }: ApplyOptions): Change[] {
        const changes: Change[] = [];
        const writeFile = (root: string, rel: string, srcFile: string) => {
            const abs = path.join(root, rel);
            onWrite(abs);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.copyFileSync(srcFile, abs);
            return abs;
        };
        const jsonIn = (root: string, rel: string, scope: Scope): string | null => {
            const abs = path.join(root, rel);
            if (fs.existsSync(abs)) return abs;
            const src = sourceFor ? path.join(sourceFor(scope), rel) : null;
            if (!src || !fs.existsSync(src)) return null;
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.copyFileSync(src, abs);
            return abs;
        };
        const writeText = (abs: string, text: string) => {
            onWrite(abs);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, text);
        };
        const relOut = (abs: string) => posix(path.relative(this.game.dir, abs));

        // 1. Reemplazos
        for (const [soundId, p] of this.pending) {
            const s = this.sounds.get(soundId);
            if (!s) continue;
            const extChanged = p.ext !== s.ext;
            const newRel = extChanged ? withExt(s.rel, p.ext) : s.rel;
            const written = targets(s.scope).map((root) => relOut(writeFile(root, newRel, p.file)));
            const jsonEdits: string[] = [];
            if (extChanged) {
                // Actualiza la referencia en cada JSON (y su copia en dist/) sin reformatear el archivo
                const byJson = new Map<string, string[]>();
                for (const ref of s.refs) byJson.set(ref.json, [...(byJson.get(ref.json) ?? []), ref.value]);
                for (const [jsonRel, values] of byJson) {
                    for (const root of targets(s.scope)) {
                        const jsonAbs = jsonIn(root, jsonRel, s.scope);
                        if (!jsonAbs) continue;
                        let text = readText(jsonAbs);
                        let count = 0;
                        for (const v of new Set(values)) {
                            const from = JSON.stringify(v);
                            const to = JSON.stringify(withExt(v.split("?")[0]!, p.ext));
                            count += text.split(from).length - 1;
                            text = text.split(from).join(to);
                        }
                        if (count > 0) {
                            writeText(jsonAbs, text);
                            jsonEdits.push(relOut(jsonAbs));
                        }
                    }
                }
            }
            changes.push({
                type: "replace",
                sound: soundId,
                scope: s.scope,
                aliases: [...new Set(s.refs.map((r) => r.alias))],
                from: s.rel,
                to: newRel,
                source: p.name,
                written,
                jsonEdits,
            });
        }

        // 2. Archivos de sonidos nuevos
        for (const [alias, n] of this.pendingNew) {
            const written = targets("game").map((root) => relOut(writeFile(root, n.rel, n.file)));
            changes.push({ type: "new", alias, to: n.rel, source: n.name, manifest: this.manifest?.json, written });
        }

        // 3. JSON: momentos editados + alias nuevos en el manifiesto
        const jsons = new Set(this.pendingJson.keys());
        if (this.pendingNew.size && this.manifest) jsons.add(this.manifest.json);
        for (const jsonRel of jsons) {
            const edits = this.#editsFor(jsonRel);
            for (const root of targets("game")) {
                const jsonAbs = jsonIn(root, jsonRel, "game");
                if (!jsonAbs) continue;
                const before = readText(jsonAbs);
                const { text } = applyEdits(before, edits);
                if (text !== before) writeText(jsonAbs, text);
            }
            for (const e of this.pendingJson.get(jsonRel)?.values() ?? []) {
                changes.push({ type: "moment", json: jsonRel, path: e.path, label: prettyPath(e.path), from: e.original, to: e.value });
            }
        }

        // 4. Reglas de sonido
        if (this.pendingCues) {
            const text = serializeCues(this.pendingCues);
            for (const root of targets("game")) writeText(path.join(root, CUES_JSON), text);
            changes.push({ type: "cues", json: CUES_JSON, count: this.pendingCues.length, previous: this.savedCues.length });
        }
        return changes;
    }

    /** Escribe los cambios pendientes en el juego. Todo lo que se pisa se copia antes al backup. */
    save(): BackupManifest | null {
        if (this.remote) throw new Error("Este juego viene del portal: no se puede guardar en el servidor. Usa «Exportar .zip».");
        if (this.pendingCount === 0) return null;
        const id = stamp();
        const dir = path.join(this.backupDir, id);
        const manifest: BackupManifest = { id, game: this.game.dir, createdAt: new Date().toISOString(), changes: [], modified: [], created: [] };
        const backedUp = new Set<string>();
        const backup = (abs: string) => {
            const rel = posix(path.relative(this.game.dir, abs));
            if (backedUp.has(rel)) return;
            backedUp.add(rel);
            if (fs.existsSync(abs)) {
                const dest = path.join(dir, "files", rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(abs, dest);
                manifest.modified.push(rel);
            } else {
                manifest.created.push(rel);
            }
        };
        manifest.changes = this.#applyChanges({ targets: (scope) => this.#roots(scope), onWrite: backup });

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify(manifest, null, 2));
        this.#clearPending();
        this.rescan();
        return manifest;
    }

    /**
     * Paquete .zip con los cambios pendientes ya aplicados, para entregar a desarrollo:
     *   public/...   archivos del juego (sonidos y JSON completos ya modificados)
     *   common/...   sonidos compartidos reemplazados (si los hay)
     *   CAMBIOS.md + soundtool-changes.json
     * No modifica el juego ni descarta los cambios pendientes.
     */
    exportZip(): { name: string; zip: Buffer; changes: Change[] } {
        if (this.pendingCount === 0) throw new Error("No hay cambios para exportar.");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soundtool-export-"));
        try {
            const roots: Record<Scope, string> = { game: path.join(tmp, "public"), common: path.join(tmp, "common") };
            const changes = this.#applyChanges({
                targets: (scope) => [roots[scope]],
                sourceFor: (scope) => (scope === "common" ? (this.game.commonDir ?? this.primary) : this.primary),
            });
            const entries: ZipEntry[] = [];
            const walk = (d: string) => {
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) walk(p);
                    else entries.push({ name: posix(path.relative(tmp, p)), data: fs.readFileSync(p) });
                }
            };
            walk(tmp);
            const meta: ExportMeta = {
                game: this.remote ? this.remote.gameId : this.game.name,
                version: this.remote?.version,
                source: this.remote ? this.remote.loaderUrl.replace(/playerId=[^&]*/i, "playerId=…") : this.game.dir,
                exportedAt: new Date().toISOString(),
                changes,
            };
            entries.push({ name: "soundtool-changes.json", data: JSON.stringify(meta, null, 2) });
            entries.push({ name: "CAMBIOS.md", data: changesMarkdown(meta, entries) });
            const name = `${meta.game}${meta.version ? "-v" + meta.version : ""}-sonidos-${stamp().slice(0, 16)}.zip`;
            return { name, zip: createZip(entries), changes };
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    #clearPending(): void {
        for (const p of this.pending.values()) fs.rmSync(p.file, { force: true });
        for (const n of this.pendingNew.values()) fs.rmSync(n.file, { force: true });
        this.pending.clear();
        this.pendingNew.clear();
        this.pendingJson.clear();
        this.pendingCues = null;
    }

    listBackups(): BackupManifest[] {
        if (!fs.existsSync(this.backupDir)) return [];
        return fs
            .readdirSync(this.backupDir)
            .map((name): BackupManifest | null => {
                try {
                    return JSON.parse(readText(path.join(this.backupDir, name, "backup.json"))) as BackupManifest;
                } catch {
                    return null;
                }
            })
            .filter((b): b is BackupManifest => b !== null)
            .sort((a, b) => b.id.localeCompare(a.id));
    }

    /** Deja los archivos como estaban antes de ese guardado */
    restore(backupId: string): BackupManifest {
        const dir = path.join(this.backupDir, path.basename(backupId));
        const manifest = JSON.parse(readText(path.join(dir, "backup.json"))) as BackupManifest;
        for (const rel of manifest.modified) {
            const target = path.join(this.game.dir, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(dir, "files", rel), target);
        }
        for (const rel of manifest.created) fs.rmSync(path.join(this.game.dir, rel), { force: true });
        this.rescan();
        return manifest;
    }

    dispose(): void {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
    }
}
