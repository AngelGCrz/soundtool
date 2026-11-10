// ZIP, exportación de cambios y modo portal (URL del loader, lectura de initGame, guardado bloqueado).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createZip } from "../src/server/zip.ts";
import { SoundSession } from "../src/server/session.ts";
import { buildLoaderUrl, parseLoader } from "../src/server/remote.ts";
import { MP3, makeGame, read, readText, must, readZip } from "./helpers.ts";

test("createZip: archivos comprimidos y sin comprimir, nombres UTF-8", () => {
    const json = '{"a": "' + "x".repeat(500) + '"}';
    const files = readZip(
        createZip([
            { name: "a/texto.json", data: json },
            { name: "b/ñandú.mp3", data: Buffer.from([1, 2, 3]) },
        ])
    );
    assert.equal(must(files.get("a/texto.json")).toString(), json);
    assert.deepEqual([...must(files.get("b/ñandú.mp3"))], [1, 2, 3]);
});

test("exportZip: incluye solo lo cambiado, JSON completos y no toca el juego", () => {
    const MANIFEST = `{\n  "sounds": {\n    "snd_1": "assets/sounds/snd_0001.mp3"\n  }\n}`;
    const CONFIG = `{\n  "sounds": { "freeloop": "snd_1" }\n}`;
    const { root, game } = makeGame("g997", {
        "public/assets/gameassets.json": MANIFEST,
        "public/assets/json/config.json": CONFIG,
        "public/assets/json/otro.json": "{}",
        "public/assets/sounds/snd_0001.mp3": MP3("one"),
    });
    const s = new SoundSession(game, { dataDir: path.join(root, ".d") });
    assert.throws(() => s.exportZip(), /No hay cambios/);
    s.stage("game:assets/sounds/snd_0001.mp3", MP3("NEW"), "nuevo.mp3");
    s.stageNew("snd_extra", MP3("EXTRA"), "extra.mp3");
    s.setValue("assets/json/config.json", ["sounds", "freeloop"], "snd_extra");

    const { name, zip } = s.exportZip();
    assert.match(name, /^g997-sonidos-.*\.zip$/);
    const files = readZip(zip);
    assert.deepEqual([...files.keys()].sort(), [
        "CAMBIOS.md",
        "public/assets/gameassets.json",
        "public/assets/json/config.json",
        "public/assets/sounds/snd_0001.mp3",
        "public/assets/sounds/snd_extra.mp3",
        "soundtool-changes.json",
    ]);
    assert.equal(must(files.get("public/assets/json/config.json")).toString(), CONFIG.replace('"snd_1"', '"snd_extra"'));
    assert.ok(must(files.get("public/assets/sounds/snd_0001.mp3")).includes("NEW"));
    assert.ok(must(files.get("CAMBIOS.md")).toString().includes("freeloop"));

    // El juego sigue intacto y los cambios siguen pendientes
    assert.equal(readText(game, "public/assets/json/config.json"), CONFIG);
    assert.ok(read(game, "public/assets/sounds/snd_0001.mp3").includes("one"));
    assert.equal(s.pendingCount, 3);
    s.dispose();
});

test("guardar está bloqueado en juegos del portal", () => {
    const { root, game } = makeGame("cache", {
        "public/assets/gameassets.json": `{"sounds":{"a":"assets/sounds/a.mp3"}}`,
        "public/assets/sounds/a.mp3": MP3("a"),
    });
    const s = new SoundSession(game, {
        dataDir: path.join(root, ".d"),
        remote: { gameId: "G1", name: "Prueba", version: "1.0", loaderUrl: "x", casino: "test" },
    });
    s.stage("game:assets/sounds/a.mp3", MP3("b"));
    assert.throws(() => s.save(), /Exportar/);
    assert.match(s.exportZip().name, /^G1-v1\.0-sonidos-/);
    s.dispose();
});

test("loader: URL como la arma el portal y lectura de initGame", () => {
    const base = { loader: "https://x/loadgame", playerId: "10421", gameId: "G490", lang: "eng" };
    assert.equal(
        buildLoaderUrl({ ...base, endpoint: { skin: "zitoboxweb", uid: 10, platformId: "ZB" } }),
        "https://x/loadgame/intloadgame?mode=real&playerId=10421&variation=0&gameId=G490&gameTech=pixi&skin=zitoboxweb&lang=eng&uid=10&platformId=ZB"
    );
    assert.equal(
        buildLoaderUrl({ ...base, endpoint: { skin: "int2", uid: 1, platformId: "" } }),
        "https://x/loadgame/loadgame?playerid=10421&variation=0&gameid=G490&skin=int2&lang=eng&uid=1"
    );
    const info = parseLoader(`window.initGame = function(){ var obj = { game : "G490", gversion : "2.0.25", gcommon : "0.23.663",
        gpath : "https://cdn//G490/v2.0.25/", cpath: "x" } }`);
    assert.deepEqual(info, { gpath: "https://cdn//G490/v2.0.25", gcommon: "0.23.663", game: "G490", gversion: "2.0.25" });
    assert.throws(() => parseLoader("<html><body>Player not found</body></html>"), /Player not found/);
});
