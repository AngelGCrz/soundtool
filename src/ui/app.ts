import { toMp3, isMp3 } from "./convert.ts";
import { Timeline } from "./timeline.ts";
import { CATEGORY_LABEL, KNOWN_EVENTS, NOISY, PHASES, STATE_LABEL, describeTrigger, detailLabel, eventInfo, type EventCategory } from "./events.ts";
import type {
    AppState,
    BackupManifest,
    Change,
    DiscoverResponse,
    GameEventRecord,
    HookCommand,
    HookMessage,
    JsonPath,
    JsonPrimitive,
    LocalGame,
    MomentView,
    PortalData,
    RemoteSettings,
    RestoreResponse,
    SaveResponse,
    SoundCue,
    SoundView,
} from "../shared/types.ts";

type Tab = "sounds" | "moments" | "cues";
type Filter = "all" | "game" | "common" | "played" | "pending";
type PickerTab = "portal" | "local";
type PortalResponse = PortalData & { settings: RemoteSettings };

const API = "/__soundtool/api/";

/** Elemento obligatorio de la página (si falta, el HTML y el código no coinciden) */
function $<T extends HTMLElement = HTMLElement>(sel: string): T {
    const el = document.querySelector<T>(sel);
    if (!el) throw new Error(`Falta ${sel} en la página`);
    return el;
}
const $input = (sel: string) => $<HTMLInputElement>(sel);
const $select = (sel: string) => $<HTMLSelectElement>(sel);
const $button = (sel: string) => $<HTMLButtonElement>(sel);
/** Elemento más cercano (desde el target de un evento) que cumple el selector */
const closest = <T extends HTMLElement = HTMLElement>(target: EventTarget | null, sel: string) =>
    target instanceof Element ? target.closest<T>(sel) : null;

let state: AppState | null = null;
let tab: Tab = "sounds";
let filter: Filter = "all";
let query = "";
let previewStale = false;
let replaceTarget: string | null = null; // id del sonido al que va el archivo elegido con "Reemplazar…"
let fileMode: "replace" | "new" = "replace";

/** Estado de la sesión: solo se llama cuando ya hay un juego abierto */
function current(): AppState {
    if (!state) throw new Error("Todavía no hay estado");
    return state;
}

// ---------------------------------------------------------------- API

interface CallOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    raw?: ArrayBuffer;
}

async function call<T>(route: string, { method = "GET", body, raw }: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = raw ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {};
    const res = await fetch(API + route, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
}

const fileUrl = (id: string, which = "original") => `${API}file?id=${encodeURIComponent(id)}&which=${which}&t=${Date.now()}`;
const aliasUrl = (alias: string) => `${API}file?alias=${encodeURIComponent(alias)}&t=${Date.now()}`;

// ---------------------------------------------------------------- utilidades

function toast(msg: string, kind: "" | "ok" | "err" = ""): void {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), kind === "err" ? 7000 : 3500);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
const kb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const fmtDur = (s: number | null | undefined) =>
    s == null || !isFinite(s) ? "" : s < 60 ? s.toFixed(1) + " s" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const ICON_PLAY = '<svg viewBox="0 0 10 12"><path d="M0 0l10 6-10 6z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 10 10"><rect width="10" height="10" rx="1"/></svg>';
const fileName = (p: string) => p.split("/").pop() ?? p;
const labelOf = (s: SoundView) => s.refs[0]?.alias ?? fileName(s.rel);
const shortJson = (j: string) => j.replace(/^assets\//, "");

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        toast((err as Error).message, "err");
        return undefined;
    }
}

// ---------------------------------------------------------------- reproductor

const player = new Audio();
let playingKey: string | null = null;

function togglePlay(key: string, url: string): void {
    if (playingKey === key) return stopPlayer();
    player.src = url;
    player.play().catch((e: Error) => toast("No se pudo reproducir: " + e.message, "err"));
    playingKey = key;
    syncPlayButtons();
}
function stopPlayer(): void {
    player.pause();
    playingKey = null;
    syncPlayButtons();
}
player.addEventListener("ended", stopPlayer);
function syncPlayButtons(): void {
    for (const b of document.querySelectorAll<HTMLElement>(".play[data-key]")) {
        const on = b.dataset.key === playingKey;
        b.classList.toggle("playing", on);
        b.innerHTML = on ? ICON_STOP : ICON_PLAY;
    }
}

// Duraciones: se cargan de a una para no saturar
const durations = new Map<string, number | null>();
const durationQueue: { key: string; url: string }[] = [];
let durationBusy = false;
// Referencia viva: si no, el navegador puede descartar el <audio> antes de que cargue
let durationAudio: HTMLAudioElement | null = null;
function wantDuration(key: string, url: string): void {
    if (durations.has(key) || durationQueue.some((q) => q.key === key)) return;
    durationQueue.push({ key, url });
    pumpDurations();
}
function pumpDurations(): void {
    const next = durationBusy ? undefined : durationQueue.shift();
    if (!next) return;
    durationBusy = true;
    const a = new Audio();
    durationAudio = a;
    a.preload = "metadata";
    let finished = false;
    const done = (v: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        a.onloadedmetadata = a.onerror = null;
        a.removeAttribute("src");
        a.load();
        if (durationAudio === a) durationAudio = null;
        durations.set(next.key, v);
        const el = document.querySelector(`[data-dur="${CSS.escape(next.key)}"]`);
        if (el) el.textContent = fmtDur(v);
        durationBusy = false;
        pumpDurations();
    };
    const timer = setTimeout(() => done(null), 8000);
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(null);
    a.src = next.url;
}

// ---------------------------------------------------------------- en vivo

interface LiveEntry {
    id: number;
    time: Date;
    url: string;
    soundId: string;
    loop: boolean;
    duration: number;
}
interface ActiveSound {
    soundId: string;
    url: string;
    loop: boolean;
}

const live = {
    paused: false,
    connected: false,
    entries: [] as LiveEntry[],
    /** instancia que suena -> sonido */
    active: new Map<number, ActiveSound>(),
    /** soundId -> veces que sonó */
    plays: new Map<string, number>(),
};
let urlToSound = new Map<string, SoundView>();
let aliasToMoments = new Map<string, MomentView[]>();

function indexState(): void {
    urlToSound = new Map((state?.sounds ?? []).map((s) => [s.url, s]));
    aliasToMoments = new Map();
    for (const m of state?.moments ?? []) {
        const v = String(m.pendingValue ?? m.value);
        aliasToMoments.set(v, [...(aliasToMoments.get(v) ?? []), m]);
    }
}

function soundAliases(s: SoundView | null | undefined): string[] {
    return s ? [...new Set(s.refs.map((r) => r.alias))] : [];
}
const soundById = (id: string) => state?.sounds.find((x) => x.id === id);

