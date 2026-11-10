// Nombres legibles de eventos del engine y detección de fase (free games / hold & spin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTrigger, detailLabel, eventInfo, phaseOf } from "../src/ui/events.ts";

test("eventos conocidos y desconocidos", () => {
    assert.deepEqual(eventInfo("STOP_INDIVIDUAL_REEL"), { label: "Para un rodillo", cat: "rodillos" });
    assert.equal(eventInfo("HAS_ALGO_NUEVO").cat, "hold", "los HAS_* son de hold & spin");
    assert.equal(eventInfo("TRANSITION_XYZ_FREEGAMES").cat, "free");
    assert.deepEqual(eventInfo("RARO"), { label: "RARO", cat: "otro" });
});

test("fase según BACKGROUND_CHANGE", () => {
    assert.equal(phaseOf("BACKGROUND_CHANGE", '{"id":1}'), "1");
    assert.equal(phaseOf("INMEDIATE_BACKGROUND_CHANGE", '{"id":2,"x":true}'), "2");
    assert.equal(phaseOf("BACKGROUND_CHANGE", '{"id":9}'), null);
    assert.equal(phaseOf("STATE_CHANGED", '{"id":1}'), null);
    assert.equal(detailLabel("BACKGROUND_CHANGE", '{"id":1}'), "Free games");
    assert.equal(detailLabel("STATE_CHANGED", "GAMESTATE_SPINNING"), "Girando");
});

test("descripción de una regla", () => {
    assert.equal(describeTrigger("STATE_CHANGED", "GAMESTATE_SHOWWIN"), "Cambio de estado: Premio");
    assert.equal(describeTrigger("BACKGROUND_CHANGE", '"id":2'), "Cambio de fase: Hold & Spin");
    assert.equal(describeTrigger("STOP_INDIVIDUAL_REEL"), "Para un rodillo");
    assert.equal(describeTrigger("STOP_INDIVIDUAL_REEL", "3"), "Para un rodillo (3)");
});
