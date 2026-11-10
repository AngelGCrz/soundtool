// Edición de JSON sin reformatear, momentos, sonidos nuevos, audios sin JSON y descubiertos en vivo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, locate } from "../src/server/jsontext.ts";
import { SoundSession } from "../src/server/session.ts";
import { prettyPath } from "../src/server/moments.ts";
import { MP3, WAV, makeGame, inPublicAndDist, read, readText, exists, must } from "./helpers.ts";

const MANIFEST = `{
    "sounds": {
        "snd_1": "assets/sounds/snd_0001.mp3",
        "snd_2": "assets/sounds/snd_0002.mp3"
    }
}`;
const CONFIG = `{
  "game": { "name": "snd_1" },
  "sounds": {
    "freeloop": "snd_1",
    "symbols_win": [ { "id": 0, "order": 0, "timesbet": 5, "src": "snd_2" } ]
  },
  "reels": {"sound_symbol_stop": {"default": {"name":"snd_2"}}}
}`;
const CONFIG_JSON = "assets/json/config.json";

function fixture() {
    return makeGame("g998", {
        ...inPublicAndDist({
            "assets/gameassets.json": MANIFEST,
            [CONFIG_JSON]: CONFIG,
            "assets/sounds/snd_0001.mp3": MP3("one"),
            "assets/sounds/snd_0002.mp3": MP3("two"),
            "assets/sounds/rollup/rollup1.mp3": MP3("roll"),
        }),
        "dist/index.html": "<html><head></head></html>",
    });
}

const parse = (text: string | null) => JSON.parse(must(text, "JSON parcheado")) as Record<string, any>;

test("applyEdits: set y add respetan el formato", () => {
    const { text } = applyEdits(CONFIG, [
        { op: "set", path: ["sounds", "freeloop"], value: "snd_2" },
        { op: "set", path: ["sounds", "symbols_win", 0, "timesbet"], value: 10 },
        { op: "add", path: ["reels", "sound_symbol_stop", "default"], key: "vol", value: 1 },
    ]);
    assert.equal(
        text,
        CONFIG.replace('"freeloop": "snd_1"', '"freeloop": "snd_2"').replace('"timesbet": 5', '"timesbet": 10').replace('{"name":"snd_2"}', '{"name":"snd_2", "vol":1}')
    );
    const added = applyEdits(MANIFEST, [{ op: "add", path: ["sounds"], key: "snd_new", value: "assets/sounds/snd_new.mp3" }]).text;
    assert.ok(added.includes(`"snd_2": "assets/sounds/snd_0002.mp3",\n        "snd_new": "assets/sounds/snd_new.mp3"\n    }`));
    assert.throws(() => locate('{ "a": 1, }'), /JSON inválido/);
});

test("momentos: detecta alias en rutas de sonido e ignora el resto", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    const labels = s.moments.map((m) => m.label);
    assert.deepEqual(labels, ["sounds › freeloop", "sounds › symbols_win[0] › src", "reels › sound_symbol_stop › default › name"]);
    assert.ok(!labels.includes("game › name"), "game.name no es un momento de sonido");
    assert.deepEqual(
        must(s.moments[1]).fields.map((f) => [f.key, f.value]),
        [
            ["id", 0],
            ["order", 0],
            ["timesbet", 5],
        ]
    );
    assert.deepEqual(s.manifest, { json: "assets/gameassets.json", path: ["sounds"], soundDir: "assets/sounds" });
    assert.equal(prettyPath(["a", 0, "b"]), "a[0] › b");
    s.dispose();
});

test("audios sin referencia en JSON: se listan y no permiten cambiar formato", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    const roll = must(s.sounds.get("game:assets/sounds/rollup/rollup1.mp3"));
    assert.ok(roll.unreferenced);
    assert.throws(() => s.stage(roll.id, WAV()), /tiene que seguir siendo MP3/);
    s.stage(roll.id, MP3("roll2"));
    s.dispose();
});

