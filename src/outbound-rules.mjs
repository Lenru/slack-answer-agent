// The send boundary for the Slack assistant. Every outbound message, answers and
// holding replies alike, goes through checkOutbound() and is sent only if it
// comes back allowed.
//
// Messages are gated on SOURCE, not on confidence. Self-assessed confidence is
// exactly the thing a model is worst at, so the question is never "am I sure",
// it is "can I check". An answer that exists in something the model opened can
// be sent. An answer that would require guessing, promising or judging goes to
// Noah.
//
// A BLOCK stops a message outright. A FLAG also stops it: `allowed` is true only
// when both lists are empty, so a flag is an escalation, not a warning.

import { SIGNATURE } from "./answer-slack-core.mjs";

/** Lanes the assistant must never message, however the request is phrased. */
export const FORBIDDEN_LANES = ["clinic"];

/**
 * Claims about Noah himself, which nothing here can check.
 *
 * The assistant may report what IT did ("I have flagged this for Noah"). It may
 * never report his attention or his mind: whether he has seen a message, read
 * it, been asked, thought about it, agreed, decided or is aware. There is no
 * signal for any of that. He gets a notification, and a notification is not a
 * person reading something.
 *
 * Blocked rather than flagged: a false statement about a real person, sent to his
 * colleague under his own name, is not something to review later. This rule
 * exists because an early holding reply told a colleague "Noah has seen this and
 * does not have the answer to hand". He had not seen it and was never asked.
 */
const SPEAKS_FOR_NOAH_PATTERNS = [
  /\bNoah (?:has|had|have|'?s|is|was|does|doesn'?t|did|didn'?t|will|would|wants?|thinks?|feels?|knows?|agrees?|prefers?|decided|believes?)\b/i,
  /\bhe (?:has|had|'?s) (?:seen|read|reviewed|looked at|checked|been asked|been told|considered)\b/i,
  /\b(?:Noah|he) (?:is|'?s) (?:aware|across|up to speed|happy|fine|okay|ok) (?:with|of|about)\b/i,
  /\bNoah (?:said|says|mentioned|confirmed|approved|asked me)\b/i,
];

/** Dates, prices and scope are Noah's to give. A guessed deadline is a real obligation. */
const COMMITMENT_PATTERNS = [
  /\bby (mon|tues|wednes|thurs|fri|satur|sun)day\b/i,
  /\bby (the )?(end of|eod|eow|cob)\b/i,
  /\b(i|we)('| wi)?ll have it\b/i,
  /\bnext (week|sprint|month)\b/i,
  /[$£€]\s?\d/,
  /\b\d+\s?(hours?|days?|weeks?)\b/i,
];

/** His pay and his other clients are not context a teammate should receive. */
const PRIVATE_PATTERNS = [
  /\b(salary|equity|back ?pay|compensation|my rate|invoice|retainer)\b/i,
  /\bclinic\b/i,
];

/** One of his clients is a healthcare practice. Nothing clinical goes out from here. */
const CLINICAL_PATTERNS = [
  /\b(patient|diagnos|medication|prescrib|therapy|psychiatr|clinical|treatment)\w*/i,
];

/**
 * @param {{lane: string, to: string, text: string, sources?: string[], kind?: "answer"|"hold"}} m
 *
 * `kind`: "answer" carries a claim and must cite something. "hold" carries no
 * claim at all, it says only that the assistant could not answer and is alerting
 * Noah, so requiring a source would refuse every one of them. The holding reply
 * used to bypass this function completely, so the one message shape written
 * entirely by us was the one shape nothing checked. Everything except the source
 * requirement applies to a hold. Defaults to "answer": a caller that forgets gets
 * the stricter path.
 *
 * @returns {{allowed: boolean, blocked: string[], flagged: string[]}}
 */
export function checkOutbound(m) {
  const blocked = [];
  const flagged = [];

  if (!m.text.includes(SIGNATURE)) blocked.push("identify");
  // Checked against the body only. The signature itself contains "Noah" and would
  // otherwise trip the patterns on every single message.
  const body = m.text.split(SIGNATURE).join("");
  if (SPEAKS_FOR_NOAH_PATTERNS.some((r) => r.test(body))) blocked.push("speaks-for-noah");
  if (FORBIDDEN_LANES.includes(m.lane.toLowerCase())) blocked.push("forbidden-lane");
  // Nothing to cite means nothing to check means it was guessed. A hold makes no
  // claim to check, so this is the one rule it is exempt from.
  if ((m.kind ?? "answer") === "answer" && !m.sources?.length) blocked.push("answerable");

  if (COMMITMENT_PATTERNS.some((r) => r.test(m.text))) flagged.push("commitments");
  if (PRIVATE_PATTERNS.some((r) => r.test(m.text))) flagged.push("private");
  if (CLINICAL_PATTERNS.some((r) => r.test(m.text))) flagged.push("clinical");

  return { allowed: blocked.length === 0 && flagged.length === 0, blocked, flagged };
}
