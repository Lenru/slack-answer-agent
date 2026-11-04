import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutbound } from "./outbound-rules.mjs";
import { HOLD_VARIANTS, holdText, signed } from "./answer-slack-core.mjs";

const answer = (text, sources = ["docs/limits.md"]) => checkOutbound({ lane: "work", to: "Sam", text: signed(text), sources });

test("a signed, cited, plain answer is allowed", () => {
  assert.deepEqual(answer("The staging URL is in docs/environments.md, line 4."), { allowed: true, blocked: [], flagged: [] });
});

test("every holding reply variant passes the gate", () => {
  // A refused hold leaves a colleague with silence, so a bad phrasing must fail
  // here rather than in production.
  for (let i = 0; i < HOLD_VARIANTS.length * 4; i += 1) {
    const r = checkOutbound({ lane: "work", to: "Sam", text: holdText("Sam Rivera", `seed-${i}`), sources: [], kind: "hold" });
    assert.equal(r.allowed, true, JSON.stringify(r));
  }
});

test("no signature, no send", () => {
  const r = checkOutbound({ lane: "work", to: "Sam", text: "It is in the docs.", sources: ["docs"] });
  assert.ok(r.blocked.includes("identify"));
});

test("an answer citing nothing is blocked; a hold is exempt from that one rule", () => {
  assert.ok(answer("It is 600 a minute.", []).blocked.includes("answerable"));
  const hold = checkOutbound({ lane: "work", to: "Sam", text: signed("I could not verify this, so it needs Noah."), sources: [], kind: "hold" });
  assert.equal(hold.allowed, true);
});

test("claims about what Noah has seen or thinks are blocked", () => {
  for (const t of ["Noah has seen this and agrees.", "Noah approved the plan.", "He has read it already.", "Noah is happy with the change."]) {
    assert.ok(answer(t).blocked.includes("speaks-for-noah"), t);
  }
  // Saying what the assistant did is fine, and so is the signature, which names him.
  assert.equal(answer("I have put this in front of Noah.").allowed, true);
});

test("dates, prices and durations are flagged as commitments, and a flag stops the send", () => {
  for (const t of ["We'll have it by Friday.", "That is $400.", "Two weeks of work, roughly 3 days."]) {
    const r = answer(t);
    assert.ok(r.flagged.includes("commitments"), t);
    assert.equal(r.allowed, false);
  }
});

test("pay, other clients and anything clinical are flagged", () => {
  assert.ok(answer("The retainer covers it.").flagged.includes("private"));
  assert.ok(answer("The clinic asked about it too.").flagged.includes("private"));
  assert.ok(answer("The patient form is live.").flagged.includes("clinical"));
});

test("a forbidden lane is blocked whatever the text", () => {
  const r = checkOutbound({ lane: "Clinic", to: "x", text: signed("Hello."), sources: ["x"] });
  assert.ok(r.blocked.includes("forbidden-lane"));
});
