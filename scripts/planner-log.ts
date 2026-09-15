#!/usr/bin/env bun
/**
 * Read the planner activity log.
 *
 * The planner writes one JSON line per LLM call and tool call to
 * `logs/planner-<session>.log` — one file per session. This merges them and
 * prints a readable trace: what the model did, which tools it called, how long
 * each took, and where a turn failed.
 *
 *   bun scripts/planner-log.ts                  every event, oldest first
 *   bun scripts/planner-log.ts --last 20        the twenty most recent events
 *   bun scripts/planner-log.ts --session <id>   one session's file only
 *   bun scripts/planner-log.ts --errors         only failures and gate denials
 *   bun scripts/planner-log.ts --tools          only tool calls
 */

import { readdir, readFile } from "node:fs/promises";

type Entry = {
	at: string;
	seq: number;
	kind: string;
	[key: string]: unknown;
};

let args = process.argv.slice(2);
let dir = new URL("../logs", import.meta.url).pathname;

let files: string[];
try {
	files = (await readdir(dir)).filter(name => name.startsWith("planner-") && name.endsWith(".log"));
} catch {
	console.log("no planner logs yet — logs/planner-*.log is written on the first turn.");
	process.exit(0);
}

let sessionFilter: string | undefined;
let sessionIndex = args.indexOf("--session");
if (sessionIndex !== -1) {
	sessionFilter = args[sessionIndex + 1];
	if (!sessionFilter) throw new Error("usage: --session <id>");
	files = files.filter(name => name === `planner-${sessionFilter}.log`);
}

let all: Entry[] = [];
for (let name of files) {
	let raw = await readFile(`${dir}/${name}`, "utf8");
	for (let line of raw.split("\n")) {
		if (line.trim()) all.push(JSON.parse(line) as Entry);
	}
}
// Merge sessions into one timeline.
all.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

if (args.includes("--errors")) {
	all = all.filter(entry =>
		entry.kind === "session.error"
		|| entry.kind === "permission.denied"
		|| (entry.kind === "tool.complete" && entry.success === false)
	);
} else if (args.includes("--tools")) {
	all = all.filter(entry => entry.kind.startsWith("tool."));
}

let lastIndex = args.indexOf("--last");
if (lastIndex !== -1) {
	let count = Number(args[lastIndex + 1]);
	if (!Number.isInteger(count) || count < 1) throw new Error("usage: --last <count>");
	all = all.slice(-count);
}

function show(entry: Entry): void {
	let base = `[${entry.at}] ${entry.kind}`;
	switch (entry.kind) {
		case "llm.request":
			console.log(
				`${base} model=${entry.model} msgs=${entry.messageCount} tools=${entry.toolCount} iter=${entry.iteration}`,
			);
			break;
		case "llm.response":
			console.log(
				`${base} model=${entry.model} stop=${entry.stopReason} in=${entry.inputTokens} out=${entry.outputTokens} toolCalls=${entry.toolCalls} ${entry.durationMs}ms`,
			);
			break;
		case "tool.start":
			console.log(
				`${base} ${entry.tool} args=[${(entry.argKeys as string[]).join(",")}] ${entry.argBytes}B`,
			);
			break;
		case "tool.complete":
			console.log(
				entry.success
					? `${base} ${entry.tool} ok ${entry.resultBytes}B ${entry.durationMs}ms`
					: `${base} ${entry.tool} FAILED: ${entry.error} ${entry.durationMs}ms`,
			);
			break;
		case "permission.denied":
			console.log(`${base} ${entry.tool} — ${entry.feedback ?? "denied"}`);
			break;
		case "assistant.message":
			console.log(`${base} ${entry.contentBytes}B`);
			break;
		case "session.error":
			console.log(`${base} ${entry.errorType}: ${entry.message}`);
			break;
		case "session.idle":
			console.log(`${base} after ${entry.iterations} iteration(s)`);
			break;
		default:
			console.log(`${base} ${JSON.stringify(entry)}`);
	}
}

if (all.length === 0) console.log("no matching events.");
else all.forEach(show);
