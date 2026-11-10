// Utilidades comunes de los tests: audios falsos y juegos de prueba en una carpeta temporal.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { crc32 } from "../src/server/zip.ts";

/** MP3 mínimo reconocible (cabecera ID3) con una marca para distinguirlo */
export const MP3 = (tag: string): Buffer => Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.from(tag)]);

/** Cabecera WAV mínima */
export function WAV(): Buffer {
    const b = Buffer.alloc(44);
    b.write("RIFF", 0, "latin1");
    b.write("WAVE", 8, "latin1");
    return b;
}

/** Crea un juego de prueba: { "public/assets/x.json": "...", ... } */
export function makeGame(name: string, files: Record<string, string | Buffer>): { root: string; game: string; dataDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundtool-test-"));
    const game = path.join(root, name);
    for (const [rel, data] of Object.entries(files)) {
        const p = path.join(game, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
    }
    return { root, game, dataDir: path.join(root, ".data") };
}

/** Lo mismo en public/ y en dist/ */
export function inPublicAndDist(files: Record<string, string | Buffer>): Record<string, string | Buffer> {
    const out: Record<string, string | Buffer> = {};
    for (const [rel, data] of Object.entries(files)) {
        out[`public/${rel}`] = data;
        out[`dist/${rel}`] = data;
    }
    return out;
}

export const read = (...p: string[]) => fs.readFileSync(path.join(...p));
export const readText = (...p: string[]) => fs.readFileSync(path.join(...p), "utf8");
export const exists = (...p: string[]) => fs.existsSync(path.join(...p));

/** Valor que el test exige que exista */
export function must<T>(value: T | null | undefined, what = "valor"): T {
    assert.ok(value != null, `falta ${what}`);
    return value;
}

/** Lector mínimo de ZIP para comprobar lo que escribimos (verifica el CRC de cada archivo) */
export function readZip(buf: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let p = buf.readUInt32LE(end + 16);
    const count = buf.readUInt16LE(end + 10);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28);
        const off = buf.readUInt32LE(p + 42);
        const name = buf.toString("utf8", p + 46, p + 46 + nlen);
        const lnlen = buf.readUInt16LE(off + 26);
        const data = buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize);
        const out = method === 8 ? zlib.inflateRawSync(data) : data;
        assert.equal(crc32(out), crc, `CRC de ${name}`);
        files.set(name, out);
        p += 46 + nlen;
    }
    return files;
}
