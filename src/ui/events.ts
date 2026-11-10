// Nombres legibles de los eventos del engine GDP y de sus valores.
// Los nombres que no están aquí se muestran tal cual y se clasifican por su prefijo.

export type EventCategory = "estado" | "rodillos" | "premio" | "free" | "hold" | "jackpot" | "transicion" | "interfaz" | "otro";

export const CATEGORY_LABEL: Record<EventCategory, string> = {
    estado: "Estado del juego",
    rodillos: "Rodillos",
    premio: "Premios",
    free: "Free games",
    hold: "Hold & Spin",
    jackpot: "Jackpot",
    transicion: "Transiciones",
    interfaz: "Interfaz",
    otro: "Otros",
};

const KNOWN: Record<string, [string, EventCategory]> = {
    STATE_CHANGED: ["Cambio de estado", "estado"],
    CHANGE_STATE: ["Cambio de estado (orden)", "estado"],

    STOP_INDIVIDUAL_REEL: ["Para un rodillo", "rodillos"],
    REELS_STOPPED: ["Paran todos los rodillos", "rodillos"],
    START_BOUNCING: ["Rebote de rodillo (empieza)", "rodillos"],
    END_BOUNCING: ["Rebote de rodillo (termina)", "rodillos"],
    REEL_STOP_IMMEDIATE: ["Parada rápida de rodillos", "rodillos"],
    REEL_STOP_IMMEDIATELY: ["Parada rápida de rodillos", "rodillos"],
    PLAY_SCATTER_WINDUP: ["Anticipación de scatter (empieza)", "rodillos"],
    STOP_SCATTER_WINDUP: ["Anticipación de scatter (termina)", "rodillos"],
    UPDATE_TRIGGERED_REELS: ["Rodillos con símbolo de bonus", "rodillos"],
    REEL_ROWS_CHANGED: ["Cambian las filas de los rodillos", "rodillos"],

    PLAY_ANIMATION_SIMBOLS: ["Animan los símbolos ganadores", "premio"],
    STOP_ANIMATION_SIMBOLS: ["Paran las animaciones de símbolos", "premio"],
    NO_ANIMATION_SIMBOLS: ["Sin animación de símbolos", "premio"],
    PLAY_SHOW_WINNER_LINES: ["Muestra las líneas ganadoras", "premio"],
    SHOW_WIN_LINE: ["Muestra una línea ganadora", "premio"],
    DISPLAY_ALL_WINLINES: ["Muestra todas las líneas", "premio"],
    STOP_SECUENCE_PAYS_LINES: ["Para la secuencia de líneas", "premio"],
    SHOW_WIN_CONTAINER: ["Aparece la caja de premio", "premio"],
    HIDE_WIN_CONTAINER: ["Se oculta la caja de premio", "premio"],
    HIDE_WINBOX: ["Se oculta el premio", "premio"],
    PLAY_ROLLERS: ["Empieza el contador de premio", "premio"],
    STOP_ROLLERS: ["Para el contador de premio", "premio"],
    END_ROLLERS: ["Termina el contador de premio", "premio"],
    PLAY_ROLLERS_TRIGGER_END: ["Contador de premio al final del bonus", "premio"],
    UPDATE_ROLLER_WIN: ["Actualiza el contador de premio", "premio"],
    UPDATE_ROLLERS_WIN: ["Actualiza los contadores de premio", "premio"],
    PLAY_COINS: ["Lluvia de monedas (empieza)", "premio"],
    STOP_COINS: ["Lluvia de monedas (termina)", "premio"],
    TIMESBET_ANIMATION_START: ["Animación de premio grande (empieza)", "premio"],
    TIMESBET_ANIMATION_END: ["Animación de premio grande (termina)", "premio"],
    TIMESBET_ANIMATION_STOP: ["Animación de premio grande (se corta)", "premio"],

    BACKGROUND_CHANGE: ["Cambio de fase", "transicion"],
    INMEDIATE_BACKGROUND_CHANGE: ["Cambio de fase (inmediato)", "transicion"],
    TRANSITION_PLAY: ["Transición", "transicion"],
    FADEIN_BACK_DARK: ["Oscurece el fondo", "transicion"],
    FADEOUT_BACK_DARK: ["Aclara el fondo", "transicion"],

    TRANSITION_TRIGGER_FREEGAMES: ["Entrada a free games", "free"],
    TRANSITION_RETRIGGER_FREEGAMES: ["Retrigger de free games", "free"],
    TRANSITION_END_FREEGAMES: ["Fin de free games", "free"],
    UPDATE_ROLLER_WIN_START_FREEGAME: ["Contador al empezar free games", "free"],
    STOP_SOUND_MAIN_FREEGAMES: ["Para la música de free games", "free"],
    FREE_GAMES_ROWS_APPLY: ["Free games: cambian las filas", "free"],
    FREE_GAMES_ROWS_RESET: ["Free games: filas normales", "free"],
    RECOVERY_FREEGAMES: ["Free games recuperados", "free"],

    HAS_PLAY_INTRO_OBJECT: ["H&S: intro", "hold"],
    HAS_PLAY_TITLE: ["H&S: título", "hold"],
    HAS_PLAY_MUSIC: ["H&S: empieza la música", "hold"],
    HAS_STOP_MUSIC: ["H&S: para la música", "hold"],
    HAS_SHOW_RESPIN_COUNTER: ["H&S: aparece el contador de respins", "hold"],
    HAS_HIDE_RESPIN_COUNTER: ["H&S: se oculta el contador de respins", "hold"],
    HAS_UPDATE_RESPINCOUNTER: ["H&S: cambia el contador de respins", "hold"],
    HAST_UPDATE_RESPINCOUNTER: ["H&S: cambia el contador de respins", "hold"],
    HAS_APPEAR_SPECIAL_SYMBOLS: ["H&S: aparece un símbolo especial", "hold"],
    HAS_SHOW_SPECIAL_SYMBOLS: ["H&S: muestra los símbolos especiales", "hold"],
    HAS_APPEAR_COLOR_SYMBOL: ["H&S: aparece un símbolo de color", "hold"],
    HAS_SHOW_PRIZE_SYMBOL: ["H&S: muestra un premio", "hold"],
    HAS_UPDATE_PRIZE_SYMBOL: ["H&S: actualiza un premio", "hold"],
    HAS_INCREMENT_PRIZE_SYMBOL: ["H&S: sube un premio", "hold"],
    HAS_PLAY_FLYING: ["H&S: vuela un premio", "hold"],
    HAS_FLYING_OBJECT2RESPIN: ["H&S: vuela al contador de respins", "hold"],
    HAS_PLAY_ASCEND2WINNER: ["H&S: sube al ganador", "hold"],
    HAS_PLAYINMEDIATELY_ASCEND2WINNER: ["H&S: sube al ganador (inmediato)", "hold"],
    HAS_UPDATE_WINNER: ["H&S: actualiza el ganador", "hold"],
    HAS_PLAY_REEL_ANIM: ["H&S: animación de rodillo", "hold"],
    HAS_STOP_REEL_ANIM: ["H&S: para la animación de rodillo", "hold"],
    HAS_PLAY_LOOP_SYMBOL: ["H&S: bucle de símbolo", "hold"],
    HAS_PLAY_GLOW_OBJECT: ["H&S: brillo", "hold"],
    HAS_PLAY_BURSTLOOP: ["H&S: explosión en bucle", "hold"],
    HAS_CHANGE_STATE: ["H&S: cambio de estado", "hold"],
    HAS_PROCESS: ["H&S: procesa", "hold"],
    HAS_CONTROL: ["H&S: control", "hold"],

    SHOW_JACKPOTS: ["Aparecen los jackpots", "jackpot"],
    HIDE_JACKPOTS: ["Se ocultan los jackpots", "jackpot"],
    PLAY_WIN_JACKPOT: ["Gana un jackpot", "jackpot"],
    COMPLETE_WIN_JACKPOT: ["Termina el premio de jackpot", "jackpot"],
    SHOW_JACKPOT_WINNERS: ["Muestra ganadores de jackpot", "jackpot"],

    START_AUTOMATIC_PLAY: ["Empieza el auto-spin", "interfaz"],
    STOP_AUTOMATIC_PLAY: ["Para el auto-spin", "interfaz"],
    OPEN_STAKES_SELECTION: ["Abre el selector de apuesta", "interfaz"],
    CLOSE_STAKES_SELECTION: ["Cierra el selector de apuesta", "interfaz"],
    SELECTED_STAKE: ["Cambia la apuesta", "interfaz"],
    PAUSE_GAME: ["Pausa", "interfaz"],
    RESUME_GAME: ["Reanuda", "interfaz"],
    DISPATCH_POPUP: ["Ventana emergente", "interfaz"],
    QUICK_PICK: ["Selección rápida", "interfaz"],
};

