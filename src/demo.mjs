// Runs both assistants over example/messages.json: the real decision code and
// the real send gates, with Slack swapped for the file and the model swapped for
// the verdict recorded on each example. No token, no network.
//
//   npm run demo            recorded verdicts
//   npm run demo -- --live  ask the real model instead (claude CLI or ANTHROPIC_API_KEY)

import { readFileSync } from "node:fs";
import path from "node:path";
import { runSlack } from "./answer-slack.mjs";
import { runAgents } from "./answer-agents.mjs";
import { addressOf } from "./answer-slack-core.mjs";
import { callModel } from "./model.mjs";

export async function runDemo(data, { live = false, log = console.log } = {}) {
  const now = Date.parse(data.now);
  const sent = [];
  const told = [];
  const notify = async (text) => {
    told.push(text);
    log(`          [to Noah] ${text.replace(/\n/g, "\n                    ")}`);
  };

  log(`== Slack assistant: ${data.slack.asks.length} open asks, Noah shows as "${data.slack.presence.presence}" ==\n`);
  const asks = data.slack.asks;
  const slack = await runSlack({
    asks,
    now,
    events: structuredClone(data.slack.events),
    notify,
    log,
    model: live ? callModel : async (_prompt, item) => JSON.stringify(item.model),
    adapter: {
      presence: async () => data.slack.presence,
      thread: async (addr) => asks.find((a) => addressOf(a.source_url)?.threadTs === addr.threadTs)?.thread ?? [],
      post: async (addr, text) => sent.push({ channel: addr.channel, threadTs: addr.threadTs, text }),
    },
  });

  const agents = [];
  for (const run of data.agents.runs) {
    log(`\n== Agents channel: ${run.about} ==`);
    agents.push(
      await runAgents({
        channel: data.agents.channel,
        notify,
        log,
        model: live ? callModel : async () => JSON.stringify(run.model),
        adapter: {
          me: async () => data.agents.me,
          history: async () => run.history,
          thread: async () => [],
          post: async (addr, text) => sent.push({ channel: addr.channel, threadTs: addr.threadTs, text }),
        },
      }),
    );
  }
  return { slack, agents, sent, told };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const file = new URL("../example/messages.json", import.meta.url);
  const r = await runDemo(JSON.parse(readFileSync(file, "utf8")), { live: process.argv.includes("--live") });
  console.log(`\n${r.sent.length} message(s) posted to Slack, ${r.told.length} ping(s) to Noah.`);
}
