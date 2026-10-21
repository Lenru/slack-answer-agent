/**
 * Answers Jordan's sessions in Slack #agents, unprompted.
 *
 * The channel exists so the Claude sessions on both machines correct each other
 * without Jordan relaying. That only works if both sides speak without a human
 * opening a chat first, which is the half Noah's machine was missing: agents.py
 * can read and post, but nothing ran it. Scheduled as NoahOS-AnswerAgents.
 *
 * SHAPE BORROWED FROM answer-slack.mts, deliberately, including its two scars:
 * `claude -p` reporting "Not logged in" while exiting 0 under a task token, and
 * a message shape that bypassed the gate being the one that went wrong. Every
 * outbound here goes through gate() with no exceptions.
 *
 * WHAT IT MAY NOT DO (Noah, 2026-09-25): accept ownership of work or claim a D
 * row. Those put real hours on his plate and are visible to Jordan as a promise.
 * The model declares `commits` and there is a phrase backstop behind it; either
 * one trips and the answer is held and Noah is pinged instead.
 *
 * KNOWN CEILING, same as answer-slack: `claude -p` runs on Noah's subscription,
 * so this only thinks while his PC is on and logged in. There is no API key here.
 *
 * Usage: node --import tsx --env-file=.env.local brain/answer-agents.mts [--no-send]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { notifyDiscord } from "./notify.mjs";
import { insertOpsEvent } from "./events.mjs";
import { SIGNATURE, gate, isCandidate } from "./answer-agents-core.mjs";

// Every `claude -p` this process spawns must run on Noah's SUBSCRIPTION, not on
// the API. These entry points are started with `node --env-file=.env.local`, which
// loads ANTHROPIC_API_KEY (the hub's Ask needs it, nothing here does), and a
// spawned claude.exe inherits it and bills the API: $2 to $4 per headless session.
// That is what emptied the $5 API limit on 2026-09-25 in about two days. Deleting
// it here covers every spawn in this process, children included.
delete process.env.ANTHROPIC_API_KEY;
// Headless: skip Noah's CLAUDE.md files (rules for live chats, ~44k tokens a call). Auth, MCP, tools unaffected.
process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";

const NO_SEND = process.argv.includes("--no-send");
const CHANNEL = "C00000000A2"; // #agents, BY ID: agents.py notes a channel in
                               // this workspace was renamed twice in one morning.
const AGENTS_PY = "C:\\Community\\scripts\\agents.py";
const STATE = path.join(import.meta.dirname, "out", "agents-seen.json");

/**
 * The ledger. Every run writes what it decided to ops.events, which is what
 * /hub/desk/log renders, so "what has it been saying in there" is answerable
 * without opening Slack or reading a log file on this machine.
 *
 * Missing env is not fatal here, unlike answer-slack: this script's job is to
 * answer the channel, and losing the audit trail is not a reason to go quiet.
 * insertOpsEvent already swallows its own failures for the same reason.
 */
const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = sbUrl && sbKey
  ? createClient(sbUrl, sbKey, { auth: { persistSession: false }, db: { schema: "ops" } })
  : null;

/** One row on /hub/desk/log. `run` groups a run's rows into one thread there. */
async function log(run: string, action: string, outcome: string, why: string, payload: Record<string, unknown> = {}) {
  if (!sb) return;
  await insertOpsEvent(sb, {
    actor: "assistant",
    action,
    target: "#agents",
    outcome,
    why,
    correlation_id: run,
    payload,
  });
}

/** The token agents.py uses. Same path on purpose: one token, one place to rotate. */
function token(): string {
  const cfg = JSON.parse(readFileSync(path.join(homedir(), ".claude.json"), "utf8"));
  const t = cfg?.mcpServers?.["community-slack"]?.env?.SLACK_TOKEN;
  if (!t) throw new Error("no SLACK_TOKEN in ~/.claude.json (mcpServers.community-slack)");
  return t;
}

/**
 * Slack read methods must be FORM-ENCODED. conversations.history and .replies
 * answer a JSON body with invalid_arguments and an empty result, which is
 * indistinguishable from a quiet channel; only chat.* takes JSON. That one
 * content type silently emptied every thread for five days in September.
 */
async function slackGet(method: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const out = await res.json();
  if (!out.ok) throw new Error(`slack ${method}: ${out.error}`);
  return out;
}

type Msg = { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number; latest_reply?: string; subtype?: string };


/**
 * Everything said since we last looked, flattened, oldest first.
 *
 * Thread replies are included because the channel's asks increasingly land in
 * them (Jordan's 25/09 post asks for a thread reply by name) and agents.py's own
 * reader cannot see them — that is the gap T-113 is fixing on his side. Only
 * threads whose latest reply is newer than the watermark are fetched, so this
 * is one extra call on a busy day and none on a quiet one.
 */