/** Eventos que se repiten muchísimo o no interesan para el sonido: ocultos salvo que se pidan */
export const NOISY = new Set([
    "REEL_POSITION_BOUNCING_MOVE",
    "CHECK_STATE_CHANGE",
    "HIDE_PAYLINE_INFO",
    "SHOW_PAYLINE_INFO",
    "PROCESS_ADVERTISEMENT",
    "HDIE_ADVERTISEMENT",
    "EXTERNAL_CALL_UPDATEBALANCE",
    "RESIZE_SCREEN",
    "ORIENTATION_CHANGED",
    "UPDATE_JACKPOTS",
    "UPDATE_JACKPOTS_UX",
    "UPDATE_JACKPOTS_FOR_ID",
    "DIGITS_CHANGED",
    "UPDATE_ROLLER_BALANCE",
    "UPDATE_ROLLERS_BALANCE",
    "UPDATE_PAYS",
    "UPDATE_SHOW_SYMBOLS",
    "HIDE_SYMBOL",
    "SHOW_SYMBOL",
    "HIDE_SYMBOL_REEL_LAYER",
    "CHANGE_SYMBOL_REEL_LAYER",
    "CHANGE_ZORDER_JACKPOTS",
    "RESTORE_ZORDER_JACKPOTS",
    "ENABLE_BUTTONS_TOP_PANEL",
    "DISBALE_BUTTONS_TOP_PANEL",
    "DISABLE_PANEL_BUTTONS",
    "UPDATE_FEATURE_STRIPE_INFO",
    "SHOW_FEATURE_STRIPE_INFO",
    "HIDE_FEATURE_STRIPE_INFO",
    "SHOW_LINES_STRIPE_INFO",
    "HIDE_LINES_STRIPE_INFO",
]);

