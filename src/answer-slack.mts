// Answer Slack. The assistant's MOUTH, and the first thing on this machine that
// has one.
//
// Run (env loaded, TS stripped by tsx, same as executor.mts):
//   node --import tsx --env-file=.env.local brain/answer-slack.mts --dry
//   node --import tsx --env-file=.env.local brain/answer-slack.mts
//
// Noah's mandate, 2026-09-09 and again 2026-09-14: answer Jordan and Sam
// directly when we have the information, say plainly that it is Claude replying,
// tell him afterwards, and when there is no answer say politely that we will come
// back to them and notify him. the client is not on this path.
//
// WHERE THIS SITS. Capture already worked: Slack webhook -> hub.slack_capture ->
// ops.tasks. This is the other half. It changes nothing about capture and adds no
// new store; the desk row IS the queue.
//
// WHY IT CLOSES ITSELF. The Slack app is installed with USER scopes, so a message
// sent here is sent AS Noah. The events webhook already treats a message from Noah
// in a conversation as "that ask is handled" and closes the desk row. So sending
// the reply closes the item with no second code path, no flag and no timer. That
// is also why the signature line is not decoration: without it, a reader cannot
// tell Noah typed it from Claude typing it, and checkOutbound BLOCKS on its
// absence rather than adding it for us.
//
// TWO GATES, NEITHER OF THEM CONFIDENCE.
//   parseVerdict() refuses a reply that cites nothing, because an uncited answer
//   was guessed. checkOutbound() then refuses on sources, on the signature, on the
//   Clinic lane, and flags commitments, private matters and anything clinical. A
//   flag is an escalation, not a warning: `allowed` has to be true to send.
//
// KNOWN CEILING, deliberate. `claude -p` runs on Noah's subscription, which means
// this only answers while his PC is on and logged in. That is not 24/7 and cannot
// be made so from here: there is no ANTHROPIC_API_KEY on this machine and the
// hosted hub carries no model and no service-role key. Moving the decider off the
// desk is a separate build. Until then the holding reply is what covers the hours
// the machine is off, and it is late rather than absent.
// ponytail: one process, no locking. If two ever run at once the desk row is the
// only shared state and a double send is possible; claim the row first if that
// becomes real.

import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { checkOutbound } from "../src/lib/desk-rules";
import { insertOpsEvent } from "./events.mjs";
import { notifyDiscord } from "./notify.mjs";
import {
  addressOf,
  eligible,
  holdText,
  nextStep,
  parseVerdict,
  shouldHold,
  signed,
} from "./answer-slack-core.mjs";

const DRY = process.argv.includes("--dry");
// Everything except the Slack send: still decides, still logs, still pings Noah.
// This is the mode that works while chat:write is missing from the token, and it
// delivers the half of the mandate that never needed Slack ("notify me"). Drop the
// flag the day the scope lands.
const NO_SEND = process.argv.includes("--no-send");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? 5);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const slackToken = process.env.SLACK_USER_TOKEN;
if (!url || !key) {
  console.error("missing supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(2);
}
if (!slackToken) {
  console.error("missing SLACK_USER_TOKEN. Run: node scripts/slack-setup.mjs --check");
  process.exit(2);
}
const sb = createClient(url, key, { auth: { persistSession: false }, db: { schema: "ops" } });

type SlackMsg = { ts: string; user?: string; text?: string; bot_id?: string };

/** What this has already done, read from ops.events. nextStep() reads it. */
type PriorEvent = { target: string; action: string; payload: { held?: boolean } | null };
const PRIOR: PriorEvent[] = [];

type DeskRow = {
  id: string;
  title: string;
  asked_by: string | null;
  source_url: string | null;
  created_at: string;
  notes: string | null;
};

async function slack(method: string, params: Record<string, unknown>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });
  return (await res.json()) as { ok: boolean; error?: string; messages?: SlackMsg[] };
}

/** The conversation around the ask, so the model answers the actual question. */
async function threadOf(addr: { channel: string; threadTs: string }) {
  const r = await slack("conversations.replies", {
    channel: addr.channel,
    ts: addr.threadTs,
    limit: 40,
  });
  // A plain channel message that was never threaded returns not_found or a single
  // message; either way an empty thread is a valid state, not a failure.
  if (!r.ok) {
    if (r.error === "missing_scope") throw new Error(`slack: missing_scope on conversations.replies`);
    return [];
  }
  return r.messages ?? [];
}