/** El juego del portal pide /__remote/g/assets/… y /common/v0.23.663/…; la lista usa /assets/… y /common/… */
const normUrl = (u: string) =>
    u
        .replace(/^\/__remote\/g\/+/, "/")
        .replace(/^\/common\/v[^/]+\//, "/common/")
        .replace(/\/{2,}/g, "/");

function isHookMessage(data: unknown): data is HookMessage {
    return !!data && typeof data === "object" && (data as { __soundtool?: unknown }).__soundtool === true;
}

window.addEventListener("message", (e: MessageEvent) => {
    if (!isHookMessage(e.data) || e.source !== $<HTMLIFrameElement>("#game").contentWindow) return;
    const msg = e.data;
    if (msg.type === "ready") {
        live.connected = true;
        live.active.clear();
        loadN++;
        sendCues();
        renderLiveHead();
        refreshLiveClasses();
        return;
    }
    if (msg.type === "events") {
        for (const ev of msg.items) {
            const seen = observed.get(ev.name) ?? new Map<string, number>();
            seen.set(ev.detail, (seen.get(ev.detail) ?? 0) + 1);
            observed.set(ev.name, seen);
        }
        if (!live.paused) timeline.addEvents(msg.items);
        return;
    }
    if (msg.type === "cue") {
        const cue = state?.cues.find((c) => c.id === msg.cueId);
        if (msg.phase === "stop") timeline.cueStop(msg.cueId, msg.t);
        else if (!live.paused) {
            timeline.cueStart(msg.cueId, cue?.label || msg.sound, msg.t, aliasDurationMs(msg.sound), !!cue?.loop);
            flashCue(msg.cueId);
        }
        return;
    }
    if (msg.type === "play") {
        const url = normUrl(msg.url);
        const s = urlToSound.get(url);
        if (!s) discoverSoon(url);
        const soundId = s?.id ?? "url:" + url;
        live.plays.set(soundId, (live.plays.get(soundId) ?? 0) + 1);
        live.active.set(msg.id, { soundId, url, loop: msg.loop });
        if (!live.paused) timeline.soundStart(`${loadN}:${msg.id}`, soundId, s ? labelOf(s) : fileName(url), msg.t, msg.loop, msg.duration);
        if (!live.paused) {
            live.entries.unshift({ id: msg.id, time: new Date(), url, soundId, loop: msg.loop, duration: msg.duration });
            if (live.entries.length > 400) live.entries.length = 400;
            renderLiveList();
        }
        renderLiveHead();
        refreshLiveClasses();
        if (filter === "played" && tab === "sounds") renderList();
        return;
    }
    live.active.delete(msg.id);
    timeline.soundEnd(`${loadN}:${msg.id}`, msg.t);
    renderLiveHead();
    refreshLiveClasses();
    document.querySelector(`#liveList li[data-inst="${msg.id}"]`)?.classList.remove("active");
});

// Audios que sonaron y no estaban en la lista (p. ej. rollups de common/): se piden al servidor
const toDiscover = new Set<string>();
const triedDiscover = new Set<string>();
let discoverTimer: ReturnType<typeof setTimeout> | undefined;
function discoverSoon(url: string): void {
    if (triedDiscover.has(url)) return;
    triedDiscover.add(url);
    toDiscover.add(url);
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(async () => {
        const urls = [...toDiscover];
        toDiscover.clear();
        const r = await call<DiscoverResponse>("discover", { method: "POST", body: { urls } }).catch(() => null);
        if (!r || "unchanged" in r) return;
        state = r;
        // Las entradas ya registradas pasan a apuntar al sonido descubierto
        indexState();
        for (const e of live.entries) {
            const s = urlToSound.get(e.url);
            if (s && e.soundId.startsWith("url:")) e.soundId = s.id;
        }
        for (const a of live.active.values()) {
            const s = urlToSound.get(a.url);
            if (s) a.soundId = s.id;
        }
        for (const b of timeline.sounds.values()) {
            const s = b.ref.startsWith("url:") ? urlToSound.get(b.ref.slice(4)) : undefined;
            if (s) {
                b.ref = s.id;
                b.label = labelOf(s);
            }
        }
        const moved = new Map<string, number>();
        for (const [k, n] of live.plays) {
            const id = (k.startsWith("url:") ? urlToSound.get(k.slice(4))?.id : undefined) ?? k;
            moved.set(id, (moved.get(id) ?? 0) + n);
        }
        live.plays = moved;
        render();
    }, 400);
}

function liveLabel(soundId: string, url: string): { name: string; sound: SoundView | null } {
    const s = soundById(soundId);
    return s ? { name: labelOf(s), sound: s } : { name: fileName(url), sound: null };
}

function renderLiveHead(): void {
    $("#liveDot").classList.toggle("on", live.connected);
    $("#liveDot").title = live.connected ? "Escuchando el juego" : "El juego aún no está conectado";
    $("#livePause").textContent = live.paused ? "Reanudar" : "Pausar";
    // Sonando ahora, agrupado por sonido
    const now = new Map<string, ActiveSound & { n: number }>();
    for (const a of live.active.values()) {
        const cur = now.get(a.soundId) ?? { ...a, n: 0 };
        cur.n++;
        cur.loop ||= a.loop;
        now.set(a.soundId, cur);
    }
    $("#nowPlaying").innerHTML = [...now.values()]
        .map((a) => {
            const { name } = liveLabel(a.soundId, a.url);
            return `<span class="np-chip${a.loop ? " loop" : ""}" data-locate="${esc(a.soundId)}" title="Sonando ahora">${esc(name)}${a.n > 1 ? ` ×${a.n}` : ""}</span>`;
        })
        .join("");
}

function renderLiveList(): void {
    const list = $("#liveList");
    if (!live.entries.length) {
        list.innerHTML = `<li class="live-empty">${state?.game ? "Juega y aquí aparecerá cada sonido en el momento en que suena." : "Elige un juego."}</li>`;
        return;
    }
    list.innerHTML = live.entries
        .slice(0, 200)
        .map((e) => {
            const { name, sound } = liveLabel(e.soundId, e.url);
            const aliases = soundAliases(sound);
            const extra = aliases.slice(1);
            const moments = aliases.flatMap((a) => aliasToMoments.get(a) ?? []).map((m) => m.label);
            const where = moments.length ? moments.slice(0, 2).join(" · ") + (moments.length > 2 ? ` +${moments.length - 2}` : "") : sound ? sound.rel : e.url;
            const t = e.time.toLocaleTimeString([], { hour12: false }) + "." + String(e.time.getMilliseconds()).padStart(3, "0").slice(0, 1);
            return `<li data-locate="${esc(e.soundId)}" data-inst="${e.id}" class="${live.active.has(e.id) ? "active" : ""}" title="${esc(e.url)}">
                <span class="t">${t}</span>
                <span class="what"><b>${esc(name)}</b>${extra.length ? ` <span class="where">+ ${esc(extra.join(", "))}</span>` : ""}
                    ${e.loop ? '<span class="badge">bucle</span>' : ""}${!sound ? '<span class="badge missing">desconocido</span>' : ""}
                    <span class="where"> — ${esc(where)}</span></span>
                <span class="d">${fmtDur(e.duration)}</span>
            </li>`;
        })
        .join("");
}

/** Marca en las listas lo que está sonando sin re-renderizarlas. */
function refreshLiveClasses(): void {
    const activeIds = new Set([...live.active.values()].map((a) => a.soundId));
    for (const row of document.querySelectorAll<HTMLElement>("#list .row[data-id]")) {
        const id = row.dataset.id ?? "";
        row.classList.toggle("live", activeIds.has(id));
        const n = live.plays.get(id);
        const c = row.querySelector(".plays");
        if (c) c.textContent = n ? `▶ ${n}` : "";
    }
    const activeAliases = new Set<string>();
    for (const id of activeIds) for (const a of soundAliases(soundById(id))) activeAliases.add(a);
    for (const m of document.querySelectorAll<HTMLElement>("#momentsList .moment[data-alias]")) {
        m.classList.toggle("live", activeAliases.has(m.dataset.alias ?? ""));
    }
    $("#countPlayed").textContent = live.plays.size ? String(live.plays.size) : "";
}

function locate(soundId: string): void {
    if (tab !== "sounds") setTab("sounds");
    const find = () => document.querySelector<HTMLElement>(`#list .row[data-id="${CSS.escape(soundId)}"]`);
    let row = find();
    if (!row) {
        filter = "all";
        query = "";
        $input("#search").value = "";
        for (const x of document.querySelectorAll<HTMLElement>("#filters button")) x.classList.toggle("active", x.dataset.filter === "all");
        renderList();
        row = find();
    }
    if (!row) return toast("Ese archivo no está en la lista de sonidos del juego.");
    const target = row;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1500);
}

// ---------------------------------------------------------------- línea de tiempo y reglas

/** Cada recarga del juego reinicia los ids de sus sonidos: los distinguimos por recarga */
let loadN = 0;
/** Eventos vistos en la partida y sus valores (para sugerirlos al crear reglas) */
const observed = new Map<string, Map<string, number>>();

const timeline = new Timeline($("#timeline"), {
    onEventClick: (ev) => openCueEditor({ on: ev.name, match: suggestedMatch(ev), delayMs: 0 }),
    onSoundClick: (id) => locate(id),
    onCueClick: (id) => {
        const cue = state?.cues.find((c) => c.id === id);
        if (cue) openCueEditor(cue);
    },
    onDropFile: (file, ev, delayMs) => openCueEditor({ on: ev?.name ?? "STATE_CHANGED", match: ev ? suggestedMatch(ev) : "GAMESTATE_SPINNING", delayMs }, file),
});

/** Valor del evento que conviene usar como filtro al crear una regla desde él */
function suggestedMatch(ev: GameEventRecord): string | undefined {
    if (ev.name === "STATE_CHANGED") return ev.detail || undefined;
    const id = /"id":(\d+)/.exec(ev.detail)?.[1];
    if (/BACKGROUND_CHANGE$/.test(ev.name) && id) return `"id":${id}`;
    return ev.detail && !ev.detail.startsWith("{") && !ev.detail.startsWith("[") ? ev.detail : undefined;
}

const soundByAlias = (alias: string) => state?.sounds.find((s) => s.refs.some((r) => r.alias === alias));
function aliasDurationMs(alias: string): number {
    const s = soundByAlias(alias);
    const d = s ? durations.get(`${s.id}|orig|${s.mtime}`) : null;
    return d ? d * 1000 : 400;
}

