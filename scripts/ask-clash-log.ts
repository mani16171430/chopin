#!/usr/bin/env bun
/**
 * Read the ask_clash call log.
 *
 * `ask_clash` writes one JSON line per call — the question sent and the answer
 * (or failure) returned — to `logs/ask_clash.log`. This prints them readably.
 *
 *   bun scripts/ask-clash-log.ts            every call, oldest first
 *   bun scripts/ask-clash-log.ts --last 5   the five most recent
 *   bun scripts/ask-clash-log.ts --errors   only calls that did not answer
 */

import { readFile } from "node:fs/promises";

type Entry = {
	at: string;
	runId?: string;
	question: string;
	outcome: "answered" | "failed" | "timeout" | "cancelled" | "stuck" | "error";
	response: string;
	durationMs: number;
};

function entries(raw: string): Entry[] {
	return raw
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Entry);
}

function show(entry: Entry): void {
	let seconds = (entry.durationMs / 1000).toFixed(1);
	let head = `[${entry.at}] ${entry.outcome} (${seconds}s)${
		entry.runId ? ` run=${entry.runId}` : ""
	}`;
	console.log(`\n${head}`);
	console.log(`  q: ${entry.question}`);
	console.log(`  a: ${entry.response}`);
}

let args = process.argv.slice(2);
let raw: string;
try {
	raw = await readFile(new URL("../logs/ask_clash.log", import.meta.url).pathname, "utf8");
} catch {
	console.log("no ask_clash log yet — logs/ask_clash.log is written on the first call.");
	process.exit(0);
}

let all = entries(raw);
if (args[0] === "--errors") {
	all = all.filter(entry => entry.outcome !== "answered");
} else if (args[0] === "--last") {
	let count = Number(args[1]);
	if (!Number.isInteger(count) || count < 1) throw new Error("usage: --last <count>");
	all = all.slice(-count);
} else if (args.length > 0) {
	throw new Error("usage: bun scripts/ask-clash-log.ts [--last <count> | --errors]");
}

if (all.length === 0) console.log("no matching calls.");
else all.forEach(show);
