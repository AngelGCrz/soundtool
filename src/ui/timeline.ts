// Línea de tiempo de una partida: fase, estado, eventos del engine, sonidos y reglas.
// Solo dibuja lo visible (las sesiones largas tienen miles de eventos).
import type { GameEventRecord } from "../shared/types.ts";
import { NOISY, PHASES, STATE_LABEL, detailLabel, eventInfo, phaseOf } from "./events.ts";

interface Bar {
    key: string;
    ref: string; // soundId o cueId
    label: string;
    start: number;
    end: number | null;
    /** Si no hay fin, cuánto dura como mucho (los bucles siguen hasta que acaban) */
    duration: number;
    loop: boolean;
}

export interface TimelineCallbacks {
    onEventClick: (ev: GameEventRecord) => void;
    onSoundClick: (soundId: string) => void;
    onCueClick: (cueId: string) => void;
    /** Soltaron un audio: `ev` es el evento visible anterior (o null) y `delayMs` la distancia a él */
    onDropFile: (file: File, ev: GameEventRecord | null, delayMs: number) => void;
}

const LANES = { ruler: 0, phase: 18, state: 38, events: 58, sounds: 92 } as const;
const ROW_H = 16;
const MAX_SOUND_ROWS = 6;
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);

export class Timeline {
    events: GameEventRecord[] = [];
    readonly sounds = new Map<string, Bar>();
    readonly cues: Bar[] = [];
    pxPerSec = 120;
    showAll = false;
    follow = true;

    #t0: number | null = null;
    #tMax = 0;
    #frame = 0;
    #dropX: number | null = null;
    readonly #root: HTMLElement;
    readonly #scroll: HTMLElement;
    readonly #inner: HTMLElement;
    readonly #labels: HTMLElement;
    readonly #cb: TimelineCallbacks;