// Las reglas viajan al juego: el hook las reproduce cuando ocurren los eventos
let cuesRev = 0;
let soundsSig = "";
const gameWindow = () => $<HTMLIFrameElement>("#game").contentWindow;
function postToGame(cmd: HookCommand): void {
    gameWindow()?.postMessage(cmd, "*");
}
function sendCues(): void {
    if (!state?.game) return;
    // Si cambian los archivos, el juego tiene que volver a descargarlos
    const sig = JSON.stringify(state.pendingSummary) + "|" + state.sounds.map((s) => s.mtime).join(",");
    if (sig !== soundsSig) {
        soundsSig = sig;
        cuesRev++;
    }
    postToGame({ __soundtoolCmd: true, type: "cues", cues: state.cues, rev: cuesRev });
}

async function saveCues(cues: SoundCue[]): Promise<void> {
    state = await call<AppState>("cues", { method: "PUT", body: { cues } });
    render();
}

function flashCue(id: string): void {
    const row = document.querySelector<HTMLElement>(`#cuesList [data-cue-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.add("fired");
    setTimeout(() => row.classList.remove("fired"), 900);
}

function renderCues(): void {
    const box = $("#cuesList");
    if (!state?.game) {
        box.innerHTML = `<li class="empty">Elige un juego.</li>`;
        return;
    }
    const q = query.split(/\s+/).filter(Boolean);
    const shown = state.cues.filter((c) => {
        if (!q.length) return true;
        const hay = `${c.on} ${describeTrigger(c.on, c.match)} ${c.sound} ${c.label ?? ""}`.toLowerCase();
        return q.every((x) => hay.includes(x));
    });
    if (!shown.length) {
        box.innerHTML = `<li class="empty">${
            state.cues.length
                ? "Ninguna regla coincide."
                : "Todavía no hay reglas.<br>Juega, y en la línea de tiempo haz clic en un evento (o suelta un audio) para que suene un sonido en ese momento."
        }</li>`;
        return;
    }
    box.innerHTML =
        (state.cuesChanged ? `<li class="hint">Reglas con cambios sin guardar.</li>` : "") +
        shown
            .map((c) => {
                const extras = [
                    c.loop ? "en bucle" : "",
                    c.volume < 1 ? `volumen ${Math.round(c.volume * 100)}%` : "",
                    c.stopOn ? `para con «${describeTrigger(c.stopOn.on, c.stopOn.match)}»` : "",
                ].filter(Boolean);
                return `<li class="cue-row${c.enabled ? "" : " disabled"}" data-cue-id="${esc(c.id)}">
                    <input type="checkbox" data-cue-toggle="${esc(c.id)}" ${c.enabled ? "checked" : ""} title="Activa / desactiva" />
                    <div>
                        <div class="when">${esc(describeTrigger(c.on, c.match))}${c.delayMs ? ` <span class="muted">+${c.delayMs} ms</span>` : ""}</div>
                        <div class="what">→ <b>${esc(c.sound)}</b>${extras.length ? " · " + esc(extras.join(" · ")) : ""}</div>
                        ${c.label ? `<div class="what">${esc(c.label)}</div>` : ""}
                    </div>
                    <div class="cue-actions">
                        <button class="play small" data-key="cue|${esc(c.id)}" data-cue-test="${esc(c.id)}" title="Probar en el juego">${ICON_PLAY}</button>
                        <button class="link-btn" data-cue-edit="${esc(c.id)}">Editar</button>
                    </div>
                </li>`;
            })
            .join("");
    syncPlayButtons();
}

// ---- Editor de reglas

let editingCue: Partial<SoundCue> = {};
let cueFile: File | null = null;
let cueFileUrl: string | null = null;

function eventOptions(selected: string, withNone = false): string {
    const seen = [...observed.keys()].filter((n) => !NOISY.has(n));
    const groups = new Map<string, string[]>();
    if (seen.length) groups.set("En esta partida", seen);
    for (const name of KNOWN_EVENTS) {
        if (seen.includes(name)) continue;
        const cat = CATEGORY_LABEL[eventInfo(name).cat as EventCategory];
        groups.set(cat, [...(groups.get(cat) ?? []), name]);
    }
    const all = new Set([...groups.values()].flat());
    if (selected && !all.has(selected)) groups.set("Otro", [selected]);
    const opt = (n: string) => {
        const count = [...(observed.get(n)?.values() ?? [])].reduce((a, b) => a + b, 0);
        return `<option value="${esc(n)}"${n === selected ? " selected" : ""}>${esc(eventInfo(n).label)}${count ? ` (${count})` : ""}</option>`;
    };
    return (
        (withNone ? `<option value="">— No parar —</option>` : "") +
        [...groups].map(([g, names]) => `<optgroup label="${esc(g)}">${names.map(opt).join("")}</optgroup>`).join("")
    );
}

/** Valores sugeridos para filtrar un evento */
function matchOptions(name: string): string {
    const values = new Map<string, string>();
    if (name === "STATE_CHANGED") for (const [k, v] of Object.entries(STATE_LABEL)) values.set(k, v);
    if (/BACKGROUND_CHANGE$/.test(name)) for (const [k, v] of Object.entries(PHASES)) values.set(`"id":${k}`, v.label);
    for (const detail of observed.get(name)?.keys() ?? []) {
        const m = suggestedMatch({ name, detail, t: 0 }) ?? (detail.length <= 60 ? detail : "");
        if (m && !values.has(m)) values.set(m, detailLabel(name, detail));
    }
    return [...values].map(([v, l]) => `<option value="${esc(v)}" label="${esc(l)}"></option>`).join("");
}

function openCueEditor(cue: Partial<SoundCue>, file?: File): void {
    const st = current();
    if (!st.game) return;
    editingCue = cue;
    cueFile = file ?? null;
    if (cueFileUrl) URL.revokeObjectURL(cueFileUrl);
    cueFileUrl = file ? URL.createObjectURL(file) : null;
    const isEdit = !!cue.id && st.cues.some((c) => c.id === cue.id);
    $("#cueTitle").textContent = isEdit ? "Editar regla" : "Nueva regla";
    $button("#cueDelete").hidden = !isEdit;
    const on = cue.on ?? "STATE_CHANGED";
    $select("#cueOn").innerHTML = eventOptions(on);
    $input("#cueMatch").value = cue.match ?? "";
    $("#cueMatchList").innerHTML = matchOptions(on);
    $input("#cueDelay").value = String(cue.delayMs ?? 0);
    const vol = Math.round((cue.volume ?? 1) * 100);
    $input("#cueVolume").value = String(vol);
    $("#cueVolumeVal").textContent = `${vol}%`;
    const sound = file ? "__file__" : (cue.sound ?? "");
    $select("#cueSound").innerHTML =
        `<option value="" disabled${sound ? "" : " selected"}>Elige un sonido…</option>` +
        st.aliases.map((a) => `<option value="${esc(a)}"${a === sound ? " selected" : ""}>${esc(a)}</option>`).join("") +
        `<option value="__file__"${sound === "__file__" ? " selected" : ""}>＋ Archivo nuevo…</option>`;
    showCueFile();
    $input("#cueLoop").checked = !!cue.loop;
    $select("#cueStopOn").innerHTML = eventOptions(cue.stopOn?.on ?? "", true);
    $input("#cueStopMatch").value = cue.stopOn?.match ?? "";
    $("#cueStopMatchList").innerHTML = cue.stopOn?.on ? matchOptions(cue.stopOn.on) : "";
    $input("#cueLabel").value = cue.label ?? "";
    $("#cueModal").hidden = false;
}

function showCueFile(): void {
    const isFile = $select("#cueSound").value === "__file__";
    $("#cueNewFile").hidden = !isFile || !cueFile;
    if (isFile && cueFile) {
        $("#cueFileName").textContent = `${cueFile.name} · ${kb(cueFile.size)}`;
        if (!$input("#cueAlias").value) {
            const base = cueFile.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "snd_regla";
            let alias = base;
            for (let i = 2; current().aliases.includes(alias); i++) alias = `${base}_${i}`;
            $input("#cueAlias").value = alias;
        }
    } else $input("#cueAlias").value = "";
}

/** Regla tal como está en el formulario (sin guardar) */
function cueFromForm(sound: string): SoundCue {
    const stopOn = $select("#cueStopOn").value;
    const match = $input("#cueMatch").value.trim();
    const stopMatch = $input("#cueStopMatch").value.trim();
    const label = $input("#cueLabel").value.trim();
    return {
        id: editingCue.id ?? crypto.randomUUID(),
        on: $select("#cueOn").value,
        ...(match ? { match } : {}),
        delayMs: Math.max(0, Math.round(Number($input("#cueDelay").value) || 0)),
        sound,
        volume: Number($input("#cueVolume").value) / 100,
        loop: $input("#cueLoop").checked,
        stopOn: stopOn ? { on: stopOn, ...(stopMatch ? { match: stopMatch } : {}) } : null,
        ...(label ? { label } : {}),
        enabled: editingCue.enabled ?? true,
    };
}

$select("#cueOn").onchange = () => {
    $("#cueMatchList").innerHTML = matchOptions($select("#cueOn").value);
    $input("#cueMatch").value = "";
};
$select("#cueStopOn").onchange = () => {
    const on = $select("#cueStopOn").value;
    $("#cueStopMatchList").innerHTML = on ? matchOptions(on) : "";
    $input("#cueStopMatch").value = "";
};
$input("#cueVolume").oninput = () => ($("#cueVolumeVal").textContent = `${$input("#cueVolume").value}%`);
$select("#cueSound").onchange = () => {
    if ($select("#cueSound").value === "__file__" && !cueFile) {
        const input = $input("#cueFileInput");
        input.value = "";
        input.click();
        return;
    }
    showCueFile();
};
$input("#cueFileInput").onchange = () => {
    const f = $input("#cueFileInput").files?.[0];
    if (!f) return void ($select("#cueSound").value = editingCue.sound ?? "");
    cueFile = f;
    if (cueFileUrl) URL.revokeObjectURL(cueFileUrl);
    cueFileUrl = URL.createObjectURL(f);
    $input("#cueAlias").value = "";
    showCueFile();
};

$("#cueTest").onclick = () => {
    const sound = $select("#cueSound").value;
    if (sound === "__file__") {
        if (cueFileUrl) togglePlay("cue-file", cueFileUrl);
        return;
    }
    if (!sound) return toast("Elige un sonido.", "err");
    // Con el juego abierto, suena dentro del juego (con su volumen y bucle); si no, aquí
    if (live.connected) postToGame({ __soundtoolCmd: true, type: "test-cue", cue: cueFromForm(sound), rev: cuesRev });
    else togglePlay(`cue-test|${sound}`, aliasUrl(sound));
};

$<HTMLFormElement>("#cueForm").onsubmit = (e) => {
    e.preventDefault();
    void guard(async () => {
        const st = current();
        let sound = $select("#cueSound").value;
        if (!sound) throw new Error("Elige qué sonido suena.");
        if (sound === "__file__") {
            if (!cueFile) throw new Error("Elige el archivo de audio.");
            const alias = $input("#cueAlias").value.trim();
            const file = await maybeMp3(cueFile, ".mp3", gameBitrate());
            state = await call<AppState>(`new-sound?alias=${encodeURIComponent(alias)}&name=${encodeURIComponent(file.name)}`, {
                method: "PUT",
                raw: await file.arrayBuffer(),
            });
            sound = alias;
        }
        const cue = cueFromForm(sound);
        const exists = st.cues.some((c) => c.id === cue.id);
        await saveCues(exists ? current().cues.map((c) => (c.id === cue.id ? cue : c)) : [...current().cues, cue]);
        $("#cueModal").hidden = true;
        stopPlayer();
        toast(`Regla guardada: ${describeTrigger(cue.on, cue.match)} → ${cue.sound}. Ya suena en el juego (sin recargar).`, "ok");
    });
};

$("#cueDelete").onclick = () => {
    const id = editingCue.id;
    if (!id || !confirm("¿Eliminar esta regla?")) return;
    void guard(async () => {
        await saveCues(current().cues.filter((c) => c.id !== id));
        $("#cueModal").hidden = true;
    });
};

$("#newCueBtn").onclick = () => openCueEditor({ on: "STATE_CHANGED", match: "GAMESTATE_SPINNING", delayMs: 0 });

$("#cuesList").addEventListener("click", (e) => {
    const test = closest(e.target, "[data-cue-test]");
    const cue = state?.cues.find((c) => c.id === (test?.dataset.cueTest ?? closest(e.target, "[data-cue-edit]")?.dataset.cueEdit));
    if (!cue) return;
    if (test) {
        if (live.connected) postToGame({ __soundtoolCmd: true, type: "test-cue", cue, rev: cuesRev });
        else togglePlay(`cue|${cue.id}`, aliasUrl(cue.sound));
        return;
    }
    openCueEditor(cue);
});
$("#cuesList").addEventListener("change", (e) => {
    const box = closest<HTMLInputElement>(e.target, "[data-cue-toggle]");
    if (!box) return;
    const id = box.dataset.cueToggle;
    void guard(() => saveCues(current().cues.map((c) => (c.id === id ? { ...c, enabled: box.checked } : c))));
});

// ---- Vista del panel en vivo: línea de tiempo o lista
type LiveView = "timeline" | "list";
function setLiveView(v: LiveView): void {
    for (const b of document.querySelectorAll<HTMLElement>("#liveView [data-view]")) b.classList.toggle("active", b.dataset.view === v);
    $("#timeline").hidden = v !== "timeline";
    $("#timelineTools").hidden = v !== "timeline";
    $("#liveList").hidden = v !== "list";
    try {
        localStorage.setItem("soundtool.liveView", v);
    } catch {
        // sin localStorage
    }
    if (v === "timeline") timeline.render();
}
$("#liveView").onclick = (e) => {
    const b = closest(e.target, "[data-view]");
    if (b) setLiveView(b.dataset.view as LiveView);
};
try {
    setLiveView((localStorage.getItem("soundtool.liveView") as LiveView | null) ?? "timeline");
} catch {
    setLiveView("timeline");
}
const zoom = (f: number) => {
    timeline.pxPerSec = Math.min(800, Math.max(15, timeline.pxPerSec * f));
    timeline.render();
};
$("#zoomIn").onclick = () => zoom(1.5);
$("#zoomOut").onclick = () => zoom(1 / 1.5);
$input("#showAllEvents").onchange = () => {
    timeline.showAll = $input("#showAllEvents").checked;
    timeline.render();
};

// ---------------------------------------------------------------- render

const count = (n: number) => (n ? String(n) : "");

function render(): void {
    indexState();
    const g = state?.game ?? null;
    $("#gameName").textContent = g ? `Juego ${g.number ?? g.name}` : "Elegir juego";
    document.title = g ? `SoundTool — ${g.name}` : "SoundTool";

    const n = state?.pendingCount ?? 0;
    const remote = g?.remote ?? null;
    const save = $button("#saveBtn");
    const exp = $button("#exportBtn");
    save.disabled = !n;
    save.textContent = n ? `Guardar cambios (${n})` : "Guardar cambios";
    save.hidden = !!remote;
    $button("#historyBtn").hidden = !!remote;
    $button("#historyBtn").disabled = !g;
    exp.disabled = !n;
    exp.classList.toggle("primary", !!remote);
    exp.textContent = remote && n ? `Exportar .zip (${n})` : "Exportar .zip";
    $button("#discardBtn").disabled = !n;
    $("#gameName").title = remote ? `${remote.name} · v${remote.version} · ${remote.casino}` : (g?.dir ?? "");
    syncRemotePolling();
    $button("#newSoundBtn").disabled = !g?.manifest;

    $("#tabSoundsCount").textContent = count(state?.sounds.length ?? 0);
    $("#tabMomentsCount").textContent = count(state?.moments.length ?? 0);
    $("#tabCuesCount").textContent = count(state?.cues.length ?? 0);

    renderPreview();
    renderList();
    renderMoments();
    renderCues();
    sendCues();
    renderLiveHead();
    renderLiveList();
    refreshLiveClasses();

    const w = state?.warnings ?? [];
    $("#warnings").hidden = !w.length;
    $("#warnings").innerHTML = w.map((x) => `<div>⚠ ${esc(x)}</div>`).join("");
}

function renderPreview(): void {
    $("#previewBox").hidden = !state?.game;
    const p = state?.preview;
    if (!p) return;
    const chip = $("#previewStatus");
    const labels: Record<typeof p.mode, string> = {
        dist: "Build",
        vite: "Código",
        none: "Sin vista previa",
        remote: `Portal · v${state?.game?.remote?.version ?? ""}`,
    };
    const tone: Record<typeof p.status, string> = { ready: p.mode === "none" ? "warn" : "ok", starting: "warn", error: "err" };
    chip.className = "chip " + tone[p.status];
    chip.textContent = p.status === "starting" ? "Arrancando…" : p.status === "error" ? "Error al arrancar" : labels[p.mode];
    chip.title = p.error ?? "";
    const sel = $select("#previewMode");
    sel.hidden = p.available.length < 2;
    sel.value = p.mode;
    $("#reloadBtn").classList.toggle("attention", previewStale);
}

function soundMatches(s: SoundView): boolean {
    if (filter === "game" && s.scope !== "game") return false;
    if (filter === "common" && s.scope !== "common") return false;
    if (filter === "pending" && !s.pending) return false;
    if (filter === "played" && !live.plays.has(s.id)) return false;
    if (!query) return true;
    const hay = (s.rel + " " + s.refs.map((r) => r.alias + " " + r.key + " " + r.json).join(" ")).toLowerCase();
    return query.split(/\s+/).every((q) => hay.includes(q));
}

function soundRow(s: SoundView): string {
    const aliases = soundAliases(s);
    const title = aliases[0] ?? fileName(s.rel);
    const origKey = `${s.id}|orig|${s.mtime}`;
    const tooltip = s.unreferenced
        ? "Ningún JSON nombra este archivo: lo usa el código directamente (p. ej. los rollup)."
        : s.refs.map((r) => `${r.json} → ${r.key}`).join("\n");
    const usedIn = aliases.flatMap((a) => aliasToMoments.get(a) ?? []);
    const p = s.pending;
    const extNote =
        p && !s.isNew && p.ext !== s.ext
            ? `<div class="note">Se guardará como ${p.ext.slice(1).toUpperCase()} (el original es ${s.ext.slice(1).toUpperCase()}) y se actualizará la referencia en el JSON.${p.ext === ".wav" ? " Un WAV pesa bastante más que un MP3." : ""}</div>`
            : "";
    const pend =
        p && !s.isNew
            ? `<div class="pending-box">
                 <button class="play small" data-key="${esc(s.id)}|new|${p.size}" data-play="pending" data-id="${esc(s.id)}" title="Escuchar el nuevo">${ICON_PLAY}</button>
                 <span class="name" title="${esc(p.name)}">Nuevo: ${esc(p.name)}</span>
                 <span class="muted">${kb(p.size)}</span>
                 <button class="link-btn danger" data-unstage="${esc(s.id)}" title="Descartar este cambio">✕</button>
               </div>${extNote}`
            : "";
    const playBtn = s.missing
        ? `<span></span>`
        : s.isNew
          ? `<button class="play" data-key="${esc(s.id)}|new" data-play="pending" data-id="${esc(s.id)}" title="Escuchar">${ICON_PLAY}</button>`
          : `<button class="play" data-key="${esc(origKey)}" data-play="original" data-id="${esc(s.id)}" title="Escuchar el original">${ICON_PLAY}</button>`;
    const momentsBadge = usedIn.length
        ? `<span class="badge" title="${esc(usedIn.map((m) => m.json + " › " + m.label).join("\n"))}">${usedIn.length} momento${usedIn.length > 1 ? "s" : ""}</span>`
        : "";
    return `<li class="row${p ? " has-pending" : ""}${s.missing ? " missing" : ""}" data-id="${esc(s.id)}" title="${esc(tooltip)}">
        ${playBtn}
        <div class="info">
            <div class="title">${esc(title)}
                ${aliases.length > 1 ? `<span class="alias-extra">+ ${esc(aliases.slice(1).join(", "))}</span>` : ""}
                ${s.isNew ? `<span class="badge new">nuevo · sin guardar</span>` : ""}
                ${s.scope === "common" ? `<span class="badge common" title="Lo usan otros juegos que comparten common/">compartido</span>` : ""}
                ${s.unreferenced ? `<span class="badge unref" title="${esc(tooltip)}">fuera de los JSON</span>` : ""}
                ${s.missing ? `<span class="badge missing">falta el archivo</span>` : ""}
                ${momentsBadge}
                <span class="plays"></span>
            </div>
            <div class="meta"><span class="p">${esc(s.rel)}</span><span>${s.missing ? "—" : kb(s.size)}</span><span data-dur="${esc(origKey)}">${s.isNew ? "" : fmtDur(durations.get(origKey))}</span></div>
        </div>
        <div class="actions">
            ${s.isNew ? `<button class="link-btn danger" data-unstage="${esc(s.id)}">Quitar</button>` : `<button class="link-btn" data-replace="${esc(s.id)}">Reemplazar…</button>`}
        </div>
        ${pend}
    </li>`;
}

function renderList(): void {
    const list = $("#list");
    const sounds = state?.sounds ?? [];
    $("#countAll").textContent = count(sounds.length);
    $("#countGame").textContent = count(sounds.filter((s) => s.scope === "game").length);
    $("#countCommon").textContent = count(sounds.filter((s) => s.scope === "common").length);
    $("#countPending").textContent = count(sounds.filter((s) => s.pending).length);

    if (!state?.game) {
        list.innerHTML = `<li class="empty">Elige un juego para ver sus sonidos.</li>`;
        return;
    }
    let shown = sounds.filter(soundMatches);
    if (filter === "played") shown = shown.sort((a, b) => (live.plays.get(b.id) ?? 0) - (live.plays.get(a.id) ?? 0));
    if (!shown.length) {
        const msg =
            filter === "played"
                ? "Todavía no ha sonado nada. Juega una tirada y vuelve aquí."
                : sounds.length
                  ? "Ningún sonido coincide."
                  : "Este juego no tiene sonidos en sus JSON.";
        list.innerHTML = `<li class="empty">${msg}</li>`;
        return;
    }
    list.innerHTML = shown.map(soundRow).join("");
    for (const s of shown) if (!s.missing && !s.isNew) wantDuration(`${s.id}|orig|${s.mtime}`, fileUrl(s.id));
    syncPlayButtons();
    refreshLiveClasses();
}

function momentRow(m: MomentView, options: string[]): string {
    const value = String(m.pendingValue ?? m.value);
    const changed = m.pendingValue !== undefined;
    const anyChange = changed || m.fields.some((f) => f.pendingValue !== undefined);
    const opts = options.map((a) => `<option value="${esc(a)}"${a === value ? " selected" : ""}>${esc(a)}</option>`).join("");
    const fields = m.fields
        .map((f) => {
            const v = f.pendingValue ?? f.value;
            const cls = f.pendingValue !== undefined ? "changed" : "";
            const attrs = `data-field="${esc(JSON.stringify(f.path))}" data-json="${esc(m.json)}" class="${cls}"`;
            return typeof f.value === "boolean"
                ? `<label class="num-field">${esc(f.key)} <input type="checkbox" ${attrs} ${v ? "checked" : ""}></label>`
                : `<label class="num-field">${esc(f.key)} <input type="number" step="any" value="${esc(v)}" ${attrs}></label>`;
        })
        .join("");
    return `<div class="moment${anyChange ? " has-pending" : ""}" data-alias="${esc(value)}" data-mid="${esc(m.id)}">
        <button class="play small" data-key="m|${esc(m.id)}|${esc(value)}" data-play-alias="${esc(value)}" title="Escuchar ${esc(value)}">${ICON_PLAY}</button>
        <div class="m-label">${esc(m.label)}</div>
        <div class="m-controls">
            <select data-moment="${esc(JSON.stringify(m.path))}" data-json="${esc(m.json)}" class="${changed ? "changed" : ""}" title="Sonido que suena en este momento">
                ${opts}
                <option value="__new__">＋ Nuevo sonido…</option>
            </select>
            ${changed ? `<span class="was">antes: ${esc(m.value)}</span>` : ""}
            ${anyChange ? `<button class="link-btn" data-reset="${esc(m.id)}" title="Volver a como estaba">↺</button>` : ""}
            ${fields}
        </div>
    </div>`;
}

function renderMoments(): void {
    const box = $("#momentsList");
    if (!state?.game) {
        box.innerHTML = `<div class="empty">Elige un juego.</div>`;
        return;
    }
    const moments = state.moments;
    const q = query.split(/\s+/).filter(Boolean);
    const shown = moments.filter((m) => {
        if (!q.length) return true;
        const hay = `${m.json} ${m.label} ${m.value} ${m.pendingValue ?? ""}`.toLowerCase();
        return q.every((x) => hay.includes(x));
    });
    if (!shown.length) {
        box.innerHTML = `<div class="empty">${
            moments.length
                ? "Ningún momento coincide."
                : "Este juego no define sus sonidos en JSON de configuración: los elige el código.<br>Usa el panel «En vivo» para saber qué suena y reemplázalo desde «Sonidos»."
        }</div>`;
        return;
    }
    let html = "";
    let currentJson: string | null = null;
    for (const m of shown) {
        if (m.json !== currentJson) {
            currentJson = m.json;
            html += `<div class="group-title">${esc(shortJson(m.json))}</div>`;
        }
        html += momentRow(m, state.aliases);
    }
    box.innerHTML = html;
    syncPlayButtons();
    refreshLiveClasses();
}

function setTab(t: Tab): void {
    tab = t;
    for (const b of document.querySelectorAll<HTMLElement>(".tabs button[data-tab]")) b.classList.toggle("active", b.dataset.tab === t);
    $("#list").hidden = t !== "sounds";
    $("#soundsHead").hidden = t !== "sounds";
    $("#momentsList").hidden = t !== "moments";
    $("#momentsHead").hidden = t !== "moments";
    $("#cuesList").hidden = t !== "cues";
    $("#cuesHead").hidden = t !== "cues";
    $input("#search").placeholder =
        t === "sounds" ? "Buscar sonido, alias o archivo…" : t === "moments" ? "Buscar momento, archivo o sonido…" : "Buscar regla, evento o sonido…";
}

/** Vuelve a dibujar la pestaña visible */
function renderTab(): void {
    if (tab === "sounds") renderList();
    else if (tab === "moments") renderMoments();
    else renderCues();
}

// ---------------------------------------------------------------- acciones

async function refresh(): Promise<void> {
    state = await call<AppState>("state");
    render();
    if (state.preview.status === "starting") setTimeout(pollPreview, 1000);
}

async function pollPreview(): Promise<void> {
    const before = state?.preview.status;
    await refresh().catch(() => {});
    if (before === "starting" && state?.preview.status !== "starting") reloadGame();
}

function reloadGame(): void {
    previewStale = false;
    live.connected = false;
    live.active.clear();
    $<HTMLIFrameElement>("#game").src = "/?t=" + Date.now();
    renderPreview();
    renderLiveHead();
    refreshLiveClasses();
}

function markStale(msg?: string): void {
    previewStale = true;
    renderPreview();
    if (msg) toast(msg);
}

// ---- Conversión a MP3
const MP3_KEY = "soundtool.toMp3";
try {
    $input("#toMp3").checked = localStorage.getItem(MP3_KEY) !== "0";
} catch {
    // sin localStorage: queda activado por defecto
}
$input("#toMp3").onchange = () => {
    try {
        localStorage.setItem(MP3_KEY, $input("#toMp3").checked ? "1" : "0");
    } catch {
        // sin localStorage: la preferencia no se recuerda
    }
};

/** Bitrate más habitual de los MP3 del juego (para sonidos nuevos) */
function gameBitrate(): number {
    const counts = new Map<number, number>();
    for (const s of state?.sounds ?? []) if (s.scope === "game" && s.audio?.bitrate) counts.set(s.audio.bitrate, (counts.get(s.audio.bitrate) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 128;
}

/** Si toca, convierte el archivo a MP3 antes de subirlo. */
async function maybeMp3(file: File, targetExt: string, bitrate: number): Promise<File> {
    if (!$input("#toMp3").checked || isMp3(file) || targetExt !== ".mp3") return file;
    toast(`Convirtiendo ${file.name} a MP3…`);
    const mp3 = await toMp3(file, { bitrate });
    toast(`${file.name} → MP3 ${mp3.converted.kbps} kbps (${kb(file.size)} → ${kb(mp3.size)})`, "ok");
    return mp3;
}

async function stageFile(id: string, file: File): Promise<void> {
    const s = soundById(id);
    if (!s) return toast("Ese sonido ya no está en la lista.", "err");
    if (s.isNew) return toast("Es un sonido nuevo: quítalo y vuelve a añadirlo con el archivo correcto.");
    if (s.scope === "common" && !confirm(`"${labelOf(s)}" está en common/ y lo pueden usar otros juegos.\n¿Reemplazarlo igualmente?`)) return;
    await guard(async () => {
        const upload = await maybeMp3(file, s.ext, s.audio?.bitrate ?? gameBitrate());
        state = await call<AppState>(`pending?id=${encodeURIComponent(id)}&name=${encodeURIComponent(upload.name)}`, {
            method: "PUT",
            raw: await upload.arrayBuffer(),
        });
        render();
        markStale(`Listo: ${upload.name}. Recarga el juego para oírlo en contexto.`);
    });
}

async function setValue(json: string, path: JsonPath, value: JsonPrimitive): Promise<void> {
    await guard(async () => {
        state = await call<AppState>("value", { method: "POST", body: { json, path, value } });
        render();
        markStale();
    });
    renderMoments(); // si falló, devuelve el control a su valor
}

async function openGame(dir: string): Promise<void> {
    await guard(async () => {
        stopPlayer();
        if (state?.pendingCount && !confirm("Hay cambios sin guardar. ¿Abrir otro juego y perderlos?")) return;
        state = await call<AppState>("open", { method: "POST", body: { dir } });
        resetLive();
        $("#picker").hidden = true;
        render();
        reloadGame();
        if (state.preview.status === "starting") setTimeout(pollPreview, 1000);
    });
}

// ---- Selector de juegos: portal / carpeta local

let pickerTab: PickerTab | null = null;
function setPickerTab(t: PickerTab): void {
    pickerTab = t;
    try {
        localStorage.setItem("soundtool.pickerTab", t);
    } catch {
        // sin localStorage: no se recuerda la pestaña
    }
    for (const b of document.querySelectorAll<HTMLElement>("[data-ptab]")) b.classList.toggle("active", b.dataset.ptab === t);
    $("#pickPortal").hidden = t !== "portal";
    $("#pickLocal").hidden = t !== "local";
    if (t === "portal") void loadPortal();
    else void showLocalGames();
}

let portalData: PortalResponse | null = null;
async function loadPortal(): Promise<void> {
    const grid = $("#portalGrid");
    if (!portalData) {
        grid.innerHTML = `<p class="muted">Cargando juegos del portal…</p>`;
        try {
            portalData = await call<PortalResponse>("portal");
        } catch (err) {
            grid.innerHTML = `<p class="muted">No se pudo conectar con el portal: ${esc((err as Error).message)}</p>`;
            return;
        }
    }
    const st = portalData.settings;
    $input("#playerId").value = st.playerId || "";
    $select("#endpoint").innerHTML = portalData.endpoints
        .map((e) => `<option value="${e.index}"${e.index === Number(st.endpointIndex) ? " selected" : ""}>${esc(e.name)}</option>`)
        .join("");
    const ep = portalData.endpoints.find((e) => e.index === Number(st.endpointIndex)) ?? portalData.endpoints[0];
    const langNames = new Map(portalData.langs.map((l) => [l.code, l.name]));
    $select("#lang").innerHTML = (ep?.langs ?? ["eng"])
        .map((c) => `<option value="${esc(c)}"${c === st.lang ? " selected" : ""}>${esc(langNames.get(c) ?? c)}</option>`)
        .join("");
    drawPortalGames();
    if (!st.playerId) $input("#playerId").focus();
    else $input("#portalSearch").focus();
}

function drawPortalGames(): void {
    if (!portalData) return;
    const q = $input("#portalSearch").value.trim().toLowerCase();
    const recent = portalData.settings.recent ?? [];
    const isRecent = (id: string) => (recent.includes(id) ? 1 : 0);
    const games = portalData.games
        .filter((g) => g.tech === "pixi")
        .filter((g) => !q || g.id.toLowerCase().includes(q) || g.name.toLowerCase().includes(q))
        .sort((a, b) => isRecent(b.id) - isRecent(a.id) || Number(b.number) - Number(a.number));
    $("#portalGrid").innerHTML = games.length
        ? games
              .map(
                  (g) => `<button class="game-card${state?.game?.remote?.gameId === g.id ? " current" : ""}" data-remote="${esc(g.id)}">
                    <span class="num">${esc(g.number ?? g.id)}</span>
                    <span class="gname">${esc(g.name)}</span>
                    <span class="ver">v${esc(g.version ?? "?")}${recent.includes(g.id) ? " · reciente" : ""}</span>
                </button>`
              )
              .join("")
        : `<p class="muted">Ningún juego Pixi coincide.</p>`;
}

async function saveRemoteSettings(patch: Partial<RemoteSettings>): Promise<void> {
    const r = await call<{ settings: RemoteSettings }>("remote-config", { method: "POST", body: patch });
    if (portalData) portalData.settings = r.settings;
}

$input("#playerId").onchange = () => void guard(() => saveRemoteSettings({ playerId: $input("#playerId").value }));
$select("#endpoint").onchange = () =>
    void guard(async () => {
        await saveRemoteSettings({ endpointIndex: Number($select("#endpoint").value) });
        await loadPortal();
    });
$select("#lang").onchange = () => void guard(() => saveRemoteSettings({ lang: $select("#lang").value }));
$input("#portalSearch").oninput = drawPortalGames;
$input("#portalSearch").onkeydown = (e) => {
    if (e.key === "Enter") document.querySelector<HTMLElement>("#portalGrid [data-remote]")?.click();
};
$("#portalGrid").onclick = (e) => {
    const card = closest(e.target, "[data-remote]");
    if (card?.dataset.remote) void openRemote(card.dataset.remote);
};
for (const b of document.querySelectorAll<HTMLElement>("[data-ptab]")) b.onclick = () => setPickerTab(b.dataset.ptab as PickerTab);

async function openRemote(gameId: string): Promise<void> {
    if (state?.pendingCount && !confirm("Hay cambios sin guardar ni exportar. ¿Abrir otro juego y perderlos?")) return;
    const pid = $input("#playerId").value.trim();
    if (!pid) {
        toast("Escribe tu playerId.", "err");
        return $input("#playerId").focus();
    }
    $("#pickerBusy").hidden = false;
    $("#pickerBusyText").textContent = `Abriendo ${gameId} desde el portal…`;
    await guard(async () => {
        if (pid !== portalData?.settings.playerId) await saveRemoteSettings({ playerId: pid });
        stopPlayer();
        state = await call<AppState>("open-remote", { method: "POST", body: { gameId } });
        if (portalData) portalData.settings.recent = [gameId, ...(portalData.settings.recent ?? []).filter((x) => x !== gameId)];
        resetLive();
        $("#picker").hidden = true;
        render();
        reloadGame();
    });
    $("#pickerBusy").hidden = true;
}

function resetLive(): void {
    live.entries = [];
    live.plays.clear();
    triedDiscover.clear();
    observed.clear();
    timeline.reset();
}

function showPicker(): void {
    $("#picker").hidden = false;
    let t = pickerTab;
    try {
        t ??= localStorage.getItem("soundtool.pickerTab") as PickerTab | null;
    } catch {
        // sin localStorage
    }
    setPickerTab(t ?? (state?.config.gamesDir ? "local" : "portal"));
}

async function showLocalGames(): Promise<void> {
    $("#gamesDir").textContent = state?.config.gamesDir ?? "Sin elegir";
    const games = await call<LocalGame[]>("games").catch((): LocalGame[] => []);
    const grid = $("#gameGrid");
    const draw = () => {
        const q = $input("#gameSearch").value.trim().toLowerCase();
        const items = games.filter((g) => !q || g.name.toLowerCase().includes(q));
        if (!state?.config.gamesDir) {
            grid.innerHTML = `<p class="muted">Elige la carpeta donde están los juegos (por ejemplo, la carpeta <b>pixi</b> con g490, g491…).</p>`;
            return;
        }
        if (!items.length) {
            grid.innerHTML = `<p class="muted">No hay juegos${q ? " con ese número" : " en esa carpeta"}.</p>`;
            return;
        }
        grid.innerHTML = items
            .map(
                (g) => `<button class="game-card${state?.game?.dir === g.dir ? " current" : ""}" data-dir="${esc(g.dir)}">
                    <span class="num">${esc(g.number ?? g.name)}</span>
                    <span class="muted">${esc(g.name)}</span>
                    <span class="tags">${g.hasDist ? '<span class="badge">build</span>' : ""}${g.hasVite ? '<span class="badge">código</span>' : ""}${!g.hasDist && !g.hasVite ? '<span class="badge missing">sin vista previa</span>' : ""}</span>
                </button>`
            )
            .join("");
    };
    $input("#gameSearch").oninput = draw;
    draw();
    $input("#gameSearch").focus();
}

// ---- Portal: el juego descarga JSON al arrancar; cuando llegan nuevos se vuelve a escanear
let remotePoll: ReturnType<typeof setInterval> | null = null;
function syncRemotePolling(): void {
    const want = !!state?.game?.remote;
    if (want && !remotePoll) {
        remotePoll = setInterval(async () => {
            const r = await call<{ dirty: boolean }>("remote-dirty").catch(() => null);
            if (!r?.dirty) return;
            const next = await call<AppState>("rescan", { method: "POST" }).catch(() => null);
            if (next) {
                state = next;
                render();
            }
        }, 3000);
    } else if (!want && remotePoll) {
        clearInterval(remotePoll);
        remotePoll = null;
    }
}

// ---- Exportar
$("#exportBtn").onclick = () =>
    void guard(async () => {
        const res = await fetch(API + "export");
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Error ${res.status}`);
        const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "sonidos.zip";
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        toast(`Exportado ${name}. Los cambios siguen pendientes por si quieres seguir.`, "ok");
    });