async function unread(since: string, me: string) {
  const hist = await slackGet("conversations.history", { channel: CHANNEL, limit: "30" });
  const msgs: Msg[] = hist.messages ?? [];
  const out: (Msg & { threadTs: string })[] = [];

  for (const m of msgs) {
    if (isCandidate(m, since, me)) out.push({ ...m, threadTs: m.ts });
    if (m.reply_count && Number(m.latest_reply ?? 0) > Number(since)) {
      const t = await slackGet("conversations.replies", { channel: CHANNEL, ts: m.ts, limit: "50" });
      for (const r of (t.messages ?? []) as Msg[]) {
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
 * out of sync with. The file exists only for the other case — a run that read
 * something and decided it was not worth answering. Without it that message is
 * reconsidered forever, and the verdict is not deterministic (answer-slack has
 * escalated on one pass and answered on the next), so eventually it would post.
 */
function watermark(msgs: Msg[], me: string): string {
  const mine = msgs.filter((m) => m.user === me).map((m) => Number(m.ts));
  const lastPost = mine.length ? Math.max(...mine) : 0;
  let considered = 0;
  try {
    considered = Number(JSON.parse(readFileSync(STATE, "utf8")).consideredTo ?? 0);
  } catch {
    // No file yet, or an unreadable one. Falling back to our last post is safe:
    // it can only make the script re-read, never post twice.
  }
  return String(Math.max(lastPost, considered));
}

function remember(ts: string) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ consideredTo: ts, at: new Date().toISOString() }, null, 2));
}

type Verdict = { reply: boolean; thread_ts?: string; text?: string; commits?: boolean; why?: string; for_noah?: string };

function ask(context: string, items: string): Verdict {
  const prompt = `You are the Claude session on Noah Watson's machine, answering Slack #agents.

That channel is where the Claude sessions working on the Community codebase talk to EACH OTHER, on different machines, instead of routing everything through Jordan Lee. Jordan's sessions post as "TeamBot on behalf of Jordan Lee". You post as "${SIGNATURE}".

RECENT CHANNEL CONTEXT (oldest first):
${context}

NEW SINCE WE LAST LOOKED, and what you are deciding about:
${items}

Decide whether Noah's side owes a reply, and write it if so.

REPLY when the new messages contain: a question for our side, a claim about our machine or our changes that you can verify, a proposal needing a yes or no, or a trap we already hit and they have not.

STAY SILENT when: it is Jordan's sessions talking among themselves, it is progress or a release note, we have already said it, or you would only be acknowledging. A channel that fills with noise stops being read, and then the message that mattered is missed too. Silence is the right answer most runs.

BEFORE DISPUTING ANYTHING, TEST IT ON THIS MACHINE. You have the repo and a shell. Run the command, open the file, reproduce the failure. Then post the error, the cause, the fix, in that order. A session that argues from memory is the thing this channel exists to stop. The repo is C:\\Community and Noah's dashboard is C:\\Users\\me\\Desktop\\noah-os-dashboard.

YOU MAY NOT COMMIT NOAH'S SIDE TO WORK. You may answer, confirm, dispute, explain, and agree process rules about how sessions behave. You may NOT accept ownership of a change, claim a ticket, promise a date, or say we will build something. If the right reply would do any of that, set "commits": true and put what he needs to decide in "for_noah" — he is pinged and will answer himself. Write nothing about what Noah has seen, thinks or has agreed: you have no way to know, a notification is not him reading it.

Lead with the ticket number the message concerns, or "SOP housekeeping, no ticket number". Plain prose, short. No greeting.

ANYTHING YOU CANNOT ANSWER GOES TO NOAH. If there is something here that wants a reply and you may not give it, put it in "for_noah" and he is pinged. Going silent with an empty "for_noah" says these messages genuinely needed no reply from anyone. Do not use it to mean "this one is above my pay grade": that is exactly the case he has to hear about.

Reply with ONE JSON object and nothing else. Fill both fields where both apply: you can answer one message and pass another to Noah in the same run.
{
  "reply": <true if you are posting a message, false if not>,
  "thread_ts": "<the ts to reply into, from the list above; omit if reply is false>",
  "text": "<the message to post; omit if reply is false>",
  "commits": <true if that message would accept work, claim a row or promise a date>,
  "for_noah": "<what Noah himself has to answer or decide, or \"\" if nothing>",
  "why": "<one line>"
}`;

  const r = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
    encoding: "utf8",
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return { reply: false, why: `claude -p failed: ${(r.stderr || "no output").slice(0, 200)}` };
  // The 2026-07-07 tripwire: under a task token claude returns "Not logged in"
  // while reporting success, which is how NewsRadar died silently for weeks.
  if (/Not logged in|Please run \/login/.test(r.stdout)) return { reply: false, why: "claude -p is not logged in" };

  let outer: { result?: string; is_error?: boolean };
  try {
    outer = JSON.parse(r.stdout);
  } catch {
    return { reply: false, why: "claude -p output was not JSON" };
  }
  if (outer.is_error) return { reply: false, why: "claude -p reported is_error" };

  const m = (outer.result ?? "").match(/\{[\s\S]*\}/);
  if (!m) return { reply: false, why: "no JSON object in the verdict" };
  try {
    return JSON.parse(m[0]) as Verdict;
  } catch {
    return { reply: false, why: "verdict JSON did not parse" };
  }
}

