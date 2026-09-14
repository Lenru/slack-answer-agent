import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNATURE,
  addressOf,
  eligible,
  holdText,
  parseVerdict,
  shouldHold,
  signed,
} from "./answer-slack-core.mjs";

const REAL = "https://example.slack.com/archives/C00000000A1/p1789135985621399";

test("a real permalink decodes to the channel and the message ts", () => {
  assert.deepEqual(addressOf(REAL), {
    channel: "C00000000A1",
    ts: "1789135985.621399",
    threadTs: "1789135985.621399",
  });
});

test("a link into a thread answers under the parent, not the reply", () => {
  const a = addressOf(`${REAL}?thread_ts=1789135426.845649`);
  assert.equal(a.ts, "1789135985.621399");
  assert.equal(a.threadTs, "1789135426.845649");
});

test("a desk link is not a slack link, so it yields no address", () => {
  // A real ops.tasks row from 2026-09-09: source_url pointed at the desk itself.
  assert.equal(addressOf("https://noah-os-hub.vercel.app/hub/desk"), null);
});

test("a well-formed address to a channel that does not exist still parses", () => {
  // The 2026-09-09 preflight row. DPREFLIGHT is a legal channel id shape, so this
  // function cannot and should not reject it: only Slack knows the channel is
  // fake, and it says so with channel_not_found. Both seeded rows are already
  // closed, so neither reaches the sender; this is here to record that the guard
  // against them is their status, NOT this parse.
  assert.deepEqual(
    addressOf("https://example.slack.com/archives/DPREFLIGHT/p1757000000000100"),
    { channel: "DPREFLIGHT", ts: "1757000000.000100", threadTs: "1757000000.000100" },
  );
});

test("a malformed or foreign link is refused rather than guessed", () => {
  assert.equal(addressOf(null), null);
  assert.equal(addressOf("not a url"), null);
  // Right shape, wrong host: posting here would be posting to a stranger.
  assert.equal(addressOf("https://evil.example.com/archives/C01/p1789135985621399"), null);
  // 15 digits, not 16. Rebuilding this ts would address a DIFFERENT message.
  assert.equal(addressOf("https://x.slack.com/archives/C01/p178913598562139"), null);
});

test("someone else replying after the ask stops us talking over them", () => {
  const item = { title: "what is the staging URL?", source_url: REAL };
  const thread = [
    { ts: "1789135985.621399", user: "USAM" },
    { ts: "1789136999.000000", user: "UNOAH" },
  ];
  assert.equal(eligible(item, thread).ok, false);
  assert.match(eligible(item, thread).why, /already replied/);
});

test("the asker adding to their own message is not a reply", () => {
  const item = { title: "what is the staging URL?", source_url: REAL };
  const thread = [
    { ts: "1789135985.621399", user: "USAM" },
    { ts: "1789136999.000000", user: "USAM" },
  ];
  assert.equal(eligible(item, thread).ok, true);
});

test("a clean ask with nobody replying is eligible", () => {
  const item = { title: "what is the current API rate limit?", source_url: REAL };
  const got = eligible(item, []);
  assert.equal(got.ok, true);
  assert.equal(got.addr.channel, "C00000000A1");
});

test("the clinic lane never gets answered from here", () => {
  const item = { title: "can we post this for Clinic?", source_url: REAL, asked_by: "the client" };
  assert.equal(eligible(item, []).ok, false);
});

test("a second pass does not re-send", () => {
  const item = { title: "anything", source_url: REAL };
  assert.equal(eligible(item, [], { alreadyTried: true }).ok, false);
});

test("a holding reply waits two hours, so it never lands while Noah is reading", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  assert.equal(shouldHold({ created_at: "2026-09-14T11:58:00Z" }, now), false);
  assert.equal(shouldHold({ created_at: "2026-09-14T09:00:00Z" }, now), true);
});

test("the holding reply names them, promises no date, and says who is typing", () => {
  const t = holdText("Sam Rivera");
  assert.match(t, /^Hi Sam,/);
  assert.ok(t.includes(SIGNATURE));
  assert.doesNotMatch(t, /tomorrow|today|by \w+day|within/i);
});

test("a verdict citing nothing is an escalation, not an answer", () => {
  const v = parseVerdict('{"escalate": false, "answer": "about 400 requests a minute", "sources": []}');
  assert.equal(v.escalate, true);
  assert.match(v.why, /guessed/);
});

test("an answer with a source survives, fenced or not", () => {
  const v = parseVerdict(
    'Here you go:\n```json\n{"escalate": false, "answer": "600 requests a minute", "sources": ["config/limits.json"], "why": "read the table"}\n```',
  );
  assert.equal(v.escalate, false);
  assert.equal(v.answer, "600 requests a minute");
  assert.deepEqual(v.sources, ["config/limits.json"]);
});

test("junk, empty answers and a bare escalation all land as escalations", () => {
  assert.equal(parseVerdict("I could not find that").escalate, true);
  assert.equal(parseVerdict("{oh no").escalate, true);
  assert.equal(parseVerdict('{"escalate": false, "answer": "  ", "sources": ["x"]}').escalate, true);
  assert.equal(parseVerdict('{"escalate": true, "why": "need Noah"}').escalate, true);
});

test("the signature is added once and never twice", () => {
  assert.ok(signed("hello").endsWith(SIGNATURE));
  const once = signed(`hello\n\n${SIGNATURE}`);
  assert.equal(once.split(SIGNATURE).length - 1, 1);
});