// ---- Nuevo sonido

const newSound: { file: File | null; url: string | null } = { file: null, url: null };
let pendingMomentForNew = "";

function pickFile(mode: "replace" | "new", target: string | null = null): void {
    fileMode = mode;
    replaceTarget = target;
    $input("#fileInput").value = "";
    $input("#fileInput").click();
}

function openNewSound(file: File, momentId = ""): void {
    const st = current();
    if (newSound.url) URL.revokeObjectURL(newSound.url);
    newSound.file = file;
    newSound.url = URL.createObjectURL(file);
    $("#nsFile").textContent = `${file.name} · ${kb(file.size)}`;
    const base =
        file.name
            .replace(/\.[^.]+$/, "")
            .replace(/[^A-Za-z0-9_.-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 60) || "snd_nuevo";
    let alias = base;
    for (let i = 2; st.aliases.includes(alias); i++) alias = `${base}_${i}`;
    $input("#nsAlias").value = alias;
    $select("#nsMoment").innerHTML =
        `<option value="">— Solo añadirlo al juego —</option>` +
        st.moments
            .map(
                (m) =>
                    `<option value="${esc(m.id)}"${m.id === momentId ? " selected" : ""}>${esc(shortJson(m.json))} › ${esc(m.label)} (ahora: ${esc(m.pendingValue ?? m.value)})</option>`
            )
            .join("");
    updateNsPath();
    $("#newSound").hidden = false;
    $input("#nsAlias").select();
}
function updateNsPath(): void {
    const file = newSound.file;
    const converts = $input("#toMp3").checked && !!file && !isMp3(file);
    const ext = converts ? ".mp3" : (file?.name.match(/\.[^.]+$/)?.[0] ?? ".mp3").toLowerCase();
    $("#nsPath").textContent = `${state?.game?.manifest?.soundDir ?? "assets/sounds"}/${$input("#nsAlias").value || "…"}${ext}`;
}

$input("#nsAlias").oninput = updateNsPath;
$("#nsChange").onclick = () => pickFile("new");
$("#nsPlay").onclick = () => {
    if (newSound.url) togglePlay("ns", newSound.url);
};
$<HTMLFormElement>("#newSoundForm").onsubmit = (e) => {
    e.preventDefault();
    void guard(async () => {
        if (!newSound.file) return;
        const alias = $input("#nsAlias").value.trim();
        const file = await maybeMp3(newSound.file, ".mp3", gameBitrate());
        state = await call<AppState>(`new-sound?alias=${encodeURIComponent(alias)}&name=${encodeURIComponent(file.name)}`, {
            method: "PUT",
            raw: await file.arrayBuffer(),
        });
        const m = state.moments.find((x) => x.id === $select("#nsMoment").value);
        if (m) state = await call<AppState>("value", { method: "POST", body: { json: m.json, path: m.path, value: alias } });
        $("#newSound").hidden = true;
        stopPlayer();
        render();
        markStale(m ? `"${alias}" sonará en ${m.label}. Recarga el juego para oírlo.` : `"${alias}" añadido. Asígnalo a un momento o pide a un programador que lo use.`);
    });
};

// ---------------------------------------------------------------- eventos

$("#gameBtn").onclick = showPicker;

$("#gamesDirBtn").onclick = () =>
    void guard(async () => {
        const { path } = await call<{ path: string | null }>("pick-folder", { method: "POST", body: { prompt: "Carpeta donde están los juegos" } });
        if (!path) return;
        state = await call<AppState>("config", { method: "POST", body: { gamesDir: path } });
        await showLocalGames();
    });

$("#openOtherBtn").onclick = () =>
    void guard(async () => {
        const { path } = await call<{ path: string | null }>("pick-folder", { method: "POST", body: { prompt: "Carpeta del juego (gNNN o su dist)" } });
        if (path) await openGame(path);
    });

$("#gameGrid").onclick = (e) => {
    const card = closest(e.target, "[data-dir]");
    if (card?.dataset.dir) void openGame(card.dataset.dir);
};

for (const overlay of document.querySelectorAll<HTMLElement>(".overlay")) {
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay || closest(e.target, "[data-close]")) {
            overlay.hidden = true;
            if (overlay.id === "newSound") renderMoments(); // deshace el "＋ Nuevo sonido…" elegido en un select
        }
    });
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        for (const o of document.querySelectorAll<HTMLElement>(".overlay")) o.hidden = true;
        renderMoments();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const save = $button("#saveBtn");
        if (!save.disabled && !save.hidden) save.click();
    }
});

