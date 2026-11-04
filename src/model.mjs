// One model call, two ways to make it: the Anthropic API when ANTHROPIC_API_KEY
// is set, otherwise the logged-in `claude` CLI. Returns the model's text, or
// throws. Callers turn a throw into an escalation, never into a send.

import { spawnSync } from "node:child_process";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

export async function callModel(prompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    // shortcut: the API path has no tools, so it can only answer from the thread
    // in the prompt and will escalate most real asks. Add a read tool to upgrade.
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  // Prompt on stdin, not argv: Slack text is arbitrary and cmd.exe would read its
  // "<" and ">" as redirection. Read-only by flag, not only by prompt: `--tools`
  // limits the session to tools that cannot change anything, so the model can
  // open files to cite them and cannot write or run a thing.
  // (`--allowedTools ""` turns NOTHING off; `--tools` is the flag that does.)
  const res = spawnSync("claude", ["-p", "--output-format", "json", "--tools", "Read,Grep,Glob", "--strict-mcp-config"], {
    input: prompt,
    encoding: "utf8",
    cwd: process.env.KNOWLEDGE_DIR || process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300000,
  });
  if (res.status !== 0 || !res.stdout) throw new Error(`claude -p failed: ${(res.stderr || "no output").slice(0, 200)}`);
  // Under a scheduled task with the wrong principal, claude returns "Not logged
  // in" while exiting 0. That must escalate, not send.
  if (/Not logged in|Please run \/login/.test(res.stdout)) throw new Error("claude -p is not logged in");
  let outer;
  try {
    outer = JSON.parse(res.stdout);
  } catch {
    throw new Error("claude -p output was not JSON");
  }
  if (outer.is_error) throw new Error("claude -p reported is_error");
  return outer.result ?? "";
}
