// Detección de juegos, escaneo de sonidos, reemplazo, guardado con backup y restauración.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectGame, scanSounds, aliasFor, listGames } from "../src/server/scan.ts";
import { SoundSession, sniffAudio } from "../src/server/session.ts";
import { MP3, WAV, makeGame, inPublicAndDist, read, readText, exists, must } from "./helpers.ts";

const MANIFEST = `{
    "images": { "logo": "assets/main/logo.png" },
    "sounds": {
        "snd_1": "assets/sounds/snd_0001.mp3",
        "snd_2": "assets/sounds/snd_0002.mp3",
        "snd_dup": "assets/sounds/snd_0001.mp3",
        "snd_missing": "assets/sounds/nope.mp3"
    }
}`;

function fixture() {
    return makeGame("g999", {
        ...inPublicAndDist({
            "assets/gameassets.json": MANIFEST,
            "assets/sounds/snd_0001.mp3": MP3("one"),
            "assets/sounds/snd_0002.mp3": MP3("two"),
        }),
        "dist/index.html": "<html></html>",
        "common/snds/windupsnds.json": `{"windup1": {"id": 0, "file": "snds/w1.mp3"}, "old": {"file": "res/x.mp3"}}`,
        "common/snds/w1.mp3": MP3("w1"),
        "common/broken.json": `{ "a": "x.mp3", }`,
    });
}

test("detectGame: raíz, dist suelto y error", () => {
    const { game } = fixture();
    const g = detectGame(game);
    assert.equal(g.number, "999");
    assert.equal(g.gameRoots.length, 2);
    assert.ok(g.commonDir);

    const fromDist = detectGame(path.join(game, "dist"));
    assert.equal(fromDist.dir, game, "eligiendo dist/ se usa la raíz del juego");
    assert.equal(fromDist.gameRoots.length, 2);

    assert.throws(() => detectGame(path.join(game, "common")), /No parece un juego/);
});

test("scanSounds agrupa alias por archivo, marca faltantes e ignora common inexistente", () => {
    const { game } = fixture();
    const { sounds, warnings } = scanSounds(detectGame(game));
    const one = must(sounds.find((s) => s.id === "game:assets/sounds/snd_0001.mp3"));
    assert.deepEqual(one.refs.map((r) => r.alias).sort(), ["snd_1", "snd_dup"]);
    assert.equal(one.url, "/assets/sounds/snd_0001.mp3");
    assert.ok(must(sounds.find((s) => s.rel === "assets/sounds/nope.mp3")).missing);

    const common = sounds.filter((s) => s.scope === "common");
    assert.equal(common.length, 1);
    assert.equal(common[0]?.refs[0]?.alias, "windup1");
    assert.equal(common[0]?.url, "/common/snds/w1.mp3");
    assert.ok(warnings.some((w) => w.includes("broken.json")));
});

test("aliasFor", () => {
    assert.equal(aliasFor(["sounds", "snd_1"]), "snd_1");
    assert.equal(aliasFor(["windup1", "file"]), "windup1");
    assert.equal(aliasFor(["spins", 2, "src"]), "spins[2]");
});

test("sniffAudio reconoce formatos y rechaza basura", () => {
    assert.equal(sniffAudio(MP3("x")), ".mp3");
    assert.equal(sniffAudio(WAV()), ".wav");
    assert.equal(sniffAudio(Buffer.from("OggS000000000000")), ".ogg");
    assert.equal(sniffAudio(Buffer.from("not audio at all")), null);
});

test("guardar mismo formato: escribe en public y dist, hace backup y restaura", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    const id = "game:assets/sounds/snd_0002.mp3";
    assert.throws(() => s.stage(id, Buffer.from("hello world!!")), /no parece audio/);
    s.stage(id, MP3("NEW"), "nuevo.mp3");
    assert.ok(s.overrideForUrl("/assets/sounds/snd_0002.mp3"));

    const m = must(s.save());
    for (const base of ["public", "dist"]) assert.ok(read(game, base, "assets/sounds/snd_0002.mp3").includes("NEW"));
    assert.equal(m.modified.length, 2);
    assert.equal(s.pending.size, 0);
    assert.equal(s.listBackups().length, 1);

    s.restore(m.id);
    for (const base of ["public", "dist"]) assert.ok(read(game, base, "assets/sounds/snd_0002.mp3").includes("two"));
    s.dispose();
});

test("guardar con otro formato: crea .wav y actualiza el JSON sin reformatearlo", () => {
    const { game, dataDir } = fixture();
    const s = new SoundSession(game, { dataDir });
    s.stage("game:assets/sounds/snd_0001.mp3", WAV(), "take3.wav");
    const m = must(s.save());

    for (const base of ["public", "dist"]) {
        assert.equal(readText(game, base, "assets/gameassets.json"), MANIFEST.replaceAll("snd_0001.mp3", "snd_0001.wav"), "solo cambia la extensión");
        assert.ok(exists(game, base, "assets/sounds/snd_0001.wav"));
    }
    assert.ok(s.sounds.has("game:assets/sounds/snd_0001.wav"));
    assert.equal(m.created.length, 2);

    s.restore(m.id);
    assert.equal(readText(game, "public/assets/gameassets.json"), MANIFEST);
    assert.ok(!exists(game, "public/assets/sounds/snd_0001.wav"));
    s.dispose();
});

test("listGames encuentra juegos con public o dist", () => {
    const { root } = fixture();
    fs.mkdirSync(path.join(root, "no-es-juego"));
    const games = listGames(root);
    assert.deepEqual(
        games.map((g) => g.name),
        ["g999"]
    );
    assert.equal(games[0]?.hasDist, true);
});