$input("#search").oninput = () => {
    query = $input("#search").value.trim().toLowerCase();
    renderTab();
};
$("#filters").onclick = (e) => {
    const b = closest(e.target, "[data-filter]");
    if (!b) return;
    filter = b.dataset.filter as Filter;
    for (const x of document.querySelectorAll<HTMLElement>("#filters button")) x.classList.toggle("active", x === b);
    renderList();
};
$(".panel > .tabs").onclick = (e) => {
    const b = closest(e.target, "[data-tab]");
    if (!b) return;
    setTab(b.dataset.tab as Tab);
    renderTab();
};

$("#list").addEventListener("click", (e) => {
    const play = closest(e.target, "[data-play]");
    if (play) return togglePlay(play.dataset.key ?? "", fileUrl(play.dataset.id ?? "", play.dataset.play));
    const rep = closest(e.target, "[data-replace]");
    if (rep) return pickFile("replace", rep.dataset.replace ?? null);
    const un = closest(e.target, "[data-unstage]");
    if (un)
        void guard(async () => {
            state = await call<AppState>(`pending?id=${encodeURIComponent(un.dataset.unstage ?? "")}`, { method: "DELETE" });
            render();
            markStale();
        });
});

$("#momentsList").addEventListener("click", (e) => {
    const play = closest(e.target, "[data-play-alias]");
    if (play) return togglePlay(play.dataset.key ?? "", aliasUrl(play.dataset.playAlias ?? ""));
    const reset = closest(e.target, "[data-reset]");
    const m = reset && state?.moments.find((x) => x.id === reset.dataset.reset);
    if (!m) return;
    void guard(async () => {
        for (const p of [m.path, ...m.fields.map((f) => f.path)]) {
            state = await call<AppState>("value", { method: "POST", body: { json: m.json, path: p, reset: true } });
        }
        render();
        markStale();
    });
});
$("#momentsList").addEventListener("change", (e) => {
    const sel = closest<HTMLSelectElement>(e.target, "select[data-moment]");
    if (sel) {
        if (sel.value === "__new__") {
            pendingMomentForNew = closest(sel, ".moment")?.dataset.mid ?? "";
            return pickFile("new");
        }
        return void setValue(sel.dataset.json ?? "", JSON.parse(sel.dataset.moment ?? "[]") as JsonPath, sel.value);
    }
    const field = closest<HTMLInputElement>(e.target, "input[data-field]");
    if (field) void setValue(field.dataset.json ?? "", JSON.parse(field.dataset.field ?? "[]") as JsonPath, field.type === "checkbox" ? field.checked : field.value);
});

