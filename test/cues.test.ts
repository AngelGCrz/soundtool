// Reglas de sonido: validación, guardado con backup, exportación y relación con los sonidos nuevos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CUES_JSON, normalizeCues } from "../src/server/cues.ts";
import { SoundSession } from "../src/server/session.ts";
import type { CuesFile } from "../src/shared/types.ts";
import { MP3, makeGame, inPublicAndDist, readText, exists, must, readZip } from "./helpers.ts";

const MANIFEST = `{\n  "sounds": {\n    "snd_1": "assets/sounds/snd_0001.mp3",\n    "snd_2": "assets/sounds/snd_0002.mp3"\n  }\n}`;
const CONFIG = `{\n  "sounds": { "freeloop": "snd_1" }\n}`;

function fixture() {
    return makeGame("g996", {
        ...inPublicAndDist({
            "assets/gameassets.json": MANIFEST,
            "assets/json/config.json": CONFIG,
            "assets/sounds/snd_0001.mp3": MP3("one"),
            "assets/sounds/snd_0002.mp3": MP3("two"),
        }),
        "dist/index.html": "<html><head></head></html>",
    });
}

const spinCue = { id: "a", on: "STATE_CHANGED", match: "GAMESTATE_SPINNING", delayMs: 200, sound: "snd_2", volume: 0.8, loop: false, enabled: true };

test("normalizeCues: valida evento, sonido, retraso y volumen, y limpia los campos", () => {
    const exists = (a: string) => a === "snd_2";
    const [cue] = normalizeCues([{ ...spinCue, delayMs: "150.4", label: "  golpe  ", stopOn: { on: "REELS_STOPPED", match: "" } }], exists);
    assert.deepEqual(cue, { ...spinCue, delayMs: 150, stopOn: { on: "REELS_STOPPED" }, label: "golpe" });
    assert.throws(() => normalizeCues([{ ...spinCue, sound: "no_existe" }], exists), /no es un sonido/);
    assert.throws(() => normalizeCues([{ ...spinCue, on: "con espacios" }], exists), /elige un evento/);
    assert.throws(() => normalizeCues([{ ...spinCue, delayMs: -5 }], exists), /retraso/);
    assert.throws(() => normalizeCues([{ ...spinCue, volume: 3 }], exists), /volumen/);
    assert.throws(() => normalizeCues([spinCue, spinCue], exists), /repetido/);
    assert.throws(() => normalizeCues("x", exists), /lista/);
});

test("reglas: pendientes, servidas al juego, guardadas en public y dist, y restaurables", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    assert.deepEqual(s.cues, []);

    s.setCues([spinCue]);
    assert.equal(s.pendingCount, 1);
    assert.match(must(s.pendingSummary()[0]).text, /Reglas de sonido: 1 \(antes 0\)/);
    const served = JSON.parse(must(s.patchedJsonForUrl("/" + CUES_JSON))) as CuesFile;
    assert.deepEqual(served, { version: 1, cues: [{ ...spinCue, stopOn: null }] });
    assert.equal(s.moments.length, 1, "las reglas no aparecen como momentos");

    const m = must(s.save());
    for (const base of ["public", "dist"]) {
        const file = JSON.parse(readText(game, base, CUES_JSON)) as CuesFile;
        assert.equal(file.cues[0]?.sound, "snd_2");
    }
    assert.deepEqual(m.created.sort(), ["dist/" + CUES_JSON, "public/" + CUES_JSON]);
    assert.equal(s.pendingCount, 0);
    assert.equal(s.cues.length, 1, "tras guardar se leen del archivo");
    assert.equal(s.moments.length, 1, "soundcues.json no se escanea como momentos");

    // Volver a poner las mismas reglas no es un cambio
    s.setCues([{ ...spinCue, stopOn: null }]);
    assert.equal(s.pendingCount, 0);

    s.restore(m.id);
    assert.ok(!exists(game, "public", CUES_JSON));
    assert.deepEqual(s.cues, []);
    s.dispose();
});

test("reglas con un sonido nuevo: se exportan juntos; quitar el sonido quita sus reglas", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    s.stageNew("snd_golpe", MP3("GOLPE"), "golpe.wav");
    s.setCues([{ ...spinCue, sound: "snd_golpe" }, { ...spinCue, id: "b" }]);

    const files = readZip(s.exportZip().zip);
    const cues = JSON.parse(must(files.get("public/" + CUES_JSON)).toString()) as CuesFile;
    assert.deepEqual(
        cues.cues.map((c) => c.sound),
        ["snd_golpe", "snd_2"]
    );
    assert.ok(files.has("public/assets/sounds/snd_golpe.mp3"));
    assert.match(must(files.get("CAMBIOS.md")).toString(), /Reglas de sonido.*engine/);

    s.unstageNew("snd_golpe");
    assert.deepEqual(
        s.cues.map((c) => c.id),
        ["b"],
        "la regla del sonido descartado desaparece"
    );
    s.discardAll();
    assert.equal(s.pendingCount, 0);
    s.dispose();
});