/**
 * Ask the local model. Read-only by contract, not by flag: the prompt is the guard,
 * the same way brain/shift.md guards the shift loop.
 *
 * It is told to answer ONLY from what it can open, and to escalate otherwise. The
 * sources it returns are checked, so "cite something" is not advice here.
 */
function decide(ask: string, thread: SlackMsg[], askedBy: string) {
  const transcript = thread
    .slice(-15)
    .map((m) => `${m.user ?? m.bot_id ?? "?"}: ${(m.text ?? "").slice(0, 600)}`)
    .join("\n");

  const prompt = `You are answering a Slack message on Noah Watson's behalf, in a company workspace. ${askedBy} is asking.

THE MESSAGE:
${ask}

THE THREAD (oldest first, may be empty):
${transcript || "(none)"}

Answer ONLY from what you can actually open and verify right now: this repo, the Supabase ops/hub schemas, the clients/ tree, the Obsidian vault, git history, the Community repos. You are READ-ONLY. Do not write files, do not run anything that changes state.

Escalate to Noah instead of answering when ANY of these is true:
- you cannot find the answer in a source you actually read
- answering means promising a date, a price, a scope or a commitment
- it touches Noah's pay, equity, rates, invoices or any Clinic/the client matter
- it is a decision that is Noah's to make, not a fact to look up
- it is clinical or about patients

Reply with ONE JSON object and nothing else:
{"escalate": false, "answer": "<what to say to ${askedBy}, plain and short, no greeting needed>", "sources": ["<file path, table, or URL you actually read>"], "why": "<one line>"}
or
{"escalate": true, "why": "<one line on what you would need>"}

A source must be something you opened. An empty sources list means you guessed, and the reply will be refused.`;

  const r = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
    encoding: "utf8",
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) {
    return { escalate: true as const, why: `claude -p failed: ${(r.stderr || "no output").slice(0, 200)}` };
  }
  // The 2026-07-07 tripwire: under a task token claude returns is_error "Not
  // logged in" while reporting success. That must escalate, not send.
  if (/Not logged in|Please run \/login/.test(r.stdout)) {
    return { escalate: true as const, why: "claude -p is not logged in" };
  }
  let outer: { result?: string; is_error?: boolean };
  try {
    outer = JSON.parse(r.stdout);
  } catch {
    return { escalate: true as const, why: "claude -p output was not JSON" };
  }
  if (outer.is_error) return { escalate: true as const, why: "claude -p reported is_error" };
  return parseVerdict(outer.result);
}

async function send(addr: { channel: string; threadTs: string }, text: string) {
  if (NO_SEND) {
    console.log(`      [--no-send] would have posted to ${addr.channel}`);
    return;
  }
  const r = await slack("chat.postMessage", {
    channel: addr.channel,
    thread_ts: addr.threadTs,
    text,
  });
  if (!r.ok) throw new Error(`slack chat.postMessage: ${r.error}`);
}

async function main() {
  const { data: items, error } = await sb
    .from("tasks")
    .select("id, title, asked_by, source_url, created_at, notes")
    .eq("source", "slack")
    .not("status", "in", "(done,cancelled)")
    .order("created_at", { ascending: true })
    .limit(LIMIT);
  if (error) {
    console.error("desk read failed:", error.message);
    process.exit(1);
  }
  if (!items?.length) {
    console.log("nothing waiting.");
    return;
  }

  // What we have already answered or escalated, so a heartbeat does not re-ping
  // Noah about Sam every two hours and never sends a second reply. ops.events is
  // the record, so this needs no new column and survives a restart.
  const { data: prior } = await sb
    .from("events")
    .select("target, action, payload")
    .in("action", ["slack.answer", "slack.escalate"])
    .in("target", items.map((i) => i.id));
  PRIOR.push(...((prior ?? []) as PriorEvent[]));

  const mode = DRY
    ? "  [DRY RUN, nothing sent, nothing logged]"
    : NO_SEND
      ? "  [NO-SEND, decides and pings Noah, posts nothing to Slack]"
      : "";
  console.log(`${items.length} open slack ask(s)${mode}\n`);

  for (const item of items) {
    const label = `${item.asked_by ?? "someone"}: ${String(item.title).slice(0, 60)}`;
    // One bad ask must not abort the rest. A dead channel, a revoked token or a
    // rate limit is per-item news, and the next person waiting should still get
    // an answer.
    try {
      await handle(item, label);
    } catch (e) {
      console.log(`ERROR ${label}\n      ${(e as Error).message}\n`);
      await insertOpsEvent(sb, {
        actor: "assistant",
        action: "slack.answer",
        target: item.id,
        outcome: "failure",
        why: (e as Error).message,
        payload: { to: item.asked_by, url: item.source_url },
      });
    }
  }
}

