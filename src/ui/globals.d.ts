// Globales del navegador que usa SoundTool y que no vienen en lib.dom

/** Codificador MP3 de lamejs (se carga como script desde /__soundtool/vendor/lame.min.js) */
interface LameMp3Encoder {
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
}

interface Window {
    __soundtoolHook?: boolean;
    webkitAudioContext?: typeof AudioContext;
    lamejs?: {
        Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameMp3Encoder;
    };
}
