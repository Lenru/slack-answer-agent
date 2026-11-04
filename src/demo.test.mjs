import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDemo } from "./demo.mjs";
import { SIGNATURE } from "./answer-slack-core.mjs";

const data = JSON.parse(readFileSync(new URL("../example/messages.json", import.meta.url), "utf8"));
const r = await runDemo(data, { log: () => {} });
const outcome = Object.fromEntries(r.slack.map((x) => [x.id, x.outcome]));

test("the example walks every branch of the Slack assistant", () => {
  assert.deepEqual(outcome, {
    "ask-1": "ANSWERED", // cited, signed, rule-clean
    "ask-2": "WAIT", // Noah online, ask still inside the deadline
    "ask-3": "ESCALATED", // speaks for Noah
    "ask-4": "ESCALATED", // promises a date
    "ask-5": "ESCALATED", // cited nothing
    "ask-6": "SKIP", // Noah already replied by hand
    "ask-7": "SKIP", // a DM, not an allowed channel
    "ask-8": "SKIP", // another client's lane
    "ask-9": "HELD", // escalated earlier, grace passed, no second model call
  });
});

test("nothing that was refused reached Slack, and everything sent leads with a signature", () => {
  for (const m of r.sent) {
    assert.doesNotMatch(m.text, /Noah has already seen|by Friday|Five retries/);
    assert.ok(m.text.startsWith(SIGNATURE) || m.text.startsWith("(WatsonsAI"), m.text);
  }
});

test("the agents channel answers, holds a promise, and stays silent on noise", () => {
  assert.deepEqual(r.agents.map((a) => a.outcome), ["ANSWERED", "HELD", "SILENT"]);
  // The commitment it could not make still reached Noah.
  assert.ok(r.told.some((t) => t.includes("T-113")));
});
