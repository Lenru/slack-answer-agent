// The decisions behind answering Slack, with no IO in them, so they can be tested
// without a workspace, a model or a database.
//
// Noah's ask, 2026-09-14: answer Jordan and Sam when we actually have the
// information, otherwise tell them politely that we will come back to them and
// notify him. This file decides WHICH asks are worth a model call, how to read a
// Slack permalink back into a thread address, and whether a model's reply is
// usable. What may be SENT is not decided here: that is checkOutbound() in
// outbound-rules.mjs, which already existed and is the send boundary.

/** How the assistant always identifies itself. checkOutbound() blocks a message without it. */
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
 * The only conversations this may post in, BY ID (channels here get renamed).
 *
 * Noah, 2026-10-03: stop messaging Jordan and Sam, answer only in the two
 * channels the SOP lets sessions talk in. Everything else, DMs included, is
 * skipped before any model call. The IDs here are placeholders; the runner can pass
 * its own set.
 */
export const ALLOWED_CHANNELS = new Map([
  ["C00000000A2", "#agents"],
  ["C00000000A3", "#releases"],
]);

export function channelAllowed(addr, allowed = ALLOWED_CHANNELS) {
  return !!addr && allowed.has(addr.channel);
}

/**
 * Is this ask worth spending a model call and a message on?
 *
 * Three refusals, and each one is a real row that exists today:
 *
 *  - No address. The two seeded 2026-09-09 rows point at a fake channel and at
 *    the desk itself. Posting into DPREFLIGHT would be posting into nothing.
 *  - Someone already replied after the ask. Noah answers by hand constantly, and
 *    the sender must never talk over him. This is checked against the live thread
 *    rather than against a flag, because the flag would be the thing that is stale.
 *  - The Clinic lane. FORBIDDEN_LANES in outbound-rules.mjs, enforced again at the send
 *    boundary. That client is not on this path at all.
 */
export function eligible(item, thread) {
  if (/\bclinic\b/i.test(`${item.title ?? ""} ${item.asked_by ?? ""}`)) {
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
 * I could not answer it (the verdict), I have put it in front of him (the event log
 * row and the Discord ping), and he will reply (the courtesy Noah asked for, with no
 * date attached). Nothing about what he has seen, thinks or decided, which
 * checkOutbound's speaks-for-noah rule now blocks outright.
 */
export const HOLD_VARIANTS = [
  (who) =>
    `${who}I could not give a verifiable answer on this one, so it needs Noah. ` +
    `I am alerting him to it now. Thank you.`,
  // Every variant starts with "I" on purpose. The greeting is prepended, so a
  // variant opening on any other word renders as "Hi Sam, This is..." with a
  // capital mid-sentence, and lower-casing it in code would turn "I" into "i".
  (who) =>
    `${who}I cannot verify this one from anything I have access to, so I am passing ` +
    `it to Noah rather than guessing at it. Raising it with him now.`,
  (who) =>
    `${who}I could not confirm an answer to this from anything I can check. ` +
    `Flagging it to Noah now, and he will come back to you on it.`,
  (who) =>
    `${who}I do not have a checkable answer for this one, so I am putting it to ` +
    `Noah now rather than risk getting it wrong. He will pick it up from here.`,
];

/**
 * The holding reply, in one of several phrasings.
 *
 * Noah asked for variety so it does not read like the same robot every time. The
 * choice is made from the ask's own id rather than at random: the same ask always
 * gets the same wording, so a retry cannot contradict what was already sent, and a
 * test can assert the selection instead of stubbing a random number generator.
 *
 * Every variant says only what is true at the moment of sending: that the assistant
 * could not verify an answer, and that it is alerting Noah as it speaks. None of
 * them report what Noah has seen or thinks, which is a false claim nothing here can
 * check (see the speaks-for-noah rule). outbound-rules.test.mjs runs every variant
 * through checkOutbound, so a phrasing that would be refused cannot ship, which
 * matters because a refused hold means a colleague is left with silence.
 */
export function holdText(askedBy, seed = "") {
  const first = (askedBy ?? "").trim().split(/\s+/)[0];
  const who = first ? `Hi ${first}, ` : "";
  // djb2, enough to spread ids evenly and short enough to read.
  let h = 5381;
  for (const ch of String(seed)) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  const pick = HOLD_VARIANTS[Math.abs(h) % HOLD_VARIANTS.length];
  return signed(pick(who));
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

/**
 * Is Noah around to answer this himself?
 *
 * Noah, 2026-09-17: "if I'm up and online you should wait to send a message to
 * someone." When he is online the people asking should hear from him, not from an
 * assistant speaking for him while he sits right there.
 *
 * The signal is Slack's own presence, from users.getPresence on his user token
 * (users:read, already granted). It is the same green dot the colleague sees, so
 * "online" means exactly what they would assume it means.
 *
 * ONLY an explicit "away" lets the assistant speak. Active waits, and so does
 * anything unreadable: a failed call, a missing field, a changed API. Staying
 * quiet when we cannot tell is recoverable, since the next hourly pass asks again;
 * speaking for him while he is online is the thing he just asked us not to do.
 * Nothing is logged to the event log on a wait, so nextStep() sees the ask as
 * untouched and the first pass after he goes away handles it normally.
 */
/**
 * How long an ask waits for Noah before the assistant acts anyway, online or not.
 *
 * Noah, 2026-09-17: "what if I left my computer on so that it says that I'm online
 * on Slack but I'm actually away and I'm not seeing the message." Measured the same
 * minute: presence "active", last Slack activity 12 minutes old, while he was at his
 * desk working in another app. The green dot says the app is open, not that he has
 * seen anything, and last_activity is no better a signal (it would have called him
 * away while he sat there). Time without a reply is the one thing always true, so
 * the deadline overrides presence entirely, unreadable presence included.
 *
 * Two hours, matching the holding-reply grace in shouldHold(), so an ask he ignores
 * while "online" gets its answer or its holding reply in the same pass. eligible()
 * has already checked the thread for a reply by then, so an ask he did answer never
 * reaches this. Change the number here; nothing else depends on it.
 */
export const ANSWER_DEADLINE_MS = 2 * 60 * 60 * 1000;

export function waitForNoah(presence, item, now = Date.now(), deadlineMs = ANSWER_DEADLINE_MS) {
  const age = now - new Date(item?.created_at).getTime();
  if (Number.isFinite(age) && age >= deadlineMs) {
    return {
      wait: false,
      why: `no reply after ${(age / 3_600_000).toFixed(1)}h, past the ${deadlineMs / 3_600_000}h deadline, so not waiting on his Slack status`,
    };
  }
  if (!presence || presence.ok !== true) {
    return { wait: true, why: `could not read Noah's Slack presence (${presence?.error ?? "no response"}), so not speaking for him` };
  }
  if (presence.presence === "away") {
    return { wait: false, why: presence.manual_away ? "Noah set himself away" : "Noah is away on Slack" };
  }
  return { wait: true, why: `Noah is ${presence.presence ?? "in an unknown state"} on Slack, leaving it to him` };
}
