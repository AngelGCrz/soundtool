// Lee la cabecera del primer frame de un MP3 (bitrate, frecuencia, canales) sin dependencias.
import fs from "node:fs";
import type { Mp3Info } from "../shared/types.ts";

type MpegVersion = 1 | 2 | 2.5;

// kbps por índice, para Layer III
const BITRATES: Record<"v1" | "v2", number[]> = {
    v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<MpegVersion, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
const VERSION_BITS: Partial<Record<number, MpegVersion>> = { 0: 2.5, 2: 2, 3: 1 };

export function mp3Info(file: string): Mp3Info | null {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, "r");
        const head = Buffer.alloc(10);
        fs.readSync(fd, head, 0, 10, 0);
        let start = 0;
        if (head.toString("latin1", 0, 3) === "ID3") {
            start = 10 + ((head[6]! << 21) | (head[7]! << 14) | (head[8]! << 7) | head[9]!) + (head[5]! & 0x10 ? 10 : 0);
        }
        const buf = Buffer.alloc(16384);
        const n = fs.readSync(fd, buf, 0, buf.length, start);
        for (let i = 0; i + 4 < n; i++) {
            if (buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) continue;
            const ver = VERSION_BITS[(buf[i + 1]! >> 3) & 3];
            const layer = (buf[i + 1]! >> 1) & 3; // 1 = Layer III
            const bi = buf[i + 2]! >> 4;
            const si = (buf[i + 2]! >> 2) & 3;
            if (!ver || layer !== 1 || bi === 0 || bi === 15 || si === 3) continue;
            const frame = buf.subarray(i, i + 200).toString("latin1");
            return {
                bitrate: BITRATES[ver === 1 ? "v1" : "v2"][bi]!,
                sampleRate: RATES[ver][si]!,
                channels: buf[i + 3]! >> 6 === 3 ? 1 : 2,
                vbr: frame.includes("Xing") || frame.includes("VBRI"),
            };
        }
    } catch {
        // archivo ilegible: sin información
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return null;
}