test("momentos + sonido nuevo: se sirven parcheados, se guardan en public y dist, y se restauran", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });

    assert.throws(() => s.setValue(CONFIG_JSON, ["sounds", "freeloop"], "no_existe"), /no es un sonido/);
    assert.throws(() => s.stageNew("snd_1", MP3("x")), /Ya existe/);
    assert.throws(() => s.stageNew("con espacios", MP3("x")), /solo puede tener/);

    s.stageNew("snd_nuevo", MP3("NUEVO"), "mi_sonido.mp3");
    s.setValue(CONFIG_JSON, ["sounds", "freeloop"], "snd_nuevo");
    s.setValue(CONFIG_JSON, ["sounds", "symbols_win", 0, "timesbet"], "8");
    assert.equal(s.pendingCount, 3);

    // Antes de guardar, el juego recibe los JSON con los cambios
    const cfg = parse(s.patchedJsonForUrl("/" + CONFIG_JSON, path.join(game, "dist")));
    assert.equal(cfg.sounds.freeloop, "snd_nuevo");
    assert.equal(cfg.sounds.symbols_win[0].timesbet, 8);
    assert.equal(parse(s.patchedJsonForUrl("/assets/gameassets.json")).sounds.snd_nuevo, "assets/sounds/snd_nuevo.mp3");
    assert.ok(s.overrideForUrl("/assets/sounds/snd_nuevo.mp3"));
    assert.equal(s.patchedJsonForUrl("/assets/json/otro.json"), null);

    // Volver al valor original quita el cambio
    s.setValue(CONFIG_JSON, ["sounds", "symbols_win", 0, "timesbet"], 5);
    assert.equal(s.pendingCount, 2);

    const m = must(s.save());
    for (const base of ["public", "dist"]) {
        assert.equal(readText(game, base, CONFIG_JSON), CONFIG.replace('"freeloop": "snd_1"', '"freeloop": "snd_nuevo"'));
        assert.ok(read(game, base, "assets/sounds/snd_nuevo.mp3").includes("NUEVO"));
        assert.ok(readText(game, base, "assets/gameassets.json").includes('"snd_nuevo": "assets/sounds/snd_nuevo.mp3"'));
    }
    assert.deepEqual(m.changes.map((c) => c.type).sort(), ["moment", "new"]);
    assert.ok(s.aliases.has("snd_nuevo"), "tras guardar es un alias más");
    assert.equal(must(s.moments.find((x) => x.label === "sounds › freeloop")).value, "snd_nuevo");

    s.restore(m.id);
    for (const base of ["public", "dist"]) {
        assert.equal(readText(game, base, CONFIG_JSON), CONFIG);
        assert.equal(readText(game, base, "assets/gameassets.json"), MANIFEST);
        assert.ok(!exists(game, base, "assets/sounds/snd_nuevo.mp3"));
    }
    s.dispose();
});

test("descartar un sonido nuevo revierte los momentos que lo usaban", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    s.stageNew("snd_x", MP3("x"));
    s.setValue(CONFIG_JSON, ["sounds", "freeloop"], "snd_x");
    s.unstageNew("snd_x");
    assert.equal(s.pendingCount, 0);
    s.dispose();
});

test("discover: un audio de common/ que suena en vivo se añade y sobrevive a rescan", () => {
    const { game, dataDir } = fixture();
    const roll = path.join(game, "common/snds/rollup/15/rollup17.mp3");
    fs.mkdirSync(path.dirname(roll), { recursive: true });
    fs.writeFileSync(roll, MP3("r17"));
    const s = new SoundSession(game, { dataDir });
    assert.equal(s.discover("/common/snds/rollup/15/rollup17.mp3"), true);
    assert.equal(s.discover("/common/snds/rollup/15/rollup17.mp3"), false, "ya estaba");
    assert.equal(s.discover("/common/../../etc/passwd.mp3"), false);
    assert.equal(s.discover("/common/no/existe.mp3"), false);
    const id = "common:snds/rollup/15/rollup17.mp3";
    assert.equal(s.sounds.get(id)?.scope, "common");
    s.rescan();
    s.rescan();
    assert.ok(s.sounds.has(id), "sigue tras dos rescan");
    s.stage(id, MP3("nuevo"));
    const m = must(s.save());
    assert.ok(fs.readFileSync(roll).includes("nuevo"));
    s.restore(m.id);
    assert.ok(fs.readFileSync(roll).includes("r17"));
    s.dispose();
});
