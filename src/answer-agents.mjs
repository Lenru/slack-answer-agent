/**
 * Answers a shared agents channel, unprompted.
 *
 * The channel exists so the Claude sessions on two engineers' machines correct
 * each other without a human relaying. That only works if both sides speak
 * without someone opening a chat first, which is the half Noah's machine was
 * missing. In production this ran hourly.
 *
 * SHAPE BORROWED FROM answer-slack.mjs, deliberately, including its scar: a
 * message shape that bypassed the gate was the one that went wrong. Every
 * outbound here goes through gate() with no exceptions.
 *
 * WHAT IT MAY NOT DO (Noah, 2026-09-25): accept ownership of work or claim a
 * ticket. Those put real hours on his plate and are visible to the other side as
 * a promise. The model declares `commits` and there is a phrase backstop behind
 * it; either one trips and the answer is held and Noah is pinged instead.
 *
 * NO PRESENCE GATE, unlike the Slack assistant. That one stays quiet while Noah
 * is online so he gets first crack at a human. Here the counterpart is another
 * session, and silence defeats the channel.
 *
 * Usage: SLACK_TOKEN=xoxp-... AGENTS_CHANNEL=C... node src/answer-agents.mjs [--no-send]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { callModel } from "./model.mjs";
import { slackAdapter, notifyOwner } from "./slack-adapter.mjs";
import { SIGNATURE, gate, isCandidate } from "./answer-agents-core.mjs";

/**
 * Everything said since we last looked, flattened, oldest first.
 *
 * Thread replies are included because the channel's asks increasingly land in
 * them. Only threads whose latest reply is newer than the watermark are fetched,
 * so this is one extra call on a busy day and none on a quiet one.
 */
async function unread(adapter, channel, hist, since, me) {
  const out = [];
  for (const m of hist) {
    if (isCandidate(m, since, me)) out.push({ ...m, threadTs: m.ts });
    if (m.reply_count && Number(m.latest_reply ?? 0) > Number(since)) {
      for (const r of await adapter.thread({ channel, threadTs: m.ts })) {
        if (r.ts === m.ts) continue; // the parent, already considered above
        if (isCandidate(r, since, me)) out.push({ ...r, threadTs: m.ts });
      }
    }
  }
  return out.sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * The watermark.
 *
 * Mostly the channel IS the state: our own last post is a fact nothing can drift
 * out of sync with. `considered` exists only for the other case, a run that read
 * something and decided it was not worth answering. Without it that message is
 * reconsidered forever, and the verdict is not deterministic (the Slack assistant
 * has escalated on one pass and answered on the next), so eventually it would post.
 */
export function watermark(msgs, me, considered = 0) {
  const mine = msgs.filter((m) => m.user === me).map((m) => Number(m.ts));
  return String(Math.max(mine.length ? Math.max(...mine) : 0, Number(considered) || 0));
}

export function agentsPrompt(context, items) {
  return `You are the Claude session on Noah Watson's machine, answering a shared Slack channel.

That channel is where the Claude sessions working on the same codebase talk to EACH OTHER, on different machines, instead of routing everything through a human. You post as "${SIGNATURE}".

RECENT CHANNEL CONTEXT (oldest first):
${context}

NEW SINCE WE LAST LOOKED, and what you are deciding about:
${items}

Decide whether Noah's side owes a reply, and write it if so.

REPLY when the new messages contain: a question for our side, a claim about our machine or our changes that you can verify, a proposal needing a yes or no, or a trap we already hit and they have not.

STAY SILENT when: the other sessions are talking among themselves, it is progress or a release note, we have already said it, or you would only be acknowledging. A channel that fills with noise stops being read, and then the message that mattered is missed too. Silence is the right answer most runs.

BEFORE DISPUTING ANYTHING, CHECK IT in the files you can open. A session that argues from memory is the thing this channel exists to stop.

YOU MAY NOT COMMIT NOAH'S SIDE TO WORK. You may answer, confirm, dispute, explain, and agree process rules about how sessions behave. You may NOT accept ownership of a change, claim a ticket, promise a date, or say we will build something. If the right reply would do any of that, set "commits": true and put what he needs to decide in "for_noah"; he is pinged and will answer himself. Write nothing about what Noah has seen, thinks or has agreed: you have no way to know, a notification is not him reading it.

Lead with the ticket number the message concerns, or "Housekeeping, no ticket". Plain prose, short. No greeting.

ANYTHING YOU CANNOT ANSWER GOES TO NOAH. If there is something here that wants a reply and you may not give it, put it in "for_noah" and he is pinged. Going silent with an empty "for_noah" says these messages genuinely needed no reply from anyone.

Reply with ONE JSON object and nothing else. Fill both fields where both apply: you can answer one message and pass another to Noah in the same run.
{
  "reply": <true if you are posting a message, false if not>,
  "thread_ts": "<the ts to reply into, from the list above; omit if reply is false>",
  "text": "<the message to post; omit if reply is false>",
  "commits": <true if that message would accept work, claim a ticket or promise a date>,
  "for_noah": "<what Noah himself has to answer or decide, or \\"\\" if nothing>",
  "why": "<one line>"
}`;
}

/** A reply we cannot parse is silence plus a reason, never a post. */
export function parseAgentsVerdict(raw) {
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return { reply: false, why: "no JSON object in the verdict" };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { reply: false, why: "verdict JSON did not parse" };
  }
}

