#!/usr/bin/env node
/**
 * Mesa + just-bash interactive CLI agent (LangChain)
 *
 * Connects to a Mesa repo via MesaFS, gives an AI agent bash access
 * to explore and work with the repo's files.
 *
 * Usage:
 *   npx tsx src/index.ts <org> <repo>
 *
 * Environment:
 *   MESA_ADMIN_API_KEY  — Mesa admin API key
 *   ANTHROPIC_API_KEY   — Anthropic API key
 */

import * as readline from "node:readline";
import { createAgent, tool } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { Mesa } from "@mesadev/sdk";
import { z } from "zod";
import {
  AIMessage,
  ToolMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

// --- ANSI helpers (zero deps) ---

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const [org, repo] = process.argv.slice(2);

if (!org || !repo) {
  console.error("Usage: npx tsx src/index.ts <org> <repo>");
  process.exit(1);
}

// --- Bootstrap ---

console.log(`Connecting to ${org}/${repo} via Mesa...`);

const mesa = new Mesa({ org });

const mesaFs = await mesa.fs.create({
  repos: [{ name: repo, desiredBookmark: "main" }],
  mode: "rw",
});

const bash = mesaFs.bash({ cwd: `/${org}/${repo}` });

// --- Tool ---

const bashTool = tool(
  async ({ command }: { command: string }) => {
    const result = await bash.exec(command);
    return JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  },
  {
    name: "bash",
    description: [
      "Execute a bash command against the repository filesystem.",
      `You have bash access to the "${repo}" repository owned by "${org}".`,
      "Use standard unix commands (ls, cat, grep, find, head, etc.) to explore.",
    ].join("\n"),
    schema: z.object({
      command: z.string().describe("The bash command to execute"),
    }),
  }
);

// --- Agent ---

const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
});

const agent = createAgent({
  model,
  tools: [bashTool],
});

console.log(`Connected. You can now chat with the agent about ${org}/${repo}.`);
console.log('Type "exit" or Ctrl+C to quit.\n');

// --- REPL ---

const history: BaseMessage[] = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on("close", () => {
  console.log("\nBye!");
  process.exit(0);
});

/** Truncate text to first N lines with a summary suffix. */
function truncate(text: string, maxLines = 10): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= maxLines) return text.trimEnd();
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n  ... (${lines.length - maxLines} more lines)`
  );
}

/** Extract text from an AIMessage content (string or content block array). */
function extractText(content: AIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function prompt(): void {
  rl.question("> ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return prompt();
    if (trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      process.exit(0);
    }

    history.push(new HumanMessage(trimmed));

    try {
      // Use "values" mode: each chunk is the full state after a step.
      // This lets us diff messages to see what's new after each step.
      const stream = await agent.stream(
        { messages: history },
        { streamMode: "values" }
      );

      let prevMessageCount = history.length;
      let lastAssistantText = "";
      let allMessages: BaseMessage[] = [];

      for await (const chunk of stream) {
        const messages: BaseMessage[] = chunk.messages ?? [];
        allMessages = messages;

        // Process only new messages since last chunk
        const newMessages = messages.slice(prevMessageCount);
        prevMessageCount = messages.length;

        for (const msg of newMessages) {
          if (msg instanceof AIMessage) {
            // Tool calls
            const toolCalls = msg.tool_calls ?? [];
            if (toolCalls.length) console.log(); // blank line before tool calls
            for (const tc of toolCalls) {
              const command = (tc.args as any)?.command ?? "";
              if (command) {
                console.log(`${blue("[bash]")} ${command.trim()}`);
              }
            }

            // Text content (final response)
            if (!toolCalls.length) {
              const text = extractText(msg.content);
              if (text) {
                process.stdout.write(text);
                lastAssistantText = text;
              }
            }
          } else if (msg instanceof ToolMessage) {
            const raw =
              typeof msg.content === "string" ? msg.content : "";
            try {
              const parsed = JSON.parse(raw);
              const { stdout, stderr, exitCode } = parsed;
              const text = stdout || stderr;
              if (text) console.log(dim(truncate(text)));
              console.log(
                dim(`[exit ${exitCode}]`) +
                  (exitCode !== 0 ? " " + red("(non-zero)") : "")
              );
            } catch {
              if (raw) console.log(dim(truncate(raw)));
            }
          }
        }
      }

      if (lastAssistantText) console.log();

      // Replace history with the full conversation from the agent run
      history.length = 0;
      for (const msg of allMessages) {
        history.push(msg);
      }
    } catch (err) {
      console.error(
        red("Error:"),
        err instanceof Error ? `${err.message}\n${err.stack}` : err
      );
    }

    prompt();
  });
}

prompt();
