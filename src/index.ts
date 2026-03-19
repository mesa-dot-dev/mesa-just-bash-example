#!/usr/bin/env node
/**
 * Mesa + just-bash interactive CLI agent
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

import "dotenv/config";
import * as readline from "node:readline";
import { anthropic } from "@ai-sdk/anthropic";
import { Mesa } from "@mesadev/sdk";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createBashTool } from "bash-tool";

const [org, repo] = process.argv.slice(2);

if (!org || !repo) {
  console.error("Usage: npx tsx src/index.ts <org> <repo>");
  process.exit(1);
}

// --- Bootstrap ---

console.log(`Connecting to ${org}/${repo} via Mesa...`);

const mesa = new Mesa({ org });

const mesaFs = await mesa.fs.create({
  repos: [{ name: repo }],
  mode: "ro",
});

const bash = mesaFs.bash();

console.log("Creating bash tools...");

const repoPath = `/${org}/${repo}`;

const { tools } = await createBashTool({
  sandbox: bash,
  destination: repoPath,
  extraInstructions: [
    `You have bash access to the "${repo}" repository owned by "${org}".`,
    `Files are at ${repoPath}. You are already cd'd there.`,
    "Use standard unix commands (ls, cat, grep, find, head, etc.) to explore.",
  ].join("\n"),
  onBeforeBashCall: ({ command }) => {
    console.log(`\n\x1b[34m[tool] bash:\x1b[0m ${command.trim()}`);
    return undefined;
  },
  onAfterBashCall: ({ command, result }) => {
    const output = result.stdout || result.stderr;
    if (output) {
      const lines = output.trimEnd().split("\n");
      const preview = lines.slice(0, 10).join("\n");
      const suffix = lines.length > 10 ? `\n  ... (${lines.length - 10} more lines)` : "";
      console.log(`\x1b[2m${preview}${suffix}\x1b[0m`);
    }
    console.log(`\x1b[2m[exit ${result.exitCode}]\x1b[0m`);
    return undefined;
  },
});

console.log("Tools created.");

console.log(`Connected. You can now chat with the agent about ${org}/${repo}.`);
console.log('Type "exit" or Ctrl+C to quit.\n');

// --- REPL ---

const history: ModelMessage[] = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on("close", () => {
  console.log("\nBye!");
  process.exit(0);
});

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

    try {
      let fullText = "";

      console.log("\x1b[2m[calling LLM...]\x1b[0m");

      const result = streamText({
        model: anthropic("claude-sonnet-4-20250514"),
        tools,
        stopWhen: stepCountIs(50),
        messages: history,
      });

      for await (const chunk of result.textStream) {
        process.stdout.write(chunk);
        fullText += chunk;
      }

      // Newline after streamed output
      if (fullText) console.log();

      history.push({ role: "assistant", content: fullText });
    } catch (err) {
      console.error(
        "Error:",
        err instanceof Error ? `${err.message}\n${err.stack}` : err
      );
    }

    prompt();
  });
}

prompt();
