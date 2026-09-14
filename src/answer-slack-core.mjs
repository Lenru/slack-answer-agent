// The decisions behind answering Slack, with no IO in them, so they can be tested
// without a workspace, a model or a database.
//
// Noah's ask, 2026-09-14: answer Jordan and Sam when we actually have the
// information, otherwise tell them politely that we will come back to them and
// notify him. This file decides WHICH asks are worth a model call, how to read a
// Slack permalink back into a thread address, and whether a model's reply is
// usable. What may be SENT is not decided here: that is checkOutbound() in
// src/lib/desk-rules.ts, which already existed and is the send boundary.

/** How the assistant always signs off. Must match ASSISTANT_SIGNATURE. */
export const SIGNATURE = "Claude, answering on Noah's behalf";

/**
 * A Slack permalink is the only address the desk stores, so the thread has to be
 * read back out of it.
 *
 *   https://x.slack.com/archives/C00000000A1/p1789135985621399
 *                                ^channel     ^ts, dot removed
 *
 * The 16 digits after `p` are a message ts with its decimal point stripped: the
 * last 6 are microseconds. Rebuilding it wrong does not error, it posts to a
 * DIFFERENT message, so this returns null rather than guessing whenever the shape
 * is not exactly right. `?thread_ts=` appears on links to a threaded reply and is
 * the parent to answer under.
 */
export function addressOf(permalink) {
  if (!permalink) return null;
  let u;
  try {
    u = new URL(permalink);
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/.test(u.hostname)) return null;

  const m = u.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{16})$/);
  if (!m) return null;

  const [, channel, digits] = m;
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`;
  const parent = u.searchParams.get("thread_ts");
  return { channel, ts, threadTs: parent || ts };
}

/**
 * Is this ask worth spending a model call and a message on?
 *
 * Four refusals, and each one is a real row that exists today:
 *
 *  - No address. The two seeded 2026-09-09 rows point at a fake channel and at
 *    the desk itself. Posting into DPREFLIGHT would be posting into nothing.
 *  - Someone already replied after the ask. Noah answers by hand constantly, and
 *    the sender must never talk over him. This is checked against the live thread
 *    rather than against a flag, because the flag would be the thing that is stale.
 *  - Already handled here. One attempt per ask; a second pass must not re-send.
 *  - The Clinic lane. FORBIDDEN_LANES in desk-rules, enforced again at the send
 *    boundary. the client is not on this path at all.
 */
export function eligible(item, thread, opts = {}) {
  const { alreadyTried = false } = opts;

  if (alreadyTried) return { ok: false, why: "already attempted" };
  if (/\bclinic\b|\bclient\b/i.test(`${item.title ?? ""} ${item.asked_by ?? ""}`)) {
    return { ok: false, why: "clinic lane, never answered from here" };
  }

  const addr = addressOf(item.source_url);
  if (!addr) return { ok: false, why: "no usable slack address" };

  // Who asked, read out of the thread rather than off the desk row. The row stores
  // only a display name ("Sam Rivera"), never a Slack user id, and the message
  // sitting at the ask's own ts carries the id. Deriving it matters: without it the
  // test below reads "anyone posted after the ask", and Sam adding a second line
  // to his own message would look like an answered thread and we would go quiet on
  // him. Falls back to null when the message is not in the window, and then any
  // later message counts, which errs toward silence.
  const askTs = Number(addr.ts);
  const asker = (thread ?? []).find((m) => m.ts === addr.ts)?.user ?? null;

  const answered = (thread ?? []).some(
    (m) => Number(m.ts) > askTs && m.user && m.user !== asker,
  );
  if (answered) return { ok: false, why: "someone already replied in the thread" };

  return { ok: true, addr, asker };
}

/**
 * Has this sat long enough that a holding reply is the courteous thing rather
 * than an interruption?
 *
 * Noah answers most things himself within the hour. Sending "we will get back to
 * you" ninety seconds after Jordan typed, while Noah is reading it, would be worse
 * than saying nothing. Two hours is the wait; it is a number to tune, not a law.
 */
export function shouldHold(item, now = Date.now(), graceMs = 2 * 60 * 60 * 1000) {
  const age = now - new Date(item.created_at).getTime();
  return Number.isFinite(age) && age >= graceMs;
}

/** The holding reply. Short, no promise of a time, and it says who is typing. */
export function holdText(askedBy) {
  const who = (askedBy ?? "").trim().split(/\s+/)[0];
  return (
    `${who ? `Hi ${who}, ` : ""}Noah has seen this and does not have the answer to hand. ` +
    `He will come back to you on it.\n\n${SIGNATURE}`
  );
}

/**
 * Read the model's verdict.
 *
 * The contract is one JSON object and nothing else. Anything that does not parse,
 * or that claims an answer with no sources, is treated as an escalation rather
 * than as a bug to recover from: a reply we cannot account for is exactly what
 * must not be sent. The `sources` list is then handed to checkOutbound, which
 * blocks on an empty one, so this is the first of two checks on the same thing.
 */
export function parseVerdict(raw) {
  const text = String(raw ?? "");
  // A fenced block or surrounding chatter is common enough to be worth surviving.
  const body = text.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return { escalate: true, why: "model returned no JSON" };

  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { escalate: true, why: `model JSON did not parse: ${e.message}` };
  }

  if (v.escalate === true) {
    return { escalate: true, why: String(v.why ?? "model escalated without a reason") };
  }

  const answer = String(v.answer ?? "").trim();
  const sources = Array.isArray(v.sources) ? v.sources.map(String).filter(Boolean) : [];
  if (!answer) return { escalate: true, why: "model returned an empty answer" };
  if (!sources.length) return { escalate: true, why: "model cited nothing, so it guessed" };

  return { escalate: false, answer, sources, why: String(v.why ?? "") };
}

/** Append the signature if the model forgot it. checkOutbound blocks without it. */
export function signed(answer) {
  return answer.includes(SIGNATURE) ? answer : `${answer.trimEnd()}\n\n${SIGNATURE}`;
}
