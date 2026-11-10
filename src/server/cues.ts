// Reglas de sonido (cues): "cuando el engine lanza el evento X, espera N ms y suena Y".
// Se guardan en assets/json/soundcues.json. Hoy las reproduce SoundTool dentro del juego;
// para que suenen en el juego real, el engine tiene que leer este archivo (paso B).
import fs from "node:fs";
import path from "node:path";
import type { CueTrigger, CuesFile, SoundCue } from "../shared/types.ts";

export const CUES_JSON = "assets/json/soundcues.json";

const EVENT_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_CUES = 500;
const MAX_DELAY_MS = 60_000;

export function readCues(root: string): SoundCue[] {
    const file = path.join(root, CUES_JSON);
    if (!fs.existsSync(file)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Partial<CuesFile>;
        return Array.isArray(data.cues) ? data.cues : [];
    } catch {
        return [];
    }
}

export function serializeCues(cues: SoundCue[]): string {
    const file: CuesFile = { version: 1, cues };
    return JSON.stringify(file, null, 2) + "\n";
}

function trigger(input: unknown, what: string): CueTrigger {
    const t = (input ?? {}) as Partial<CueTrigger>;
    const on = String(t.on ?? "").trim();
    if (!EVENT_RE.test(on)) throw new Error(`${what}: elige un evento del juego.`);
    const match = typeof t.match === "string" && t.match.trim() ? t.match.trim().slice(0, 200) : undefined;
    return match ? { on, match } : { on };
}

/**
 * Valida y normaliza las reglas que llegan de la interfaz.
 * @param soundExists  si un alias existe en el juego (incluidos los sonidos nuevos pendientes)
 */
export function normalizeCues(input: unknown, soundExists: (alias: string) => boolean): SoundCue[] {
    if (!Array.isArray(input)) throw new Error("Las reglas tienen que ser una lista.");
    if (input.length > MAX_CUES) throw new Error(`Máximo ${MAX_CUES} reglas.`);
    const ids = new Set<string>();
    return input.map((raw, i): SoundCue => {
        const c = (raw ?? {}) as Partial<SoundCue>;
        const n = i + 1;
        const id = String(c.id ?? "").trim() || `cue-${n}`;
        if (ids.has(id)) throw new Error(`Regla ${n}: identificador repetido.`);
        ids.add(id);
        const sound = String(c.sound ?? "").trim();
        if (!soundExists(sound)) throw new Error(`Regla ${n}: "${sound || "(vacío)"}" no es un sonido de este juego.`);
        const delayMs = Math.round(Number(c.delayMs ?? 0));
        if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new Error(`Regla ${n}: el retraso tiene que estar entre 0 y 60 000 ms.`);
        const volume = Number(c.volume ?? 1);
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error(`Regla ${n}: el volumen tiene que estar entre 0 y 1.`);
        const cue: SoundCue = {
            id,
            ...trigger(c, `Regla ${n}`),
            delayMs,
            sound,
            volume: Math.round(volume * 100) / 100,
            loop: c.loop === true,
            stopOn: c.stopOn ? trigger(c.stopOn, `Regla ${n} (parar)`) : null,
            enabled: c.enabled !== false,
        };
        const label = typeof c.label === "string" ? c.label.trim().slice(0, 120) : "";
        if (label) cue.label = label;
        return cue;
    });
}

export const sameCues = (a: SoundCue[], b: SoundCue[]) => serializeCues(a) === serializeCues(b);
