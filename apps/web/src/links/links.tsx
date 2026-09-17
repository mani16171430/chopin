/**
 * The Links view — the relation chart for a document.
 *
 * The open document is the central node; the repositories, pull requests and
 * AI Docs the planner has connected it to fan out around it. Each node is a
 * lean card (icon + name + status + link). "Generate links" runs a planner
 * turn that reads the room and calls `link_entities`; the graph re-renders
 * from the `links:changed` broadcast. Any member can remove a link.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowUpIcon, DocumentIcon, LinkPlusIcon, SparkleIcon, WarningIcon } from "@chopin/icons";

import type { ReactNode } from "react";
import type { Links as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type LinksProps = {
	wire: Socket | undefined;
	connected: boolean;
	/** The open document's title — the central node's label. */
	title: string;
	headingId?: string;
};

type Kind = Wire.Update["kind"];

// The radial layout anchors. The center node sits mid-pane; spokes fan out
// around it, spread across a 70% vertical band centered on the middle.
const CENTER = { x: 50, y: 50 }; // percent
function spread(count: number, index: number): number {
	return count <= 1 ? 0 : (index / (count - 1)) * 70 - 35;
}

/**
 * A connector between the center node and a spoke, drawn as a rotated hairline
 * (no SVG — the codebase keeps interface artwork to the shared icon library).
 * `top` is the spoke's vertical position in percent; the line runs from the
 * card's inner edge toward the center, tilting to meet it.
 */
function Connector(
	{ side, suggested, top }: { side: "left" | "right"; suggested: boolean; top: number },
) {
	let tilt = (top - CENTER.y) * 0.5; // degrees, proportional to the vertical gap
	return (
		<div
			aria-hidden="true"
			className={`pointer-events-none absolute h-px w-[22%] ${
				suggested ? "border-t border-dashed border-text-tertiary/40" : "bg-text-tertiary/40"
			}`}
			style={{
				[side === "left" ? "left" : "right"]: "26%",
				top: `${top}%`,
				transform: `rotate(${side === "left" ? tilt : -tilt}deg)`,
				transformOrigin: side === "left" ? "left center" : "right center",
			}}
		/>
	);
}

/** The deterministic card format per node kind: icon, and how to read it. */
const NODE: Record<Kind, { icon: (props: { className?: string }) => ReactNode; noun: string }> = {
	repo: { icon: WarningIcon, noun: "repo" },
	pull_request: { icon: ArrowUpIcon, noun: "pull request" },
	ai_doc: { icon: SparkleIcon, noun: "AI Doc" },
};

function Card(
	{ link, onRemove, removable }: {
		link: Wire.Update;
		onRemove: (id: string) => void;
		removable: boolean;
	},
) {
	let format = NODE[link.kind];
	let Icon = format.icon;
	let body = (
		<>
			<Icon className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" />
			<span className="min-w-0">
				<span className="block truncate text-[13px] font-medium text-text-primary">
					{link.title}
				</span>
				<span className="block truncate text-[11px] text-text-tertiary">
					{link.subtitle ?? format.noun}
				</span>
			</span>
		</>
	);
	return (
		<div
			className="group relative flex items-start gap-2 rounded-md bg-page px-2.5 py-2 ring-hairline shadow-resting"
			data-link-kind={link.kind}
		>
			{link.url
				? (
					<a
						className="flex min-w-0 flex-1 items-start gap-2 no-underline"
						href={link.url}
						rel="noreferrer"
						target="_blank"
					>
						{body}
					</a>
				)
				: <div className="flex min-w-0 flex-1 items-start gap-2">{body}</div>}
			{removable && (
				<button
					aria-label={`Remove ${link.title}`}
					className="invisible absolute -right-1.5 -top-1.5 rounded-full bg-page px-1 text-[11px] leading-4 text-text-tertiary ring-hairline group-hover:visible hover:text-destructive-ink"
					onClick={() => onRemove(link.id)}
					type="button"
				>
					×
				</button>
			)}
		</div>
	);
}