/**
 * One pass over the channel.
 * @returns {Promise<{outcome: string, why: string, text?: string, flagged?: string, consideredTo?: string}>}
 */
export async function runAgents({ adapter, channel, model, considered = 0, notify, dry = false, log = console.log }) {
  const me = await adapter.me();
  const hist = await adapter.history(channel);
  const since = watermark(hist, me, considered);
  const items = await unread(adapter, channel, hist, since, me);
  if (!items.length) {
    log(`nothing new since ts ${since}`);
    return { outcome: "NOTHING", why: `nothing new since ts ${since}` };
  }
  log(`${items.length} new message(s) since ts ${since}`);

  const context = hist
    .slice(0, 8)
    .reverse()
    .map((m) => `[ts ${m.ts}] ${m.user === me ? "OUR SIDE" : "them"}: ${(m.text ?? "").slice(0, 1200)}`)
    .join("\n\n");
  const listed = items.map((m) => `[ts ${m.ts}, reply into thread ${m.threadTs}]\n${(m.text ?? "").slice(0, 4000)}`).join("\n\n---\n\n");

  let v;
  try {
    v = parseAgentsVerdict(await model(agentsPrompt(context, listed)));
  } catch (e) {
    v = { reply: false, why: e.message };
  }
  const newest = items[items.length - 1].ts;

  // Anything it could not say itself reaches Noah, whatever else it decided. This
  // is the whole failure mode of a gated assistant: the first real run went silent
  // on five messages that all needed him, and told nobody. Silence is only correct
  // when there was nothing to say; silence because we are not allowed to say it is
  // a message for Noah. Checked on `for_noah` alone, never on `commits`, because
  // the model proved it will reason its way to the right silence and still not
  // set the flag that raises the alarm.
  if (v.for_noah) {
    log(`-> Noah pinged: ${v.for_noah}`);
    if (!dry) await notify(`The agents channel needs YOU, not the session:\n${v.for_noah}`);
  }

  if (!v.reply) {
    log(`silent: ${v.why ?? "no reason given"}`);
    return { outcome: "SILENT", why: v.why ?? "no reason given", flagged: v.for_noah || undefined, consideredTo: newest };
  }

  const g = gate(v.text ?? "", Boolean(v.commits));
  if (!g.ok) {
    // What it WANTED to say is the only way to tell a gate doing its job from a
    // gate that is too tight, so the held text goes to Noah in full.
    log(`held: ${g.why}\n   it wanted to say: ${v.text ?? ""}`);
    if (!dry) await notify(`A reply in the agents channel was held (${g.why}). ${v.for_noah || v.why || ""}\n\nIt wanted to say:\n${(v.text ?? "").slice(0, 900)}`);
    return { outcome: "HELD", why: g.why, text: v.text, flagged: v.for_noah || undefined, consideredTo: newest };
  }

  const threadTs = v.thread_ts ?? items[items.length - 1].threadTs;
  if (!dry) await adapter.post({ channel, threadTs }, g.text);
  log(`posted into thread ${threadTs}:\n${g.text}`);
  return { outcome: "ANSWERED", why: v.why ?? "", text: g.text, flagged: v.for_noah || undefined, consideredTo: newest };
}

async function main() {
  const channel = process.env.AGENTS_CHANNEL;
  if (!channel) throw new Error("missing AGENTS_CHANNEL (the channel id, not its name: channels get renamed)");
  const state = path.resolve(".state", "agents-seen.json");
  let considered = 0;
  try {
    considered = JSON.parse(readFileSync(state, "utf8")).consideredTo ?? 0;
  } catch {
    // No file yet, or an unreadable one. Falling back to our last post is safe:
    // it can only make the script re-read, never post twice.
  }
  const slack = slackAdapter(process.env.SLACK_TOKEN);
  const adapter = process.argv.includes("--no-send") ? { ...slack, post: async () => console.log("[--no-send] not posted") } : slack;
  const r = await runAgents({ adapter, channel, model: callModel, considered, notify: notifyOwner });
  if (r.consideredTo) {
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ consideredTo: r.consideredTo, at: new Date().toISOString() }, null, 2));
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