async function handle(item: DeskRow, label: string) {
  const addr = addressOf(item.source_url);
  if (!addr) {
    console.log(`SKIP  ${label}\n      no usable slack address\n`);
    return;
  }

  // Decided before any network or model spend, from what we already did to it.
  const plan = nextStep(item, PRIOR);
  if (plan.step === "skip") {
    console.log(`SKIP  ${label}\n      ${plan.why}\n`);
    return;
  }

  const thread = await threadOf(addr);
  const gate = eligible(item, thread);
  if (!gate.ok) {
    console.log(`SKIP  ${label}\n      ${gate.why}\n`);
    return;
  }

  // Escalated on an earlier pass, and the grace has now expired. No second model
  // call: it already said it cannot answer, and asking again costs a call and
  // invites a different verdict for no gain.
  if (plan.step === "hold") {
    await send(addr, holdText(item.asked_by));
    await insertOpsEvent(sb, {
      actor: "assistant",
      action: "slack.escalate",
      target: item.id,
      outcome: "skipped",
      why: plan.why,
      payload: { to: item.asked_by, held: true, url: item.source_url },
    });
    console.log(`HELD  ${label}\n      ${plan.why}\n`);
    return;
  }

  // Read the ask from SLACK, not from the desk row. askTitle() truncates at ~155
  // characters when it captures, so item.title is a label for a list and not the
  // question. On 2026-09-14 that cost a real verdict: the model was handed
  // "...did think about the second option, but the trade-of" and correctly refused a
  // message it could see was cut off mid-sentence. The full text is already in the
  // thread we just fetched, at the ask's own ts, so this costs no extra call.
  const full = thread.find((m) => m.ts === addr.ts)?.text?.trim();
  const ask = full && full.length > String(item.title).length ? full : String(item.title);
  // Printed because on 2026-09-14 the model called a complete 499-character
  // message "truncated mid-sentence" and it was not obvious from the outside
  // whether it had been handed the full text or the 155-character desk title.
  // One number settles that argument without another model call.
  console.log(`      ask: ${ask.length} chars (desk title holds ${String(item.title).length})`);
  const verdict = decide(ask, thread, item.asked_by ?? "a colleague");

  if (!verdict.escalate) {
    const text = signed(verdict.answer);
    const rules = checkOutbound({
      lane: "community",
      to: item.asked_by ?? "unknown",
      text,
      sources: verdict.sources,
    });
    if (rules.allowed) {
      if (DRY) {
        console.log(`WOULD ANSWER  ${label}\n      sources: ${verdict.sources.join(", ")}\n      ---\n${text}\n      ---\n`);
      } else {
        await send(addr, text);
        console.log(`ANSWERED  ${label}\n      sources: ${verdict.sources.join(", ")}\n`);
        await insertOpsEvent(sb, {
          actor: "assistant",
          action: "slack.answer",
          target: item.id,
          outcome: "success",
          why: verdict.why,
          payload: { to: item.asked_by, sources: verdict.sources, text },
        });
      }
      return;
    }
    // An answer the rules refuse becomes an escalation, and the reason is the
    // rule ids, so the Log says what it declined to say rather than only that
    // it declined.
    verdict.escalate = true;
    verdict.why = `rules refused: ${[...rules.blocked, ...rules.flagged].join(", ")}`;
  }

  // No answer. Hold the line politely if it has waited, and tell Noah either way.
  const hold = shouldHold(item);
  if (DRY) {
    console.log(`WOULD ESCALATE  ${label}\n      ${verdict.why}\n      ${hold ? "and would send the holding reply" : "too recent for a holding reply"}\n`);
    return;
  }
  if (hold) await send(addr, holdText(item.asked_by));
  await insertOpsEvent(sb, {
    actor: "assistant",
    action: "slack.escalate",
    target: item.id,
    outcome: "skipped",
    why: verdict.why,
    payload: { to: item.asked_by, held: hold, url: item.source_url },
  });
  await notifyDiscord(
    `[DESK] ${item.asked_by ?? "Someone"} needs you: ${String(item.title).slice(0, 180)}\n` +
      `Could not answer it: ${verdict.why}\n` +
      `${hold ? "Told them you would come back to them. " : ""}${item.source_url ?? ""}`,
  );
  console.log(`ESCALATED  ${label}\n      ${verdict.why}${hold ? "  (held)" : ""}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
