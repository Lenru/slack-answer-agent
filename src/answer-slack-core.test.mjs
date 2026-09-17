import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNATURE,
  addressOf,
  eligible,
  holdText,
  parseVerdict,
  nextStep,
  shouldHold,
  signed,
  waitForNoah,
} from "./answer-slack-core.mjs";

// Noah, 2026-09-17: if he is up and online, the assistant waits and he answers.
test("Noah online: the assistant waits", () => {
  // The exact shape users.getPresence returned for his token that day.
  const live = { ok: true, presence: "active", online: true, auto_away: false, manual_away: false, connection_count: 2 };
  assert.equal(waitForNoah(live).wait, true);
});

test("Noah away, automatically or by his own choice: the assistant may answer", () => {
  assert.equal(waitForNoah({ ok: true, presence: "away", auto_away: true }).wait, false);
  assert.equal(waitForNoah({ ok: true, presence: "away", manual_away: true }).wait, false);
});

test("presence we cannot read means wait, never speak for him blind", () => {
  // Silence is recoverable on the next hourly pass; speaking for him while he is
  // online is exactly what he asked us not to do.
  for (const p of [null, undefined, { ok: false, error: "ratelimited" }, { ok: true }, { ok: true, presence: "busy" }]) {
    assert.equal(waitForNoah(p).wait, true, JSON.stringify(p));
  }
});

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

test("a holding reply waits two hours, so it never lands while Noah is reading", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  assert.equal(shouldHold({ created_at: "2026-09-14T11:58:00Z" }, now), false);
  assert.equal(shouldHold({ created_at: "2026-09-14T09:00:00Z" }, now), true);
});

test("the holding reply says who is typing BEFORE it says anything else", () => {
  const t = holdText("Sam Rivera");
  // Noah, 2026-09-14: the reader must know it is Claude before the first word of
  // the message, not after the last one.
  assert.ok(t.startsWith(SIGNATURE + "\n\n"));
  assert.match(t, /\n\nHi Sam, /);
  assert.doesNotMatch(t, /tomorrow|today|by \w+day|within/i);
});

test("every variant reads correctly after the greeting, and there is more than one", () => {
  const bodies = new Set();
  for (const seed of "abcdefghijkl") bodies.add(holdText("Sam Rivera", seed).split("\n\n")[1]);
  assert.ok(bodies.size >= 2, "Noah asked for variety, one phrasing is not variety");
  for (const b of bodies) {
    assert.ok(b.startsWith("Hi Sam, I "), `a variant must open on "I" after the greeting: ${b}`);
    // "Hi Sam, This is..." was the bug: a capital mid-sentence. Lower-casing in
    // code is not the fix, it would turn "I" into "i".
    assert.doesNotMatch(b, /^Hi Sam, [A-HJ-Z]/, `capital mid-sentence: ${b}`);
  }
});

test("the same ask always gets the same wording, so a retry cannot contradict itself", () => {
  assert.equal(holdText("Sam", "task-123"), holdText("Sam", "task-123"));
  // And different asks do actually differ across a handful of ids.
  const spread = new Set("abcdefgh".split("").map((s) => holdText("Sam", s)));
  assert.ok(spread.size > 1);
});

test("NO variant claims anything about what Noah has seen or thinks", () => {
  // The original said "Noah has seen this and does not have the answer to hand".
  // He had not seen it and was never asked, and nothing here can know either. This
  // asserts the invariant rather than a phrasing, because the phrasing now varies
  // and a new variant is exactly where this would come back.
  for (const seed of "abcdefghijkl") {
    const t = holdText("Sam Rivera", seed);
    const body = t.split(SIGNATURE).join("");
    assert.doesNotMatch(
      body,
      /\bNoah (?:has|had|is|was|thinks|knows|saw|read|agreed|decided)\b|\bhe (?:has|had|'?s) (?:seen|read|been asked)\b/i,
      `claims Noah's state: ${body}`,
    );
    // Every variant is the assistant talking about itself, and names Noah only as
    // the person it is escalating TO.
    assert.match(body, /\bI (?:could not|cannot|do not|am)\b/, `not first person: ${body}`);
    assert.match(body, /Noah/, `does not say who it is going to: ${body}`);
  }
});

// The send gate itself is TypeScript and is tested in src/lib/desk-rules.test.ts,
// which runs under tsx. This suite runs on bare node, so it cannot import it.

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

test("the signature leads, once, even when the model already signed the body", () => {
  assert.equal(signed("hello"), `${SIGNATURE}\n\nhello`);
  // A model that signs off at the bottom must not leave it in both places, and the
  // body must survive intact.
  const moved = signed(`hello\n\n${SIGNATURE}`);
  assert.equal(moved.split(SIGNATURE).length - 1, 1);
  assert.equal(moved, `${SIGNATURE}\n\nhello`);
});

// The hourly-heartbeat trap: an ask seen while still too recent to hold must not
// be written off, or the holding reply Noah asked for never fires at all.
const NOW = Date.parse("2026-09-14T12:00:00Z");
const fresh = { id: "t1", created_at: "2026-09-14T11:15:00Z" };  // 45 min old
const old = { id: "t1", created_at: "2026-09-14T09:00:00Z" };    // 3 h old

test("an ask nobody has looked at gets a model call", () => {
  assert.equal(nextStep(fresh, [], NOW).step, "decide");
});

test("an answered ask is never touched again", () => {
  const prior = [{ target: "t1", action: "slack.answer", payload: {} }];
  assert.equal(nextStep(fresh, prior, NOW).step, "skip");
});

test("escalated but too recent to hold stays open, it does not become done", () => {
  const prior = [{ target: "t1", action: "slack.escalate", payload: { held: false } }];
  const got = nextStep(fresh, prior, NOW);
  assert.equal(got.step, "skip");
  assert.match(got.why, /grace/);
});

test("the same ask holds once the grace passes, with no second model call", () => {
  const prior = [{ target: "t1", action: "slack.escalate", payload: { held: false } }];
  assert.equal(nextStep(old, prior, NOW).step, "hold");
});

test("once held, it stops for good and never holds twice", () => {
  const prior = [
    { target: "t1", action: "slack.escalate", payload: { held: false } },
    { target: "t1", action: "slack.escalate", payload: { held: true } },
  ];
  assert.equal(nextStep(old, prior, NOW).step, "skip");
});

test("another task's history is not this task's history", () => {
  const prior = [{ target: "SOMEONE-ELSE", action: "slack.answer", payload: {} }];
  assert.equal(nextStep(fresh, prior, NOW).step, "decide");
});
