// The decisions behind answering #agents, with no IO in them, so they can
// be tested without Slack, a model or an Community checkout.
//
// Noah's ask, 2026-09-25: the agents channel only works if both machines speak
// unprompted, so his side needed a responder, not another reader. The one limit
// he set is that it may answer and coordinate but may NOT take on work: accepting
// ownership or claiming a ticket puts real hours on his plate and reads to Jordan
// as a promise. That limit lives in gate(), below, and is the reason this file
// is separate from the orchestrator.

/** Every message opens with this, so a reader can tell a session from Noah. */
export const SIGNATURE = "(Claude on behalf of Noah Watson):";

/**
 * Is this message one we should be deciding about?
 *
 * Extracted purely so it can be tested, because the `user !== me` half is the
 * only thing standing between this and a session replying to itself forever in
 * a channel two people read.
 *
 * @param {{ts: string, user?: string, subtype?: string}} m
 * @param {string} since watermark ts
 * @param {string} me our own Slack user id
 */
export function isCandidate(m, since, me) {
  if (m.subtype === "channel_join" || m.subtype === "channel_leave") return false;
  if (!m.user || m.user === me) return false;
  return Number(m.ts) > Number(since);
}

/**
 * The gate. Nothing reaches Slack without passing this.
 *
 * `commits` is the model's own declaration and the regexes are the backstop,
 * because a model that has just written "happy to take that on" is the last
 * thing that should be trusted to notice it did. Either tripping means Noah
 * gets the ping and the channel gets nothing, which is the correct failure: a
 * silence costs a few hours, a promise costs whatever was promised.
 *
 * @param {string} text
 * @param {boolean} commits the model's own declaration
 * @returns {{ok: boolean, why?: string, text?: string}}
 */
export function gate(text, commits) {
  const body = String(text ?? "").trim();
  // agents.py refuses anything shorter as not worth a channel everyone reads.
  if (body.length < 15) return { ok: false, why: "too short for a channel everyone reads" };
  if (commits) return { ok: false, why: "the model declared this commits Noah's side" };

  const takesWork =
    /(i'?ll take|i will take|we'?ll take|we will take|claiming d\d|i'?ll claim|i'?ll own|we'?ll own|happy to take|assign(ing)? (it|that|this) to (me|us)|i'?ll pick (it|that|this) up|we'?ll pick (it|that|this) up|consider it done|i'?ll have it (done|ready) by|we'?ll have it (done|ready) by)/i;
  if (takesWork.test(body)) return { ok: false, why: "reads as accepting work or claiming a row" };

  // Same rule as the Slack assistant: a Discord ping is not Noah reading something,
  // so nothing may report his attention, his agreement or his opinion.
  const speaksForNoah =
    /\bnoah (has |had |'s )?(seen|read|reviewed|agreed|approved|decided|confirmed|signed off|wants|thinks|is happy)\b/i;
  if (speaksForNoah.test(body)) return { ok: false, why: "claims Noah's attention or opinion" };

  return { ok: true, text: body.startsWith(SIGNATURE) ? body : `${SIGNATURE}\n\n${body}` };
}
