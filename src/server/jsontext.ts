// Edición de JSON "quirúrgica": cambia valores o añade claves en su posición exacta del texto,
// sin reformatear el resto del archivo (los JSON del juego tienen formato propio y viven en git).
import type { JsonPath } from "../shared/types.ts";

export const pathKey = (path: JsonPath): string => JSON.stringify(path);

interface Member {
    key: string | number;
    keyStart: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
}

export type JsonNode =
    | { kind: "object" | "array"; start: number; end: number; path: JsonPath; members: Member[] }
    | { kind: "primitive"; start: number; end: number; path: JsonPath };

export type JsonEdit =
    | { op: "set"; path: JsonPath; value: unknown }
    | { op: "add"; path: JsonPath; key: string; value: unknown };

/** Recorre el texto y devuelve la posición de cada valor: Map(pathKey -> nodo). */
export function locate(text: string): Map<string, JsonNode> {
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const out = new Map<string, JsonNode>();
    const ws = () => {
        while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
    };
    const fail = (msg: string): never => {
        throw new Error(`JSON inválido en la posición ${i}: ${msg}`);
    };
    const str = (): [number, number] => {
        if (text[i] !== '"') fail("se esperaba una cadena");
        const s = i++;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        if (i >= text.length) fail("cadena sin cerrar");
        i++;
        return [s, i];
    };
    const value = (path: JsonPath): void => {
        ws();
        const start = i;
        const c = text[i];
        if (c === "{" || c === "[") {
            const isObj = c === "{";
            const close = isObj ? "}" : "]";
            const members: Member[] = [];
            i++;
            ws();
            if (text[i] === close) i++;
            else {
                for (let n = 0; ; n++) {
                    ws();
                    let key: string | number = n;
                    let keyStart = i;
                    let keyEnd = i;
                    if (isObj) {
                        [keyStart, keyEnd] = str();
                        key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
                        ws();
                        if (text[i] !== ":") fail("se esperaba ':'");
                        i++;
                        ws();
                    }
                    const valueStart = i;
                    value([...path, key]);
                    members.push({ key, keyStart, keyEnd, valueStart, valueEnd: i });
                    ws();
                    if (text[i] === ",") {
                        i++;
                        continue;
                    }
                    if (text[i] !== close) fail(`se esperaba ',' o '${close}'`);
                    i++;
                    break;
                }
            }
            out.set(pathKey(path), { kind: isObj ? "object" : "array", start, end: i, path, members });
            return;
        }
        if (c === '"') str();
        else {
            while (i < text.length && !" \t\r\n,]}".includes(text[i]!)) i++;
            if (i === start) fail("valor vacío");
        }
        out.set(pathKey(path), { kind: "primitive", start, end: i, path });
    };
    value([]);
    return out;
}

/**
 * Aplica ediciones respetando el formato. Las que apuntan a una ruta inexistente se ignoran
 * y se devuelven en `skipped`. Nunca devuelve un JSON roto: si lo fuera, lanza un error.
 */
export function applyEdits(text: string, edits: JsonEdit[]): { text: string; skipped: JsonEdit[] } {
    const nodes = locate(text);
    const splices: { start: number; end: number; text: string; n?: number }[] = [];
    const skipped: JsonEdit[] = [];
    for (const e of edits) {
        const node = nodes.get(pathKey(e.path));
        if (e.op === "set") {
            if (!node) {
                skipped.push(e);
                continue;
            }
            splices.push({ start: node.start, end: node.end, text: JSON.stringify(e.value) });
            continue;
        }
        if (!node || node.kind !== "object") {
            skipped.push(e);
            continue;
        }
        const existing = node.members.find((m) => m.key === e.key);
        if (existing) {
            splices.push({ start: existing.valueStart, end: existing.valueEnd, text: JSON.stringify(e.value) });
            continue;
        }
        const last = node.members.at(-1);
        if (last && !text.slice(node.start, last.keyStart).includes("\n")) {
            // Objeto escrito en una sola línea: se añade en la misma línea
            const sep = text.slice(last.keyEnd, last.valueStart);
            splices.push({ start: last.valueEnd, end: last.valueEnd, text: `, ${JSON.stringify(e.key)}${sep}${JSON.stringify(e.value)}` });
        } else if (last) {
            const lineStart = text.lastIndexOf("\n", last.keyStart) + 1;
            const before = text.slice(lineStart, last.keyStart);
            const indent = /^\s*$/.test(before) ? before : " ".repeat(4);
            const sep = text.slice(last.keyEnd, last.valueStart); // respeta '": "' o '":"'
            splices.push({
                start: last.valueEnd,
                end: last.valueEnd,
                text: `,\n${indent}${JSON.stringify(e.key)}${sep}${JSON.stringify(e.value)}`,
            });
        } else {
            splices.push({
                start: node.start + 1,
                end: node.end - 1,
                text: `\n    ${JSON.stringify(e.key)}: ${JSON.stringify(e.value)}\n`,
            });
        }
    }
    // Varias inserciones en el mismo punto: se aplican en el orden pedido
    splices.forEach((s, n) => (s.n = n));
    splices.sort((a, b) => b.start - a.start || b.n! - a.n!);
    let out = text;
    for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
    JSON.parse(out.replace(/^﻿/, "")); // nunca escribir un JSON roto
    return { text: out, skipped };
}