export const STATE_LABEL: Record<string, string> = {
    GAMESTATE_ENTER: "Entrando",
    GAMESTATE_INIT: "Inicio",
    GAMESTATE_IDLE: "En espera",
    GAMESTATE_INFO: "Ayuda",
    GAMESTATE_POPUP: "Ventana",
    GAMESTATE_RESULT: "Resultado",
    GAMESTATE_SPINNING: "Girando",
    GAMESTATE_SHOWWIN: "Premio",
    GAMESTATE_FEATURE: "Feature",
    GAMESTATE_TRIGGER: "Activa bonus",
    GAMESTATE_WINCELEBRATION: "Celebración",
    GAMESTATE_JACKPOTWIN: "Jackpot",
    GAMESTATE_GAMBLE: "Doble o nada",
    GAMESTATE_HISTORY: "Historial",
    GAMESTATE_BUYFEATURE: "Compra de feature",
};

/** Fase del juego según BACKGROUND_CHANGE {id} (Kte.BG_NORMALGAME / BG_FREEGAME / BG_HOLD) */
export const PHASES: Record<string, { label: string; cls: string }> = {
    "0": { label: "Juego normal", cls: "normal" },
    "1": { label: "Free games", cls: "free" },
    "2": { label: "Hold & Spin", cls: "hold" },
};

export function phaseOf(name: string, detail: string): string | null {
    if (name !== "BACKGROUND_CHANGE" && name !== "INMEDIATE_BACKGROUND_CHANGE") return null;
    const id = /"id":(\d+)/.exec(detail)?.[1] ?? (/^\d+$/.test(detail) ? detail : null);
    return id && PHASES[id] ? id : null;
}

export function eventInfo(name: string): { label: string; cat: EventCategory } {
    const known = KNOWN[name];
    if (known) return { label: known[0], cat: known[1] };
    const cat: EventCategory = name.startsWith("HAS")
        ? "hold"
        : /FREEGAME|FREE_GAMES/.test(name)
          ? "free"
          : /JACKPOT|JPWINNER/.test(name)
            ? "jackpot"
            : /REEL|BOUNCING|WINDUP/.test(name)
              ? "rodillos"
              : /ROLLER|WIN|COINS|PAYS|ANIMATION_SIMBOLS/.test(name)
                ? "premio"
                : /TRANSITION|BACKGROUND/.test(name)
                  ? "transicion"
                  : "otro";
    return { label: name, cat };
}

/** Texto legible para el valor de un evento ("Girando", "Free games", "rodillo 3"…) */
export function detailLabel(name: string, detail: string): string {
    if (!detail) return "";
    if (name === "STATE_CHANGED") return STATE_LABEL[detail] ?? detail;
    const phase = phaseOf(name, detail);
    if (phase) return PHASES[phase]!.label;
    return detail;
}

/** Descripción completa: "Cambio de estado: Girando" */
export function describeTrigger(on: string, match?: string): string {
    const { label } = eventInfo(on);
    if (!match) return label;
    if (on === "STATE_CHANGED") return `${label}: ${STATE_LABEL[match] ?? match}`;
    const phase = phaseOf(on, match.includes("id") ? match : `{"id":${match}}`);
    if (phase) return `${label}: ${PHASES[phase]!.label}`;
    return `${label} (${match})`;
}

/** Todos los eventos conocidos, para elegir uno aunque todavía no haya ocurrido */
export const KNOWN_EVENTS = Object.keys(KNOWN);
