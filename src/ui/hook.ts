// SoundTool: se inyecta en el juego (antes que su código) y:
//   1. avisa de cada sonido que se reproduce (sin depender del engine ni de @pixi/sound):
//        descarga (fetch / XHR) -> ArrayBuffer -> decodeAudioData -> AudioBuffer -> start()
//      guardamos la URL en cada paso para saber qué archivo suena;
//   2. avisa de los eventos del engine (GDP.EventManager los lanza como CustomEvent en el canvas);
//   3. reproduce las reglas de sonido de SoundTool cuando ocurren esos eventos.
//
// Se compila como script clásico (IIFE): tiene que ejecutarse antes que los módulos del juego.
import type { GameEventRecord, HookCommand, HookMessage, SoundCue } from "../shared/types.ts";

type Payload = HookMessage extends infer M ? (M extends HookMessage ? Omit<M, "__soundtool"> : never) : never;

(() => {
    if (window.__soundtoolHook) return;
    window.__soundtoolHook = true;

    const AUDIO_RE = /\.(mp3|ogg|wav|m4a|aac|webm)(?:[?#]|$)/i;
    /** Hora absoluta: es comparable entre recargas del juego */
    const now = () => performance.timeOrigin + performance.now();
    const send = (msg: Payload) => {
        try {
            window.parent.postMessage({ __soundtool: true, ...msg }, "*");
        } catch {
            // sin ventana padre (juego abierto fuera de SoundTool): nada que hacer
        }
    };
    const norm = (u: string) => {
        try {
            return decodeURIComponent(new URL(u, location.href).pathname);
        } catch {
            return String(u);
        }
    };
    const bufferUrl = new WeakMap<ArrayBuffer, string>();
    const audioUrl = new WeakMap<AudioBuffer, string>();
    const xhrUrl = new WeakMap<XMLHttpRequest, string>();
    const announced = new WeakSet<AudioBufferSourceNode>();
    let seq = 0;

    // ------------------------------------------------------------ 1. sonidos del juego

    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const p = origFetch.call(this, input, init);
            if (!url || !AUDIO_RE.test(url)) return p;
            return p.then((res) => {
                const ab = res.arrayBuffer;
                res.arrayBuffer = function (this: Response) {
                    return ab.call(this).then((buf) => {
                        bufferUrl.set(buf, norm(url));
                        return buf;
                    });
                };
                return res;
            });
        };
    }
    const XHR = window.XMLHttpRequest?.prototype;
    if (XHR) {
        const open = XHR.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
        XHR.open = function (this: XMLHttpRequest, ...args: unknown[]) {
            xhrUrl.set(this, String(args[1]));
            return open.apply(this, args);
        } as typeof XHR.open;
        const desc = Object.getOwnPropertyDescriptor(XHR, "response");
        const getResponse = desc?.get;
        if (desc && getResponse) {
            Object.defineProperty(XHR, "response", {
                ...desc,
                get(this: XMLHttpRequest) {
                    const r: unknown = getResponse.call(this);
                    const url = xhrUrl.get(this);
                    if (r instanceof ArrayBuffer && url && AUDIO_RE.test(url)) bufferUrl.set(r, norm(url));
                    return r;
                },
            });
        }
    }

    const Ctx = window.BaseAudioContext ?? window.AudioContext ?? window.webkitAudioContext;
    if (Ctx) {
        const decode = Ctx.prototype.decodeAudioData;
        Ctx.prototype.decodeAudioData = function (
            this: BaseAudioContext,
            buf: ArrayBuffer,
            ok?: DecodeSuccessCallback | null,
            err?: DecodeErrorCallback | null
        ) {
            const url = bufferUrl.get(buf); // antes de llamar: decodeAudioData vacía el buffer
            const tag = (b: AudioBuffer) => {
                if (b && url) audioUrl.set(b, url);
                return b;
            };
            const p = decode.call(this, buf, ok ? (b) => ok(tag(b)) : ok, err);
            return p?.then ? p.then(tag) : p;
        };
    }

    if (window.AudioBufferSourceNode) {
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: [number?, number?, number?]) {
            const url = this.buffer ? audioUrl.get(this.buffer) : undefined;
            if (url && this.buffer && !announced.has(this)) {
                announced.add(this);
                const id = ++seq;
                send({ type: "play", id, url, loop: this.loop, duration: this.buffer.duration, t: now() });
                this.addEventListener("ended", () => send({ type: "end", id, t: now() }), { once: true });
            }
            return start.apply(this, args);
        };
    }

    if (window.HTMLMediaElement) {
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
            const url = this.currentSrc || this.src;
            if (this instanceof HTMLAudioElement && url && AUDIO_RE.test(url)) {
                const id = ++seq;
                send({ type: "play", id, url: norm(url), loop: this.loop, duration: this.duration || 0, t: now() });
                const end = () => {
                    this.removeEventListener("ended", end);
                    this.removeEventListener("pause", end);
                    send({ type: "end", id, t: now() });
                };
                this.addEventListener("ended", end);
                this.addEventListener("pause", end);
            }
            return play.call(this);
        };
    }

    // ------------------------------------------------------------ 2. eventos del engine

    /** Resumen barato y seguro del valor de un evento (puede ser un objeto de Pixi enorme o circular) */
    const summarize = (d: unknown): string => {
        if (d == null) return "";
        if (typeof d !== "object") return String(d).slice(0, 120);
        if (Array.isArray(d)) return `[${d.length}]`;
        const parts: string[] = [];
        for (const k of Object.keys(d).slice(0, 12)) {
            const v = (d as Record<string, unknown>)[k];
            if (v === null || ["string", "number", "boolean"].includes(typeof v)) parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
            if (parts.length >= 6) break;
        }
        return `{${parts.join(",")}}`.slice(0, 160);
    };

    let queue: GameEventRecord[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
        flushTimer = undefined;
        if (!queue.length) return;
        send({ type: "events", items: queue });
        queue = [];
    };

    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event) {
        if (event instanceof CustomEvent && this instanceof HTMLCanvasElement) {
            const rec: GameEventRecord = { name: event.type, detail: summarize(event.detail), t: now() };
            queue.push(rec);
            flushTimer ??= setTimeout(flush, 40);
            runCues(rec);
        }
        return dispatch.call(this, event);
    };

    // ------------------------------------------------------------ 3. reglas de sonido

    let cues: SoundCue[] = [];
    let rev = 0;
    let ctx: AudioContext | null = null;
    const buffers = new Map<string, Promise<AudioBuffer>>();
    const playing = new Map<string, Set<{ src: AudioBufferSourceNode; timer?: ReturnType<typeof setTimeout> }>>();
    const startNode = window.AudioBufferSourceNode?.prototype.start;

    const audio = (): AudioContext | null => {
        if (!window.AudioContext) return null;
        ctx ??= new AudioContext();
        if (ctx.state === "suspended") void ctx.resume();
        return ctx;
    };
    // Los navegadores solo dejan sonar tras una interacción: se reactiva en el primer clic/tecla
    for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => void audio(), { capture: true, passive: true });

    const load = (sound: string): Promise<AudioBuffer> => {
        const key = `${rev}|${sound}`;
        let p = buffers.get(key);
        if (!p) {
            const ac = audio();
            p = fetch(`/__soundtool/api/file?alias=${encodeURIComponent(sound)}&rev=${rev}`)
                .then((r) => {
                    if (!r.ok || !ac) throw new Error(`No se pudo cargar ${sound}`);
                    return r.arrayBuffer();
                })
                .then((b) => ac!.decodeAudioData(b));
            p.catch(() => buffers.delete(key));
            buffers.set(key, p);
        }
        return p;
    };

    const matches = (trigger: { on: string; match?: string }, ev: GameEventRecord) =>
        trigger.on === ev.name && (!trigger.match || ev.detail.includes(trigger.match));

    const stopCue = (cue: SoundCue) => {
        const nodes = playing.get(cue.id);
        if (!nodes?.size) return;
        for (const n of nodes) {
            clearTimeout(n.timer);
            try {
                n.src.stop();
            } catch {
                // ya parado
            }
        }
        nodes.clear();
        send({ type: "cue", cueId: cue.id, sound: cue.sound, phase: "stop", t: now() });
    };

    const playCue = (cue: SoundCue) => {
        const entry: { src: AudioBufferSourceNode; timer?: ReturnType<typeof setTimeout> } = { src: null as unknown as AudioBufferSourceNode };
        const set = playing.get(cue.id) ?? new Set();
        playing.set(cue.id, set);
        set.add(entry);
        entry.timer = setTimeout(async () => {
            const ac = audio();
            if (!ac || !set.has(entry)) return;
            try {
                const buf = await load(cue.sound);
                if (!set.has(entry)) return;
                const src = ac.createBufferSource();
                const gain = ac.createGain();
                src.buffer = buf;
                src.loop = cue.loop;
                gain.gain.value = cue.volume;
                src.connect(gain).connect(ac.destination);
                src.addEventListener("ended", () => set.delete(entry), { once: true });
                entry.src = src;
                startNode?.call(src); // sin pasar por el aviso de "sonido del juego"
                send({ type: "cue", cueId: cue.id, sound: cue.sound, phase: "start", t: now() });
            } catch {
                set.delete(entry);
            }
        }, cue.delayMs);
    };

    function runCues(ev: GameEventRecord): void {
        for (const cue of cues) {
            if (!cue.enabled) continue;
            if (cue.stopOn && matches(cue.stopOn, ev)) stopCue(cue);
            if (matches(cue, ev)) {
                if (cue.loop) stopCue(cue); // un bucle no se apila sobre sí mismo
                playCue(cue);
            }
        }
    }

    window.addEventListener("message", (e: MessageEvent) => {
        const cmd = e.data as HookCommand | undefined;
        if (!cmd || cmd.__soundtoolCmd !== true || e.source !== window.parent) return;
        rev = cmd.rev;
        if (cmd.type === "cues") {
            // Las reglas que ya no existen o cambiaron dejan de sonar
            for (const old of cues) if (!cmd.cues.some((c) => c.id === old.id && JSON.stringify(c) === JSON.stringify(old))) stopCue(old);
            cues = cmd.cues;
        } else if (cmd.type === "test-cue") {
            stopCue(cmd.cue);
            playCue({ ...cmd.cue, delayMs: 0 });
        }
    });

    send({ type: "ready", t: now() });
})();
