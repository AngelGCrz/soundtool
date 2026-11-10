// Tipos compartidos entre el servidor y la interfaz: el contrato de la API de SoundTool.

/** Ruta dentro de un JSON: ["sounds", "symbols_win", 0, "src"] */
export type JsonPath = (string | number)[];
export type JsonPrimitive = string | number | boolean | null;

/** "game": assets del juego (public/, dist/). "common": carpeta compartida entre juegos. */
export type Scope = "game" | "common";

export interface Mp3Info {
    bitrate: number;
    sampleRate: number;
    channels: 1 | 2;
    vbr: boolean;
}

/** Un lugar de un JSON que apunta a un archivo de audio */
export interface SoundRef {
    json: string;
    path: JsonPath;
    key: string;
    alias: string;
    value: string;
}

/** Un archivo de audio del juego (puede tener varios alias) */
export interface Sound {
    id: string;
    scope: Scope;
    /** Ruta relativa a la raíz de su scope (public/ o common/) */
    rel: string;
    /** URL con la que lo pide el juego */
    url: string;
    ext: string;
    size: number;
    mtime: number;
    missing: boolean;
    /** Existe pero ningún JSON lo nombra (p. ej. rollups construidos por el código) */
    unreferenced?: boolean;
    audio: Mp3Info | null;
    refs: SoundRef[];
}

export interface GameInfo {
    dir: string;
    name: string;
    number: string | null;
    publicDir: string | null;
    distDir: string | null;
    commonDir: string | null;
    viteBin: string | null;
    /** Copias físicas de los assets del juego: se escribe en todas */
    gameRoots: string[];
}

export interface MomentField {
    key: string;
    path: JsonPath;
    value: number | boolean;
}

/** Punto de un JSON de configuración que elige qué sonido suena */
export interface Moment {
    id: string;
    json: string;
    path: JsonPath;
    label: string;
    value: string;
    fields: MomentField[];
}

export interface MomentView extends Omit<Moment, "fields"> {
    pendingValue?: JsonPrimitive;
    fields: (MomentField & { pendingValue?: JsonPrimitive })[];
}

export interface PendingInfo {
    name: string;
    ext: string;
    size: number;
}

export interface SoundView extends Sound {
    pending: PendingInfo | null;
    /** Sonido nuevo todavía sin guardar */
    isNew?: boolean;
}

/** Objeto del manifiesto (gameassets.json) donde se declaran los alias de sonido */
export interface ManifestTarget {
    json: string;
    path: JsonPath;
    soundDir: string;
}

export interface RemoteInfo {
    gameId: string;
    name: string;
    version: string;
    loaderUrl: string;
    casino: string;
}

export type PreviewMode = "dist" | "vite" | "none" | "remote";
export type PreviewStatus = "ready" | "starting" | "error";

export interface PreviewState {
    mode: PreviewMode;
    status: PreviewStatus;
    error?: string;
    available: PreviewMode[];
}

export interface RemoteSettings {
    portal: string;
    playerId: string;
    endpointIndex: number;
    lang: string;
    recent: string[];
}

export interface AppConfig {
    gamesDir: string | null;
    recent: string[];
    remote: RemoteSettings;
}

export interface PendingSummaryItem {
    kind: "replace" | "new" | "moment" | "cues";
    text: string;
}

export interface GameState extends GameInfo {
    backups: number;
    manifest: ManifestTarget | null;
    remote: RemoteInfo | null;
}

// ------------------------------------------------------------------ reglas de sonido (cues)

/** Evento del engine que dispara o para una regla. `match` filtra por su valor (texto contenido). */
export interface CueTrigger {
    on: string;
    match?: string;
}

/**
 * Regla de sonido: cuando el engine lanza el evento `on` (y su valor contiene `match`),
 * espera `delayMs` y reproduce el alias `sound`.
 */
export interface SoundCue extends CueTrigger {
    id: string;
    delayMs: number;
    sound: string;
    /** 0..1 */
    volume: number;
    loop: boolean;
    /** Para los bucles (o sonidos largos): evento que los detiene */
    stopOn?: CueTrigger | null;
    /** Nota del sonidista */
    label?: string;
    enabled: boolean;
}

/** Contenido de assets/json/soundcues.json */
export interface CuesFile {
    version: 1;
    cues: SoundCue[];
}

export interface AppState {
    config: AppConfig;
    dataDir: string;
    game: GameState | null;
    preview: PreviewState;
    warnings: string[];
    sounds: SoundView[];
    moments: MomentView[];
    aliases: string[];
    pendingCount: number;
    pendingSummary: PendingSummaryItem[];
    /** Reglas actuales (con cambios pendientes) */
    cues: SoundCue[];
    /** Las reglas tienen cambios sin guardar */
    cuesChanged: boolean;
}

// ------------------------------------------------------------------ cambios guardados

export interface ReplaceChange {
    type: "replace";
    sound: string;
    scope: Scope;
    aliases: string[];
    from: string;
    to: string;
    source: string;
    written: string[];
    jsonEdits: string[];
}

export interface NewSoundChange {
    type: "new";
    alias: string;
    to: string;
    source: string;
    manifest?: string;
    written: string[];
}

export interface MomentChange {
    type: "moment";
    json: string;
    path: JsonPath;
    label: string;
    from: JsonPrimitive;
    to: JsonPrimitive;
}

export interface CuesChange {
    type: "cues";
    json: string;
    count: number;
    previous: number;
}

export type Change = ReplaceChange | NewSoundChange | MomentChange | CuesChange;

export interface BackupManifest {
    id: string;
    game: string;
    createdAt: string;
    changes: Change[];
    modified: string[];
    created: string[];
}

// ------------------------------------------------------------------ selector de juegos

export interface LocalGame {
    name: string;
    dir: string;
    number: string | null;
    hasDist: boolean;
    hasVite: boolean;
}

export interface PortalEndpoint {
    index: number;
    name: string;
    skin: string;
    uid: number;
    platformId: string;
    langs: string[];
    enabled: boolean;
}

export interface PortalGame {
    id: string;
    number: string | null;
    name: string;
    tech: string;
    version?: string;
}

export interface PortalData {
    loader: string;
    endpoints: PortalEndpoint[];
    langs: { name: string; code: string }[];
    games: PortalGame[];
}

// ------------------------------------------------------------------ respuestas de la API

export interface SaveResponse {
    saved: BackupManifest | null;
    state: AppState;
}
export interface RestoreResponse {
    restored: BackupManifest;
    state: AppState;
}
export type DiscoverResponse = AppState | { unchanged: true };

// ------------------------------------------------------------------ mensajes del juego (hook.ts ⇄ app)

/** Evento del engine capturado en el juego. `t` = hora (ms desde epoch). */
export interface GameEventRecord {
    name: string;
    /** Resumen corto del valor del evento ("GAMESTATE_SPINNING", '{"id":1}'…) */
    detail: string;
    t: number;
}

export type HookMessage =
    | { __soundtool: true; type: "ready"; t: number }
    | { __soundtool: true; type: "play"; id: number; url: string; loop: boolean; duration: number; t: number }
    | { __soundtool: true; type: "end"; id: number; t: number }
    | { __soundtool: true; type: "events"; items: GameEventRecord[] }
    | { __soundtool: true; type: "cue"; cueId: string; sound: string; phase: "start" | "stop"; t: number };

/** Órdenes de la herramienta al juego */
export type HookCommand =
    | { __soundtoolCmd: true; type: "cues"; cues: SoundCue[]; rev: number }
    | { __soundtoolCmd: true; type: "test-cue"; cue: SoundCue; rev: number };