export function Links({ connected, headingId, title, wire }: LinksProps) {
	let [links, setLinks] = useState<Wire.Update[]>([]);
	let [generating, setGenerating] = useState(false);

	useEffect(() => {
		if (!wire || !connected) return;
		let off = [
			wire.on<Wire.Changed>("links:changed", frame => {
				setLinks(frame.links);
				setGenerating(false);
			}),
			wire.on<Wire.List.Reply>("links:list", frame => setLinks(frame.links)),
		];
		wire.send("links:list");
		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire, connected]);

	let groups = useMemo(() => {
		let by: Record<Kind, Wire.Update[]> = { repo: [], pull_request: [], ai_doc: [] };
		for (let link of links) by[link.kind]?.push(link);
		return by;
	}, [links]);

	let generate = () => {
		if (!wire) return;
		setGenerating(true);
		wire.send("links:generate");
	};
	let remove = (id: string) => wire?.send("links:remove", { id });

	// The radial layout: center node, spokes fanned on the left and right.
	let left = [...groups.repo, ...groups.pull_request];
	let right = groups.ai_doc;

	return (
		<div className="flex h-full min-h-0 flex-col overflow-auto p-3">
			<div className="mb-3 flex shrink-0 items-center justify-between gap-2">
				<h2 className="text-[14px] font-medium text-text-tertiary" id={headingId} tabIndex={-1}>
					Links
				</h2>
				<button
					className="btn btn-sm bg-brand text-page disabled:opacity-50"
					disabled={!connected || generating}
					onClick={generate}
					type="button"
				>
					<LinkPlusIcon className="mr-1 inline size-3.5" />
					{generating ? "Generating…" : links.length > 0 ? "Regenerate links" : "Generate links"}
				</button>
			</div>

			{links.length === 0
				? (
					<p className="text-[13px] text-text-tertiary">
						No links yet. Generate links to have the planner connect this document to the
						repositories, pull requests and AI Docs it is about.
					</p>
				)
				: (
					<div className="relative min-h-[320px] flex-1" data-links-graph="">
						{/* connectors, drawn beneath the cards as rotated hairlines */}
						{left.map((link, index) => (
							<Connector
								key={link.id}
								side="left"
								suggested={link.subtitle?.includes("suggested") ?? false}
								top={50 + spread(left.length, index)}
							/>
						))}
						{right.map((link, index) => (
							<Connector
								key={link.id}
								side="right"
								suggested={link.subtitle?.includes("suggested") ?? false}
								top={50 + spread(right.length, index)}
							/>
						))}

						{/* the central node */}
						<div
							className="absolute flex max-w-[30%] -translate-x-1/2 -translate-y-1/2 items-start gap-2 rounded-md bg-brand/10 px-3 py-2 ring-1 ring-brand/40"
							style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
						>
							<DocumentIcon className="mt-0.5 size-3.5 shrink-0 text-brand" />
							<span className="min-w-0">
								<span className="block truncate text-[13px] font-medium text-text-primary">
									{title}
								</span>
								<span className="block text-[11px] text-text-tertiary">this doc</span>
							</span>
						</div>

						{/* spokes */}
						{left.map((link, index) => (
							<div
								className="absolute w-[24%] -translate-y-1/2"
								key={link.id}
								style={{ left: "2%", top: `${50 + spread(left.length, index)}%` }}
							>
								<Card link={link} onRemove={remove} removable={connected} />
							</div>
						))}
						{right.map((link, index) => (
							<div
								className="absolute w-[24%] -translate-y-1/2"
								key={link.id}
								style={{ left: "74%", top: `${50 + spread(right.length, index)}%` }}
							>
								<Card link={link} onRemove={remove} removable={connected} />
							</div>
						))}
					</div>
				)}

			{links.length > 0 && (
				<p className="mt-3 shrink-0 text-[11px] text-text-tertiary">
					The planner reads this graph when it answers — hopping from this doc to the repos, PRs and
					AI Docs linked here.
				</p>
			)}
		</div>
	);
}
