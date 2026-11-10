// Convierte cualquier audio que el navegador sepa leer (WAV, AIFF, OGG, M4A, FLAC…) a MP3,
// con el bitrate del sonido original. Todo ocurre en la app: no hace falta ffmpeg.

export interface ConvertedFile extends File {
    converted: { from: string; kbps: number; seconds: number };
}

let lameReady: Promise<void> | null = null;
function loadLame(): Promise<void> {
    lameReady ??= new Promise<void>((resolve, reject) => {
        if (window.lamejs) return resolve();
        const s = document.createElement("script");
        s.src = "/__soundtool/vendor/lame.min.js";
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("No se pudo cargar el codificador MP3"));
        document.head.append(s);
    });
    return lameReady;
}

const VALID_KBPS = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const nearestKbps = (k: number) => VALID_KBPS.reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a));

export function isMp3(file: File): boolean {
    return file.type === "audio/mpeg" || /\.mp3$/i.test(file.name);
}

function toInt16(f32: Float32Array): Int16Array {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]!));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

export async function toMp3(file: File, { bitrate = 128, onProgress = (_p: number) => {} } = {}): Promise<ConvertedFile> {
    await loadLame();
    const lame = window.lamejs;
    if (!lame) throw new Error("No se pudo cargar el codificador MP3");
    const RATE = 44100;
    let audio: AudioBuffer;
    try {
        // OfflineAudioContext a 44,1 kHz: decodifica y remuestrea en un paso
        audio = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(await file.arrayBuffer());
    } catch {
        throw new Error(`No se puede leer "${file.name}" como audio.`);
    }
    const channels = Math.min(2, audio.numberOfChannels);
    const kbps = nearestKbps(bitrate);
    const encoder = new lame.Mp3Encoder(channels, RATE, kbps);
    const left = toInt16(audio.getChannelData(0));
    const right = channels > 1 ? toInt16(audio.getChannelData(1)) : null;
    const parts: Uint8Array[] = [];
    const BLOCK = 1152 * 32;
    for (let i = 0; i < left.length; i += BLOCK) {
        const l = left.subarray(i, i + BLOCK);
        const chunk = right ? encoder.encodeBuffer(l, right.subarray(i, i + BLOCK)) : encoder.encodeBuffer(l);
        if (chunk.length) parts.push(new Uint8Array(chunk));
        if ((i / BLOCK) % 40 === 0) {
            onProgress(i / left.length);
            await new Promise((r) => setTimeout(r)); // no congelar la interfaz
        }
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    const name = file.name.replace(/\.[^.]+$/, "") + ".mp3";
    return Object.assign(new File(parts as BlobPart[], name, { type: "audio/mpeg" }), {
        converted: { from: file.name, kbps, seconds: audio.duration },
    });
}