/** Posts through agents.py, which is Jordan's sanctioned path and stays his to change. */
function post(text: string, threadTs: string) {
  if (NO_SEND) {
    console.log(`\n[--no-send] would have posted into thread ${threadTs}:\n${text}\n`);
    return;
  }
  const args = [AGENTS_PY, "post", text];
  if (threadTs) args.push("--thread", threadTs);
  const r = spawnSync("python", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`agents.py post: ${r.stderr || r.stdout}`);
  console.log(r.stdout.trim());
}

async function main() {
  const me = (await slackGet("auth.test", {})).user_id as string;
  const hist: Msg[] = (await slackGet("conversations.history", { channel: CHANNEL, limit: "30" })).messages ?? [];
  const since = watermark(hist, me);
  const items = await unread(since, me);

  if (!items.length) {
    console.log(`nothing new since ts ${since}`);
    return;
  }
  console.log(`${items.length} new message(s) since ts ${since}`);

  const context = hist
    .slice(0, 8)
    .reverse()
    .map((m) => `[ts ${m.ts}] ${m.user === me ? "OUR SIDE" : "them"}: ${(m.text ?? "").slice(0, 1200)}`)
    .join("\n\n");
  const listed = items
    .map((m) => `[ts ${m.ts}, reply into thread ${m.threadTs}]\n${(m.text ?? "").slice(0, 4000)}`)
    .join("\n\n---\n\n");

  const v = ask(context, listed);
  const newest = items[items.length - 1].ts;
  // One run, one thread on /hub/desk/log. The newest ts read is a natural id: it
  // is unique per run and it says which message the run was about.
  const run = `agents-${newest}`;
  await log(run, "agents.read", "ok", `${items.length} new message(s) in #agents`, {
    from: items.map((m) => ({ ts: m.ts, preview: (m.text ?? "").slice(0, 300) })),
  });

  // Anything it could not say itself reaches Noah, whatever else it decided. This
  // is the whole failure mode of a gated assistant: the first dry run went silent
  // on five messages that all needed him, and told nobody. Silence is only correct
  // when there was nothing to say; silence because we are not allowed to say it is
  // a message for Noah. Checked on `for_noah` alone, never on `commits`, because
  // the model proved it will reason its way to the right silence and still not
  // set the flag that raises the alarm.
  if (v.for_noah) {
    console.log(`-> Noah pinged: ${v.for_noah}`);
    await notifyDiscord(`#agents needs YOU, not the session:
${v.for_noah}`, process.env.DISCORD_COMMUNITY_SLACK_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL, { mention: true });
    await log(run, "agents.flag", "blocked", v.for_noah, { text: v.for_noah });
  } else {
    console.log("-> nothing flagged to Noah");
  }

  if (!v.reply) {
    console.log(`silent: ${v.why ?? "no reason given"}`);
    await log(run, "agents.silent", "skipped", v.why ?? "no reason given");
    remember(newest);
    return;
  }

  const g = gate(v.text ?? "", Boolean(v.commits));
  if (!g.ok) {
    console.log(`held: ${g.why}`);
    // The held text is logged in full. What it WANTED to say is the only way to
    // tell a gate doing its job from a gate that is too tight.
    await log(run, "agents.hold", "blocked", g.why ?? "held", { text: v.text ?? "", commits: Boolean(v.commits) });
    await notifyDiscord(
      `#agents: a reply was held (${g.why}). ${v.for_noah ?? v.why ?? ""}\n\nIt wanted to say:\n${(v.text ?? "").slice(0, 900)}`,
      process.env.DISCORD_COMMUNITY_SLACK_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL,
      { mention: true },
    );
    remember(newest);
    return;
  }

  const threadTs = v.thread_ts ?? items[items.length - 1].threadTs;
  post(g.text!, threadTs);
  await log(run, "agents.answer", NO_SEND ? "skipped" : "ok", v.why ?? "replied in #agents", {
    text: g.text,
    thread_ts: threadTs,
    dry_run: NO_SEND,
  });
  remember(newest);
}

if (!existsSync(AGENTS_PY)) {
  // Not an error worth waking anyone for: this machine simply has no Community checkout.
  console.log(`${AGENTS_PY} not found, nothing to do`);
} else if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
