#!/usr/bin/env node
/**
 * Mesa + just-bash interactive CLI agent (Mastra)
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
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Mesa } from "@mesadev/sdk";
import { z } from "zod";

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

const bashTool = createTool({
  id: "bash",
  description: [
    "Execute a bash command against the repository filesystem.",
    `You have bash access to the "${repo}" repository owned by "${org}".`,
    "Use standard unix commands (ls, cat, grep, find, head, etc.) to explore.",
  ].join("\n"),
  inputSchema: z.object({
    command: z.string().describe("The bash command to execute"),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
  }),
  execute: async ({ command }) => {
    const result = await bash.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
});

// --- Agent ---

const agent = new Agent({
  id: "mesa-bash-agent",
  name: "Mesa Bash Agent",
  instructions: [
    `You have bash access to the "${repo}" repository owned by "${org}".`,
    "Use the bash tool to explore and answer questions about the repo.",
  ].join("\n"),
  model: "anthropic/claude-sonnet-4-20250514",
  tools: { bash: bashTool },
});

console.log(`Connected. You can now chat with the agent about ${org}/${repo}.`);
console.log('Type "exit" or Ctrl+C to quit.\n');

// --- REPL ---

const history: Array<{ role: "user"; content: string } | { role: "assistant"; content: string }> = [];

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

function prompt(): void {
  rl.question("> ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return prompt();
    if (trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      process.exit(0);
    }

    history.push({ role: "user", content: trimmed });

    const stream = await agent.stream(history, {
      maxSteps: 50,
      onStepFinish: (step: any) => {
        // Render tool calls from each step
        // Mastra wraps tool calls/results: { type, payload: { args, result, ... } }
        if (step.toolCalls?.length) {
          console.log(); // blank line before tool calls
          for (const tc of step.toolCalls) {
            const args = tc.payload?.args ?? tc.args ?? {};
            const command = (args as { command?: string }).command ?? "";
            if (command) {
              console.log(`${blue("[bash]")} ${command.trim()}`);
            }
          }
        }
        if (step.toolResults) {
          for (const tr of step.toolResults) {
            const result = tr.payload?.result ?? tr.result ?? {};
            const { stdout, stderr, exitCode } = result as {
              stdout: string;
              stderr: string;
              exitCode: number;
            };
            const text = stdout || stderr;
            if (text) console.log(dim(truncate(text)));
            console.log(
              dim(`[exit ${exitCode}]`) +
              (exitCode !== 0 ? " " + red("(non-zero)") : "")
            );
          }
        }
      },
    });

    // Stream text output
    for await (const chunk of stream.textStream) {
      process.stdout.write(chunk);
    }
    console.log();

    // Save assistant response to history
    const response = await stream.text;
    history.push({ role: "assistant", content: response });

    prompt();
  });
}

prompt();
