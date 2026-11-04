// Answer Slack. The assistant's MOUTH.
//
// Noah's mandate: answer colleagues directly when we have the information, say
// plainly that it is Claude replying, tell him afterwards, and when there is no
// answer say politely that he will come back to them and notify him.
//
// Run:
//   SLACK_TOKEN=xoxp-... node src/answer-slack.mjs --queue=asks.json [--dry] [--no-send]
//
// The queue is a JSON array of asks ({id, title, asked_by, source_url,
// created_at}). In production it was filled by a Slack events webhook; capture
// is not part of this repo.
//
// WHY IT MUST SIGN. The Slack app is installed with USER scopes, so a message
// sent here is sent AS Noah. Without the signature a reader cannot tell Noah
// typed it from Claude typing it, and checkOutbound BLOCKS on its absence rather
// than adding it for us.
//
// TWO GATES, NEITHER OF THEM CONFIDENCE.
//   parseVerdict() refuses a reply that cites nothing, because an uncited answer
//   was guessed. checkOutbound() then refuses on sources, on the signature, on a
//   forbidden lane and on speaking for Noah, and flags commitments, private
//   matters and anything clinical. A flag is an escalation, not a warning:
//   `allowed` has to be true to send.
//
// shortcut: one process, no locking. If two ever run at once a double send is
// possible; claim the ask first if that becomes real.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { checkOutbound } from "./outbound-rules.mjs";
import { callModel } from "./model.mjs";
import { slackAdapter, notifyOwner } from "./slack-adapter.mjs";
import {
  ALLOWED_CHANNELS,
  addressOf,
  channelAllowed,
  eligible,
  holdText,
  nextStep,
  parseVerdict,
  shouldHold,
  signed,
  waitForNoah,
} from "./answer-slack-core.mjs";

/**
 * Ask the model. It is told to answer ONLY from what it can open, and to
 * escalate otherwise. The sources it returns are checked, so "cite something" is
 * not advice here.
 */
export function slackPrompt(ask, thread, askedBy) {
  const transcript = thread
    .slice(-15)
    .map((m) => `${m.user ?? m.bot_id ?? "?"}: ${(m.text ?? "").slice(0, 600)}`)
    .join("\n");

  return `You are answering a Slack message on Noah Watson's behalf, in his work Slack. ${askedBy} is asking.

THE MESSAGE:
${ask}

THE THREAD (oldest first, may be empty):
${transcript || "(none)"}

Answer ONLY from what you can actually open and verify right now in the files you have access to. You are READ-ONLY.

NEVER say what Noah has seen, read, been asked, thinks, wants, agreed to or decided. You have no way to know any of it: he is sent a notification and he never confirms anything back to you, so a notification is not him reading something. Write about what YOU did instead ("I could not find this", "I have put this in front of Noah"). The send gate blocks the message outright if you claim his attention or his opinion.

Escalate to Noah instead of answering when ANY of these is true:
- you cannot find the answer in a source you actually read
- answering means promising a date, a price, a scope or a commitment
- it touches Noah's pay, equity, rates, invoices or another client's matter
- it is a decision that is Noah's to make, not a fact to look up
- it is clinical or about patients

Reply with ONE JSON object and nothing else:
{"escalate": false, "answer": "<what to say to ${askedBy}, plain and short, no greeting needed>", "sources": ["<file path, table, or URL you actually read>"], "why": "<one line>"}
or
{"escalate": true, "why": "<one line on what you would need>"}

A source must be something you opened. An empty sources list means you guessed, and the reply will be refused.`;
}

/**
 * One pass over the queue.
 *
 * @param {object} o
 * @param {object[]} o.asks     open asks, oldest first
 * @param {object}   o.adapter  see slack-adapter.mjs
 * @param {(prompt: string, item: object) => Promise<string>} o.model
 * @param {object[]} o.events   what earlier passes did; this pass appends to it
 * @param {(text: string) => Promise<void>} o.notify  tells Noah
 * @returns {Promise<{id: string, outcome: string, why: string, text?: string}[]>}
 */