$("#newSoundBtn").onclick = () => {
    pendingMomentForNew = "";
    pickFile("new");
};

$input("#fileInput").onchange = () => {
    const f = $input("#fileInput").files?.[0];
    if (!f) return renderMoments();
    if (fileMode === "new") return openNewSound(f, pendingMomentForNew);
    if (replaceTarget) void stageFile(replaceTarget, f);
};
// Si cancelan el selector de archivos tras elegir "＋ Nuevo sonido…" en un momento
$input("#fileInput").addEventListener("cancel", () => {
    if ($("#newSound").hidden) renderMoments();
});

// Panel en vivo
$("#liveToggle").onclick = () => $("#live").classList.toggle("collapsed");
$("#livePause").onclick = () => {
    live.paused = !live.paused;
    renderLiveHead();
};
$("#liveClear").onclick = () => {
    live.entries = [];
    live.plays.clear();
    timeline.reset();
    renderLiveList();
    refreshLiveClasses();
    if (filter === "played") renderList();
};
for (const el of [$("#liveList"), $("#nowPlaying")]) {
    el.addEventListener("click", (e) => {
        const it = closest(e.target, "[data-locate]");
        if (it?.dataset.locate) locate(it.dataset.locate);
    });
}

// Arrastrar y soltar sobre una fila
let dragRow: HTMLElement | null = null;
const setDrag = (row: HTMLElement | null) => {
    if (dragRow === row) return;
    dragRow?.classList.remove("drag");
    dragRow = row;
    row?.classList.add("drag");
};
window.addEventListener("dragover", (e) => {
    e.preventDefault(); // evita que el navegador abra el archivo
    const row = closest(e.target, ".row");
    if (e.dataTransfer) e.dataTransfer.dropEffect = row ? "copy" : "none";
    setDrag(row);
});
window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) setDrag(null);
});
window.addEventListener("drop", (e) => {
    e.preventDefault();
    const row = closest(e.target, ".row");
    setDrag(null);
    const f = e.dataTransfer?.files[0];
    if (row?.dataset.id && f) void stageFile(row.dataset.id, f);
    else if (f) toast("Suelta el archivo encima del sonido que quieres reemplazar.");
});