    constructor(root: HTMLElement, cb: TimelineCallbacks) {
        this.#root = root;
        this.#cb = cb;
        root.innerHTML = `<div class="tl-labels"></div><div class="tl-scroll"><div class="tl-inner"></div></div>`;
        this.#labels = root.querySelector(".tl-labels")!;
        this.#scroll = root.querySelector(".tl-scroll")!;
        this.#inner = root.querySelector(".tl-inner")!;

        this.#scroll.addEventListener("scroll", () => {
            const s = this.#scroll;
            this.follow = s.scrollLeft + s.clientWidth >= s.scrollWidth - 40;
            this.render();
        });
        this.#inner.addEventListener("click", (e) => this.#onClick(e));
        this.#scroll.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            this.#dropX = this.#xOf(e.clientX);
            this.render();
        });
        this.#scroll.addEventListener("dragleave", () => {
            this.#dropX = null;
            this.render();
        });
        this.#scroll.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const file = e.dataTransfer?.files[0];
            const x = this.#xOf(e.clientX);
            this.#dropX = null;
            this.render();
            if (!file || this.#t0 === null) return;
            const t = this.#t0 + (x / this.pxPerSec) * 1000;
            const ev = [...this.#visibleEvents()].reverse().find((v) => v.t <= t) ?? null;
            this.#cb.onDropFile(file, ev, ev ? Math.max(0, Math.round(t - ev.t)) : 0);
        });
    }

    get isEmpty(): boolean {
        return this.#t0 === null;
    }

    reset(): void {
        this.events = [];
        this.sounds.clear();
        this.cues.length = 0;
        this.#t0 = null;
        this.#tMax = 0;
        this.follow = true;
        this.render();
    }

    #touch(t: number): void {
        if (this.#t0 === null || t < this.#t0) this.#t0 = t;
        if (t > this.#tMax) this.#tMax = t;
        this.render();
    }

    addEvents(items: GameEventRecord[]): void {
        if (!items.length) return;
        this.events.push(...items);
        if (this.events.length > 20000) this.events.splice(0, this.events.length - 20000);
        this.#touch(items[items.length - 1]!.t);
        if (this.#t0 === null || items[0]!.t < this.#t0) this.#touch(items[0]!.t);
    }

    soundStart(key: string, ref: string, label: string, t: number, loop: boolean, duration: number): void {
        this.sounds.set(key, { key, ref, label, start: t, end: null, duration: duration * 1000, loop });
        this.#touch(t);
    }

    soundEnd(key: string, t: number): void {
        const b = this.sounds.get(key);
        if (b) b.end = t;
        this.#touch(t);
    }

    cueStart(cueId: string, label: string, t: number, duration: number, loop: boolean): void {
        this.cues.push({ key: `${cueId}@${t}`, ref: cueId, label, start: t, end: null, duration, loop });
        this.#touch(t);
    }

    cueStop(cueId: string, t: number): void {
        for (const b of this.cues) if (b.ref === cueId && b.end === null) b.end = t;
        this.#touch(t);
    }

    /** Agrupa los cambios en un solo dibujado por fotograma */
    render(): void {
        if (this.#frame) return;
        this.#frame = requestAnimationFrame(() => {
            this.#frame = 0;
            this.#draw();
        });
    }

    #xOf(clientX: number): number {
        return clientX - this.#inner.getBoundingClientRect().left;
    }

    #x(t: number): number {
        return ((t - (this.#t0 ?? t)) / 1000) * this.pxPerSec;
    }

    *#visibleEvents(): Generator<GameEventRecord> {
        for (const e of this.events) if (this.showAll || !NOISY.has(e.name)) yield e;
    }

    #onClick(e: MouseEvent): void {
        const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-ev],[data-sound],[data-cue]") : null;
        if (!el) return;
        if (el.dataset.ev) {
            const ev = this.events[Number(el.dataset.ev)];
            if (ev) this.#cb.onEventClick(ev);
        } else if (el.dataset.sound) this.#cb.onSoundClick(el.dataset.sound);
        else if (el.dataset.cue) this.#cb.onCueClick(el.dataset.cue);
    }

    #barEnd(b: Bar, now: number): number {
        if (b.end !== null) return b.end;
        return b.loop ? now : Math.min(now, b.start + (b.duration || 300));
    }

    #draw(): void {
        const now = Date.now();
        const soundRows = Math.min(MAX_SOUND_ROWS, Math.max(1, this.#rowsNeeded(now)));
        const cueTop = LANES.sounds + soundRows * ROW_H + 6;
        const height = cueTop + ROW_H + 4;
        this.#root.style.setProperty("--tl-h", `${height}px`);
        this.#labels.innerHTML = [
            ["Fase", LANES.phase],
            ["Estado", LANES.state],
            ["Eventos", LANES.events],
            ["Sonidos", LANES.sounds],
            ["Reglas", cueTop],
        ]
            .map(([l, top]) => `<div style="top:${top}px">${l}</div>`)
            .join("");

        if (this.#t0 === null) {
            this.#inner.style.width = "100%";
            this.#inner.innerHTML = `<div class="tl-empty">Juega y aquí se dibuja la partida: fases, eventos del juego y sonidos. Suelta un audio en la línea para que suene en ese momento.</div>`;
            return;
        }
        const end = Math.max(this.#tMax, ...[...this.sounds.values()].filter((b) => b.end === null && b.loop).map(() => now));
        const width = this.#x(end) + 240;
        this.#inner.style.width = `${width}px`;
        const s = this.#scroll;
        if (this.follow) s.scrollLeft = s.scrollWidth;
        const from = s.scrollLeft - 300;
        const to = s.scrollLeft + s.clientWidth + 300;
        const visible = (x1: number, x2 = x1) => x2 >= from && x1 <= to;
        const html: string[] = [];

        // Regla de tiempo
        const step = this.pxPerSec >= 60 ? 1 : this.pxPerSec >= 20 ? 5 : 15;
        for (let sec = 0; ; sec += step) {
            const x = sec * this.pxPerSec;
            if (x > width) break;
            if (visible(x)) html.push(`<div class="tl-tick" style="left:${x}px"><span>${sec}s</span></div>`);
        }

        // Fase (normal / free games / hold & spin) y estado (girando, premio…)
        const segments = (pick: (e: GameEventRecord) => string | null, render: (v: string) => [string, string], top: number, initial?: string) => {
            // (as: TypeScript no sigue las asignaciones hechas dentro del bucle al usarla en close())
            let cur = (initial ? { v: initial, t: this.#t0! } : null) as { v: string; t: number } | null;
            const close = (tEnd: number) => {
                if (!cur) return;
                const x1 = this.#x(cur.t);
                const x2 = this.#x(tEnd);
                const [label, cls] = render(cur.v);
                if (visible(x1, x2)) html.push(`<div class="tl-seg ${cls}" style="left:${x1}px;width:${Math.max(2, x2 - x1)}px;top:${top}px" title="${esc(label)}">${esc(label)}</div>`);
            };
            for (const e of this.events) {
                const v = pick(e);
                if (v === null || v === cur?.v) continue;
                close(e.t);
                cur = { v, t: e.t };
            }
            close(end);
        };
        segments(
            (e) => phaseOf(e.name, e.detail),
            (v) => [PHASES[v]?.label ?? v, `phase-${PHASES[v]?.cls ?? "normal"}`],
            LANES.phase,
            "0" // el engine solo avisa al cambiar de fase: hasta entonces es juego normal
        );
        segments(
            (e) => (e.name === "STATE_CHANGED" ? e.detail : null),
            (v) => [STATE_LABEL[v] ?? v, `state-${v.replace("GAMESTATE_", "").toLowerCase()}`],
            LANES.state
        );

        // Eventos
        this.events.forEach((e, i) => {
            if (!this.showAll && NOISY.has(e.name)) return;
            const x = this.#x(e.t);
            if (!visible(x)) return;
            const { label, cat } = eventInfo(e.name);
            const d = detailLabel(e.name, e.detail);
            const rel = ((e.t - this.#t0!) / 1000).toFixed(2);
            html.push(
                `<div class="tl-ev cat-${cat}" data-ev="${i}" style="left:${x}px;top:${LANES.events}px" title="${esc(label)}${d ? ": " + esc(d) : ""}\n${esc(e.name)} · ${rel}s\nClic: crear una regla aquí"></div>`
            );
        });

        // Sonidos del juego (en filas para que no se tapen) y reglas
        const rows: number[] = [];
        const bars = [...this.sounds.values()].sort((a, b) => a.start - b.start);
        for (const b of bars) {
            const bEnd = this.#barEnd(b, now);
            let row = rows.findIndex((r) => r <= b.start);
            if (row < 0) row = rows.length < soundRows ? rows.length : soundRows - 1;
            rows[row] = bEnd;
            const x1 = this.#x(b.start);
            const x2 = this.#x(bEnd);
            if (!visible(x1, x2)) continue;
            html.push(
                `<div class="tl-bar${b.loop ? " loop" : ""}${b.end === null ? " live" : ""}" data-sound="${esc(b.ref)}" style="left:${x1}px;width:${Math.max(3, x2 - x1)}px;top:${LANES.sounds + row * ROW_H}px" title="${esc(b.label)}${b.loop ? " (bucle)" : ""}">${esc(b.label)}</div>`
            );
        }
        for (const b of this.cues) {
            const x1 = this.#x(b.start);
            const x2 = this.#x(this.#barEnd(b, now));
            if (!visible(x1, x2)) continue;
            html.push(
                `<div class="tl-bar cue${b.end === null ? " live" : ""}" data-cue="${esc(b.ref)}" style="left:${x1}px;width:${Math.max(3, x2 - x1)}px;top:${cueTop}px" title="Regla: ${esc(b.label)}">◆ ${esc(b.label)}</div>`
            );
        }

        if (this.#dropX !== null) html.push(`<div class="tl-drop" style="left:${this.#dropX}px"></div>`);
        this.#inner.innerHTML = html.join("");
        if (this.follow) s.scrollLeft = s.scrollWidth;

        // Mientras algo suena en bucle, la barra sigue creciendo
        if ([...this.sounds.values(), ...this.cues].some((b) => b.end === null && b.loop)) setTimeout(() => this.render(), 500);
    }

    #rowsNeeded(now: number): number {
        const rows: number[] = [];
        for (const b of [...this.sounds.values()].sort((a, c) => a.start - c.start)) {
            const i = rows.findIndex((r) => r <= b.start);
            if (i < 0) rows.push(this.#barEnd(b, now));
            else rows[i] = this.#barEnd(b, now);
        }
        return rows.length;
    }
}