export async function runSlack({ asks, adapter, model, events, notify, allowed = ALLOWED_CHANNELS, now = Date.now(), dry = false, log = console.log }) {
  const results = [];
  const out = (item, outcome, why, text) => {
    results.push({ id: item.id, outcome, why, ...(text ? { text } : {}) });
    log(`${outcome.padEnd(9)} ${item.asked_by ?? "someone"}: ${String(item.title).slice(0, 60)}\n          ${why}${text ? `\n          ---\n          ${text.replace(/\n/g, "\n          ")}` : ""}\n`);
  };
  const record = (e) => {
    if (!dry) events.push({ ...e, at: new Date(now).toISOString() });
  };

  // If Noah is online, he answers his own people, unless an ask has gone
  // unanswered past ANSWER_DEADLINE_MS. Read once per run, only when something is
  // waiting, and applied per ask, because the deadline is per ask.
  const presence = asks.length ? await adapter.presence() : null;

  for (const item of asks) {
    // One bad ask must not abort the rest. A dead channel, a revoked token or a
    // rate limit is per-item news, and the next person waiting should still get
    // an answer.
    try {
      await handle(item);
    } catch (e) {
      out(item, "ERROR", e.message);
      record({ target: item.id, action: "slack.answer", outcome: "failure", why: e.message });
    }
  }
  return results;

  async function send(addr, text) {
    // Second check at the send boundary, so no future code path can post elsewhere.
    if (!channelAllowed(addr, allowed)) throw new Error(`refused to post to ${addr.channel}: not an allowed channel`);
    if (!dry) await adapter.post(addr, text);
  }

  /**
   * Send the holding reply, THROUGH THE GATE. It used to skip the gate, so the
   * one message shape written entirely by us was the only one nothing checked,
   * which is exactly how "Noah has seen this" reached a colleague. A refused hold
   * is our template being broken, so it throws rather than sending something
   * unchecked.
   */
  async function sendHold(addr, item) {
    const text = holdText(item.asked_by, item.id);
    const rules = checkOutbound({ lane: "work", to: item.asked_by ?? "unknown", text, sources: [], kind: "hold" });
    if (!rules.allowed) {
      throw new Error(`the holding reply itself was refused (${[...rules.blocked, ...rules.flagged].join(", ")}); nothing was sent`);
    }
    await send(addr, text);
    return text;
  }

  async function handle(item) {
    const addr = addressOf(item.source_url);
    if (!addr) return out(item, "SKIP", "no usable slack address");
    // Nothing is logged, so the ask stays in the queue for Noah to answer by hand.
    if (!channelAllowed(addr, allowed)) return out(item, "SKIP", `${addr.channel} is not an allowed channel`);

    // Decided before any network or model spend, from what we already did to it.
    const plan = nextStep(item, events, now);
    if (plan.step === "skip") return out(item, "SKIP", plan.why);

    // Before the thread fetch and the model call, so waiting costs nothing, and
    // nothing is logged, so a later pass sees the ask exactly as it is now.
    const around = waitForNoah(presence, item, now);
    if (around.wait) return out(item, "WAIT", around.why);

    const thread = await adapter.thread(addr);
    const gate = eligible(item, thread);
    if (!gate.ok) return out(item, "SKIP", gate.why);

    // Escalated on an earlier pass, and the grace has now expired. No second model
    // call: it already said it cannot answer, and asking again costs a call and
    // invites a different verdict for no gain.
    if (plan.step === "hold") {
      const text = await sendHold(addr, item);
      record({ target: item.id, action: "slack.escalate", outcome: "skipped", why: plan.why, payload: { held: true } });
      return out(item, "HELD", plan.why, text);
    }

    // Read the ask from SLACK, not from the queue row. Capture truncated titles at
    // ~155 characters, so the title is a label for a list and not the question;
    // the model once correctly refused a message it could see was cut off
    // mid-sentence. The full text is in the thread we just fetched.
    const full = thread.find((m) => m.ts === addr.ts)?.text?.trim();
    const ask = full && full.length > String(item.title).length ? full : String(item.title);

    let verdict;
    try {
      verdict = parseVerdict(await model(slackPrompt(ask, thread, item.asked_by ?? "a colleague"), item));
    } catch (e) {
      verdict = { escalate: true, why: e.message };
    }

    if (!verdict.escalate) {
      const text = signed(verdict.answer);
      const rules = checkOutbound({ lane: "work", to: item.asked_by ?? "unknown", text, sources: verdict.sources });
      if (rules.allowed) {
        await send(addr, text);
        record({ target: item.id, action: "slack.answer", outcome: "success", why: verdict.why, payload: { sources: verdict.sources, text } });
        return out(item, "ANSWERED", `sources: ${verdict.sources.join(", ")}`, text);
      }
      // An answer the rules refuse becomes an escalation, and the reason is the
      // rule ids, so the log says what it declined to say rather than only that
      // it declined.
      verdict = { escalate: true, why: `rules refused: ${[...rules.blocked, ...rules.flagged].join(", ")}` };
    }

    // No answer. Hold the line politely if it has waited, and tell Noah either way.
    const hold = shouldHold(item, now);
    const text = hold ? await sendHold(addr, item) : undefined;
    record({ target: item.id, action: "slack.escalate", outcome: "skipped", why: verdict.why, payload: { held: hold } });
    out(item, "ESCALATED", `${verdict.why}${hold ? " (holding reply sent)" : " (too recent for a holding reply)"}`, text);
    if (!dry) {
      await notify(
        `${item.asked_by ?? "Someone"} needs you: ${String(item.title).slice(0, 180)}\n` +
          `Could not answer it: ${verdict.why}\n` +
          `${hold ? "Told them you would come back to them. " : ""}${item.source_url ?? ""}`,
      );
    }
  }
}

async function main() {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const queue = arg("queue");
  if (!queue) throw new Error("usage: node src/answer-slack.mjs --queue=asks.json [--dry] [--no-send]");
  const dry = process.argv.includes("--dry");
  // Everything except the Slack send: still decides, still logs, still pings Noah.
  const noSend = process.argv.includes("--no-send");
  const stateFile = path.resolve(".state", "slack-events.json");
  const events = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
  const allowed = process.env.SLACK_ALLOWED_CHANNELS
    ? new Map(process.env.SLACK_ALLOWED_CHANNELS.split(",").map((c) => [c.trim(), c.trim()]))
    : ALLOWED_CHANNELS;

  const slack = slackAdapter(process.env.SLACK_TOKEN);
  const adapter = noSend ? { ...slack, post: async (a) => console.log(`          [--no-send] would have posted to ${a.channel}`) } : slack;

  await runSlack({
    asks: JSON.parse(readFileSync(queue, "utf8")),
    adapter,
    model: (prompt) => callModel(prompt),
    events,
    notify: notifyOwner,
    allowed,
    dry,
  });
  if (!dry) {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(events, null, 2));
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
