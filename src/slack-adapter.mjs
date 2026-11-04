// The only file that talks to Slack. Both runners take an adapter with this
// shape, so the demo can swap in example/messages.json and nothing else changes:
//
//   me()                      -> our own user id
//   presence()                -> users.getPresence for the token's owner
//   thread({channel, threadTs})  -> messages in that thread, oldest first
//   history(channel)          -> recent channel messages, newest first
//   post({channel, threadTs}, text)

/**
 * Call the Slack Web API.
 *
 * READ METHODS MUST BE FORM-ENCODED. chat.postMessage accepts a JSON body, most
 * of the rest do not: conversations.replies answers a JSON body with
 * `invalid_arguments` and no explanation. Sending JSON to everything made every
 * thread read come back empty, which silently cost three things at once: the
 * model got a truncated title instead of the real message, the "someone already
 * replied" guard never fired, and the asker was never identified.
 */
async function call(token, method, params) {
  const json = method.startsWith("chat.");
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": json
        ? "application/json; charset=utf-8"
        : "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: json
      ? JSON.stringify(params)
      : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  return res.json();
}

function must(r, method) {
  if (!r.ok) throw new Error(`slack ${method}: ${r.error ?? "unknown error"}`);
  return r;
}

export function slackAdapter(token) {
  if (!token) throw new Error("missing SLACK_TOKEN");
  return {
    me: async () => must(await call(token, "auth.test", {}), "auth.test").user_id,
    // Not checked here: an unreadable presence is a decision for waitForNoah(),
    // which treats it as "wait".
    presence: () => call(token, "users.getPresence", {}),
    async thread(addr) {
      const r = await call(token, "conversations.replies", { channel: addr.channel, ts: addr.threadTs, limit: 40 });
      // ONLY "this message has no thread" is an empty thread. Everything else is a
      // fault and has to be loud. Returning [] for any error is how the
      // content-type bug above hid: a catch-all that returns a valid-looking empty
      // value cannot be debugged from its output.
      if (!r.ok && r.error === "thread_not_found") return [];
      return must(r, "conversations.replies").messages ?? [];
    },
    history: async (channel) =>
      must(await call(token, "conversations.history", { channel, limit: 30 }), "conversations.history").messages ?? [],
    async post(addr, text) {
      must(await call(token, "chat.postMessage", { channel: addr.channel, thread_ts: addr.threadTs, text }), "chat.postMessage");
    },
  };
}

/**
 * Tell Noah. Posts to OWNER_WEBHOOK_URL (Discord and Slack incoming webhooks
 * both accept this body) or prints when there is none.
 */
export async function notifyOwner(text) {
  const url = process.env.OWNER_WEBHOOK_URL;
  if (!url) return console.log(`      [owner] ${text.replace(/\n/g, "\n              ")}`);
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }) });
}
