// "Momentos": puntos de los JSON de configuración del juego que deciden QUÉ sonido suena
// (p. ej. config.json › sounds › freeloop = "snd_1"). Se detectan de forma genérica:
// un string igual a un alias de sonido, dentro de una ruta que habla de sonido.
import fs from "node:fs";
import path from "node:path";
import { pathKey } from "./jsontext.ts";
import type { JsonPath, Moment, MomentField } from "../shared/types.ts";

const SOUNDISH = /(sound|snd|music|audio|freeloop)/i;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const posix = (p: string) => p.split(path.sep).join("/");

function* jsonFiles(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* jsonFiles(p);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) yield p;
    }
}

/** "reels › sound_symbol_stop › symbols[12] › src[0]" */
export function prettyPath(p: JsonPath): string {
    let out = "";
    for (const k of p) out += typeof k === "number" ? `[${k}]` : (out ? " › " : "") + k;
    return out;
}

/**
 * @param root      carpeta raíz de los assets del juego (public/ o dist/)
 * @param aliases   nombres de alias de sonido del juego
 */
export function findMoments(root: string, aliases: Set<string>): Moment[] {
    const moments: Moment[] = [];
    for (const file of jsonFiles(path.join(root, "assets"))) {
        // Las reglas de SoundTool no son configuración del juego
        if (path.basename(file) === "soundcues.json" || fs.statSync(file).size > MAX_JSON_BYTES) continue;
        let data: unknown;
        try {
            data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
        } catch {
            continue;
        }
        const json = posix(path.relative(root, file));
        const walk = (node: unknown, p: JsonPath, parent: unknown): void => {
            if (typeof node === "string") {
                if (aliases.has(node) && p.some((k) => typeof k === "string" && SOUNDISH.test(k))) {
                    // Datos numéricos/booleanos del mismo objeto (id, order, timesbet, volume…)
                    const fields: MomentField[] = [];
                    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
                        const base = p.slice(0, -1);
                        for (const [k, v] of Object.entries(parent)) {
                            if (typeof v === "number" || typeof v === "boolean") fields.push({ key: k, path: [...base, k], value: v });
                        }
                    }
                    moments.push({ id: `${json}#${pathKey(p)}`, json, path: p, label: prettyPath(p), value: node, fields });
                }
                return;
            }
            if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...p, i], node));
            else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, [...p, k], node);
        };
        walk(data, [], null);
    }
    return moments.sort((a, b) => a.json.localeCompare(b.json));
}
