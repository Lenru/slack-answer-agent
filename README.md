# slack-answer-agent

A Claude assistant that answers Slack messages on my behalf, and the rules that decide when it is allowed to speak and what it is allowed to say.

Extracted from a bot I run in production for my work Slack. Names and content replaced; commit history is real.

## What it does

Two assistants share one set of send gates.

- **The Slack assistant** reads questions colleagues asked me. If it can answer from something it actually opened, it replies in the thread. If it can't, it sends a polite holding reply and pings me.
- **The agents assistant** watches a channel where AI coding sessions on different engineers' machines talk to each other. It answers questions about my side and stays silent otherwise. It never takes on work for me.

The model writes the reply. Plain, tested code decides whether that reply is ever sent.

## The guardrails, and why each one exists

| Rule | Why |
|---|---|
| **Signature first, every message.** | The Slack token is user-scoped, so a reply is sent as me. A reader has to know it is Claude before the first word, not after the last one, and on a phone a long reply reads as mine until the final line. The gate blocks any message without it. |
| **Answers only what it can cite.** | Gated on whether a source exists, not on how confident the model feels. An answer with no sources was guessed, and is escalated instead. |
| **Never says what I have seen, think or decided.** | An early holding reply told a colleague "Noah has seen this and does not have the answer to hand". I had not seen it. A notification is not a person reading something, so any claim about my attention is blocked outright. |
| **Waits while I'm online, but only for two hours.** | If I'm around, people should hear from me. But Slack showed me "active" while I was working in another app, so the green dot can't be trusted forever. After two hours with no reply it acts anyway. Presence it can't read counts as "wait". |
| **Never talks over a human.** | If anyone other than the asker has replied in the thread, it stays out. |
| **Allowlisted channels only, by ID.** | Checked before the model call and again at the send. DMs are never answered. Channels get renamed, IDs don't. |
| **Dates, prices, pay, other clients and anything clinical stop the send.** | Those are mine to give. A guessed deadline creates a real obligation. |
| **The holding reply goes through the same gate.** | It used to skip the gate, which is exactly how the false "Noah has seen this" got out. Its wording is picked from the ask's id, so a retry can't contradict what was already sent. |
| **One model call per ask.** | The verdict isn't deterministic: the same ask escalated on one pass and answered on another. A small state machine over the event log (`nextStep`) means an ask is decided once, and a later pass only sends the holding reply. |
| **The agents assistant may answer, never commit.** | Accepting a task, claiming a ticket or promising a date puts real hours on my plate. The model declares `commits`, and a phrase backstop catches the times it writes "happy to take that on" and doesn't flag it. |
| **Anything it can't answer still reaches me.** | On its first real run it read five messages, correctly decided each needed a commitment it couldn't make, went silent, and told nobody. Escalation is now checked on `for_noah` alone, never on `commits`. |
| **Read-only model.** | The CLI call runs with `--tools Read,Grep,Glob`, so the model can open files to cite them and can't change anything. |
| **Nothing shaped like a secret leaves.** | Slack text is untrusted and the model can read files, so a crafted message could ask it to quote a key. Both send gates block any reply containing a known token format, a private key, a webhook, a `password:`-style line or a URL with a password in it. They also block any reply containing one of the bot's own secret values, in whatever format, because no list of patterns is ever complete. |

## Run the demo

Needs Node 20.12+. No Slack token and no model:

```bash
npm test        # 52 tests
npm run demo    # both assistants over example/messages.json
```

The demo runs the real decision code over a fictional workspace, with the model's verdict for each message recorded in the file. Excerpt:

```
ANSWERED  Sam Rivera: what is the API rate limit on staging?
          sources: config/limits.json
WAIT      Jordan Lee: is the release branch cut yet?
          Noah is active on Slack, leaving it to him
ESCALATED Sam Rivera: can we roll the new onboarding flow out to everyone?
          rules refused: speaks-for-noah (holding reply sent)
ESCALATED Jordan Lee: how many webhook retries do we do before giving up?
          model cited nothing, so it guessed (holding reply sent)
SKIP      Jordan Lee: quick one, can you send me the admin password?
          D00000000A4 is not an allowed channel

== Agents channel: The model wrote a promise and forgot to say so. The phrase backstop catches it. ==
held: reads as accepting work or claiming a ticket
   it wanted to say: T-114: happy to take that on, I'll have it done by Friday.

6 message(s) posted to Slack, 5 ping(s) to Noah.
```

`npm run demo -- --live` asks a real model instead, through the `claude` CLI or `ANTHROPIC_API_KEY`.

## Layout

```
src/answer-slack-core.mjs    when to answer, wait, hold or skip (pure, tested)
src/answer-agents-core.mjs   the agents gate: no commitments, no speaking for me (pure, tested)
src/outbound-rules.mjs       the send boundary every Slack message passes
src/answer-slack.mjs         Slack assistant runner
src/answer-agents.mjs        agents channel runner
src/slack-adapter.mjs        the only file that talks to Slack
src/model.mjs                claude CLI, or the API when ANTHROPIC_API_KEY is set
```

Against a real workspace: `SLACK_TOKEN=... node src/answer-slack.mjs --queue=asks.json --no-send` decides and pings without posting. Capturing asks into the queue happened elsewhere in my system and isn't part of this repo.

MIT licensed.