$("#reloadBtn").onclick = reloadGame;
$select("#previewMode").onchange = () =>
    void guard(async () => {
        state = await call<AppState>("preview", { method: "POST", body: { mode: $select("#previewMode").value } });
        render();
        reloadGame();
        if (state.preview.status === "starting") setTimeout(pollPreview, 1000);
    });

$("#discardBtn").onclick = () => {
    if (!confirm("¿Descartar todos los cambios sin guardar?")) return;
    void guard(async () => {
        state = await call<AppState>("pending", { method: "DELETE" });
        render();
        markStale();
    });
};

$("#saveBtn").onclick = () => {
    const st = current();
    const game = st.game;
    if (!game) return;
    const where = [game.publicDir && "public/", game.distDir && "dist/"].filter(Boolean).join(" y ");
    const items = st.pendingSummary;
    const msg =
        `Se van a guardar ${items.length} cambio(s) en ${game.name} (${where}):\n\n` +
        items.map((i) => `• ${i.text}`).join("\n") +
        `\n\nSe guarda una copia de los originales; puedes deshacerlo desde Historial.`;
    if (!confirm(msg)) return;
    void guard(async () => {
        const r = await call<SaveResponse>("save", { method: "POST" });
        state = r.state;
        render();
        reloadGame();
        toast(`Guardado: ${r.saved?.changes.length ?? 0} cambio(s). Copia de seguridad creada.`, "ok");
    });
};

