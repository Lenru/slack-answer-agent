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
 *  - The Clinic lane. FORBIDDEN_LANES in desk-rules, enforced again at the send
 *    boundary. the client is not on this path at all.
 */
export function eligible(item, thread) {
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

/**
 * The holding reply.
 *
 * IT SAYS ONLY WHAT IS TRUE AT THE MOMENT IT IS SENT. The first version read "Noah
 * has seen this and does not have the answer to hand", and Noah's objection on
 * 2026-09-14 was exact: he had not seen it, he was never asked, and so the message
 * was false and made him look like he had ignored a colleague. Nothing here has any
 * signal about his attention. The desk gets a Discord notification, and a
 * notification is not a person reading something; he never acknowledges anything
 * back to this script.
 *
 * So the subject is "I", the assistant, throughout. Three claims, all checkable:
 * I could not answer it (the verdict), I have put it in front of him (the ops.events
 * row and the Discord ping), and he will reply (the courtesy Noah asked for, with no
 * date attached). Nothing about what he has seen, thinks or decided, which
 * checkOutbound's speaks-for-noah rule now blocks outright.
 */
export function holdText(askedBy) {
  const who = (askedBy ?? "").trim().split(/\s+/)[0];
  return signed(
    `${who ? `Hi ${who}, ` : ""}I could not answer this one from what I can check, ` +
      `so I have put it in front of Noah. He will get back to you on it.`,
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

/**
 * Put the signature FIRST, then a blank line, then the message.
 *
 * Noah's call, 2026-09-14: a reader must know it is Claude before they read a word
 * of it, not after. A sign-off at the bottom is only honest to someone who reaches
 * the bottom, and on a phone a long reply is read as Noah's until the last line
 * disproves it.
 *
 * Any signature the model put in the body is stripped first, so this cannot end up
 * saying it twice. checkOutbound blocks a message without it, so it is never
 * decoration.
 */
export function signed(answer) {
  const body = String(answer).split(SIGNATURE).join("").trim();
  return `${SIGNATURE}\n\n${body}`;
}

/**
 * What to do with an ask, given what we have already done to it.
 *
 * This exists because an hourly heartbeat broke the naive version. An ask that
 * arrives at 09:15 is looked at 10:00, is only 45 minutes old, so it is too
 * recent for a holding reply. If that pass marks the ask "attempted", every later
 * pass skips it and the holding reply NEVER fires: the one case Noah explicitly
 * asked for, a polite "we will come back to you", would be the case that silently
 * never happened.
 *
 * So "attempted" is not one state. An escalation that has not yet held is
 * unfinished work, and the grace period has to be allowed to expire.
 *
 *   answered            -> done, never touch it again
 *   escalated and held  -> done, Noah has been told and they have been told
 *   escalated, no hold  -> tell nobody again, but hold once the grace passes.
 *                          No second model call: it already said it cannot
 *                          answer, and asking twice both costs a call and invites
 *                          a different verdict (the same ask escalated once and
 *                          answered once on 2026-09-14).
 *   nothing yet         -> ask the model
 */
export function nextStep(item, priorEvents, now = Date.now()) {
  const mine = (priorEvents ?? []).filter((e) => e.target === item.id);
  if (mine.some((e) => e.action === "slack.answer")) {
    return { step: "skip", why: "already answered" };
  }
  const escalations = mine.filter((e) => e.action === "slack.escalate");
  if (escalations.some((e) => e.payload?.held === true)) {
    return { step: "skip", why: "already escalated and held" };
  }
  if (escalations.length) {
    return shouldHold(item, now)
      ? { step: "hold", why: "escalated earlier, grace has now passed" }
      : { step: "skip", why: "escalated earlier, still inside the grace period" };
  }
  return { step: "decide", why: "not looked at yet" };
}
