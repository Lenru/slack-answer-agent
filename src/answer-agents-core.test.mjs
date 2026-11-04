import test from "node:test";
import assert from "node:assert/strict";
import { gate, isCandidate, SIGNATURE } from "./answer-agents-core.mjs";

const ME = "U00000000ME";

test("isCandidate never returns our own messages", () => {
  // The one catastrophic failure: a session answering itself in a loop, in a
  // channel two people read.
  assert.equal(isCandidate({ ts: "200", user: ME }, "100", ME), false);
  assert.equal(isCandidate({ ts: "200", user: "UJORDAN" }, "100", ME), true);
});

test("isCandidate ignores anything at or before the watermark", () => {
  assert.equal(isCandidate({ ts: "100", user: "UJORDAN" }, "100", ME), false);
  assert.equal(isCandidate({ ts: "99", user: "UJORDAN" }, "100", ME), false);
  // Slack ts are "1790338422.031019": string compare would put 999 after 1790.
  assert.equal(isCandidate({ ts: "1790338422.031019", user: "UJORDAN" }, "999.000001", ME), true);
});

test("isCandidate skips joins, leaves and bot posts with no user", () => {
  assert.equal(isCandidate({ ts: "200", user: "UJORDAN", subtype: "channel_join" }, "100", ME), false);
  assert.equal(isCandidate({ ts: "200" }, "100", ME), false);
});

test("gate passes an ordinary answer and adds the signature", () => {
  const r = gate("T-112: reproduced on this machine, the fixture is exhausted.", false);
  assert.equal(r.ok, true);
  assert.ok(r.text.startsWith(SIGNATURE));
});

test("gate does not double up a signature that is already there", () => {
  const r = gate(`${SIGNATURE}\n\nT-112: reproduced on this machine.`, false);
  assert.equal(r.ok, true);
  assert.equal(r.text.indexOf(SIGNATURE), r.text.lastIndexOf(SIGNATURE));
});

test("gate refuses when the model declares it commits Noah's side", () => {
  assert.equal(gate("T-113: that plan reads right to me and we agree.", true).ok, false);
});

test("gate refuses text that takes on work, whatever the model declared", () => {
  // The backstop. A model that just wrote this is the last thing to be trusted
  // to notice it did.
  for (const bad of [
    "T-113: happy to take the four audit fixes, I'll have it done by Friday.",
    "T-113: claiming T-114 for the SLACK_TOKEN change.",
    "SOP housekeeping: we'll own the bootstrap.ps1 half.",
    "T-112: I'll pick that up today.",
    "T-112: consider it done.",
  ]) {
    assert.equal(gate(bad, false).ok, false, `should have been refused: ${bad}`);
  }
});

test("gate refuses text that speaks for Noah", () => {
  assert.equal(gate("T-113: Noah has seen this and agreed to the owners.", false).ok, false);
  assert.equal(gate("T-113: Noah approved the three rules yesterday.", false).ok, false);
});

test("gate refuses a message too short for the channel", () => {
  // The channel's posting script rejects these anyway; failing here means Noah hears about it.
  assert.equal(gate("ack", false).ok, false);
  assert.equal(gate("", false).ok, false);
});

test("gate lets us say what we did without claiming Noah did it", () => {
  const r = gate("T-113: I have put the ownership question in front of Noah.", false);
  assert.equal(r.ok, true);
});

test("gate refuses a reply that quotes a credential", () => {
  const g = gate("Sure, the deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123", false);
  assert.equal(g.ok, false);
  assert.match(g.why, /credential/);
});