function describeChange(c: Change): string {
    if (c.type === "new") return `Nuevo sonido ${esc(c.alias)} ← ${esc(c.source)}`;
    if (c.type === "moment") return `${esc(shortJson(c.json))} › ${esc(c.label)}: ${esc(c.from)} → ${esc(c.to)}`;
    if (c.type === "cues") return `Reglas de sonido: ${c.count} (antes ${c.previous})`;
    return `${esc(c.aliases[0] ?? c.from)} ← ${esc(c.source)}`;
}

$("#historyBtn").onclick = () =>
    void guard(async () => {
        const list = await call<BackupManifest[]>("backups");
        $("#historyList").innerHTML = list.length
            ? list
                  .map(
                      (b) => `<li>
                    <span class="when">${esc(new Date(b.createdAt).toLocaleString())}</span>
                    <span class="what">${b.changes.map(describeChange).join("<br>")}</span>
                    <button class="btn" data-restore="${esc(b.id)}">Restaurar</button>
                </li>`
                  )
                  .join("")
            : `<li class="muted">Todavía no hay guardados para este juego.</li>`;
        $("#history").hidden = false;
    });
$("#historyList").onclick = (e) => {
    const b = closest(e.target, "[data-restore]");
    if (!b?.dataset.restore || !confirm("¿Dejar los archivos como estaban antes de ese guardado?")) return;
    const id = b.dataset.restore;
    void guard(async () => {
        const r = await call<RestoreResponse>("restore", { method: "POST", body: { id } });
        state = r.state;
        $("#history").hidden = true;
        render();
        reloadGame();
        toast("Restaurado.", "ok");
    });
};

window.addEventListener("beforeunload", (e) => {
    if (state?.pendingCount) e.preventDefault();
});

// ---------------------------------------------------------------- inicio

await refresh();
// (current() y no state: TypeScript no ve que refresh() asigna state)
if (current().game) reloadGame();
else showPicker();
