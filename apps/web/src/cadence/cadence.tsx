/**
 * The Cadence Updates view.
 *
 * Lists the work-items / sub-issues / projects the agent proposes to create or
 * update in Cadence, drawn from the room's document, decisions and chat. Items
 * are grouped by the team they go under. A confident item (≥ 0.7) shows a
 * "Push to Cadence" action; a low-confidence one renders as an editable form
 * any member can complete, after which it becomes ready. Pushing calls the
 * chat's Cadence MCP server under the member's own credential.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { Cadence as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type CadenceUpdatesProps = {
	wire: Socket | undefined;
	connected: boolean;
	headingId?: string;
	onItems?: (items: Wire.Update[]) => void;
};

const READY_THRESHOLD = 0.7;
const UNASSIGNED = "Unassigned";

function grouped(items: Wire.Update[]): [string, Wire.Update[]][] {
	let byTeam = new Map<string, Wire.Update[]>();
	for (let item of items) {
		let key = item.team.trim() || UNASSIGNED;
		let list = byTeam.get(key) ?? [];
		list.push(item);
		byTeam.set(key, list);
	}
	return [...byTeam.entries()].sort(([a], [b]) =>
		a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)
	);
}

function confidencePercent(value: number): string {
	return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function CadenceUpdates(
	{ connected, headingId, onItems, wire }: CadenceUpdatesProps,
) {
	let [items, setItems] = useState<Wire.Update[]>([]);
	let [generating, setGenerating] = useState(false);

	useEffect(() => {
		if (!wire || !connected) return;
		let off = [
			wire.on<Wire.Items>("cadence:items", frame => {
				setItems(frame.items);
				setGenerating(false);
			}),
			wire.on<Wire.Item>("cadence:item", frame => {
				setItems(current => current.map(item => item.id === frame.item.id ? frame.item : item));
			}),
		];
		wire.send("cadence:list");
		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire, connected]);

	useEffect(() => onItems?.(items), [items, onItems]);

	let groups = useMemo(() => grouped(items), [items]);

	let generate = () => {
		if (!wire) return;
		setGenerating(true);
		wire.send("cadence:generate");
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-auto p-3">
			<div className="mb-3 flex shrink-0 items-center justify-between gap-2">
				<h2 className="text-[14px] font-medium text-text-tertiary" id={headingId} tabIndex={-1}>
					Cadence Updates
				</h2>
				<button
					className="btn btn-sm bg-brand text-page disabled:opacity-50"
					disabled={!connected || generating}
					onClick={generate}
					type="button"
				>
					{generating ? "Generating…" : "Generate updates"}
				</button>
			</div>

			{items.length === 0 && (
				<p className="text-[13px] text-text-tertiary">
					No proposals yet. Generate updates to have the agent read the document, decisions and chat
					and propose the Cadence work-items to create or update.
				</p>
			)}

			<div className="flex min-h-0 flex-col gap-4">
				{groups.map(([team, teamItems]) => (
					<TeamGroup items={teamItems} key={team} team={team} wire={wire} />
				))}
			</div>
		</div>
	);
}

function TeamGroup(
	{ items, team, wire }: { items: Wire.Update[]; team: string; wire: Socket | undefined },
) {
	let needsInput = items.filter(item => item.status === "needs_input").length;
	return (
		<section>
			<div className="mb-1.5 flex items-center gap-2">
				<h3 className="text-[13px] font-semibold">{team}</h3>
				<span className="text-[11px] text-text-tertiary">{items.length}</span>
				{needsInput > 0 && (
					<span className="rounded-full bg-warning-wash px-1.5 text-[11px] text-warning-ink">
						{needsInput} need input
					</span>
				)}
			</div>
			<div className="space-y-2">
				{items.map(item => <ItemCard item={item} key={item.id} wire={wire} />)}
			</div>
		</section>
	);
}

function ItemCard({ item, wire }: { item: Wire.Update; wire: Socket | undefined }) {
	let needsInput = item.status === "needs_input" || item.confidence < READY_THRESHOLD;
	let [dirty, setDirty] = useState(false);
	let [saving, setSaving] = useState(false);
	let [editing, setEditing] = useState(needsInput);
	let [title, setTitle] = useState(item.title);
	let [team, setTeam] = useState(item.team);
	let [fields, setFields] = useState(() => JSON.stringify(item.fields, null, 2));
	let [error, setError] = useState<string>();

	// Follow the server copy while the member is not editing, so a refresh (or a
	// teammate's edit) updates a card rather than leaving it stuck in edit mode.
	useEffect(() => {
		if (dirty || saving) return;
		setEditing(needsInput);
		setTitle(item.title);
		setTeam(item.team);
		setFields(JSON.stringify(item.fields, null, 2));
	}, [dirty, saving, needsInput, item.title, item.team, item.fields]);

	// Close the form once the server's copy reflects the save. Every save bumps
	// `updated_at`, so a newer timestamp than when we started is the confirmation
	// — no optimistic flash of the old card. A lost broadcast (validation error,
	// dropped frame) falls back to a timeout so the button never sticks.
	let savedAt = useRef(item.updated_at);
	useEffect(() => {
		if (saving && item.updated_at > savedAt.current) {
			savedAt.current = item.updated_at;
			setDirty(false);
			setSaving(false);
		}
	}, [saving, item.updated_at]);
	useEffect(() => {
		if (!saving) return;
		let timer = setTimeout(() => setSaving(false), 3_000);
		return () => clearTimeout(timer);
	}, [saving]);

	let save = () => {
		if (!wire) return;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(fields);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("fields must be a JSON object");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "invalid fields");
			return;
		}
		setError(undefined);
		wire.send("cadence:field", { id: item.id, title, team, fields: parsed });
		setSaving(true);
	};

	return (
		<div className="rounded-md border border-edge p-2.5">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-[12px] font-medium">{item.title}</div>
					<div className="text-[11px] text-text-tertiary">
						{item.status === "pushed" && item.target_id
							? `Done · ${item.target_id}`
							: `${item.op === "update" ? "Update" : "Create"} · ${item.kind}`}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<span
						className={`rounded px-1.5 text-[11px] ${
							item.confidence >= READY_THRESHOLD
								? "bg-success-wash text-success-ink"
								: "bg-warning-wash text-warning-ink"
						}`}
						title="Agent confidence"
					>
						{confidencePercent(item.confidence)}
					</span>
					<StatusChip status={item.status} />
				</div>
			</div>

			{editing
				? (
					<div className="mt-2 space-y-2">
						{item.needs.length > 0 && (
							<div className="rounded bg-warning-wash px-2 py-1 text-[11px] text-warning-ink">
								Needs: {item.needs.join(", ")}
							</div>
						)}
						<input
							className="w-full rounded border border-edge bg-transparent px-2 py-1 text-[12px]"
							onChange={event => { setDirty(true); setTitle(event.currentTarget.value); }}
							placeholder="title"
							value={title}
						/>
						<input
							className="w-full rounded border border-edge bg-transparent px-2 py-1 text-[12px]"
							onChange={event => { setDirty(true); setTeam(event.currentTarget.value); }}
							placeholder="team"
							value={team}
						/>
						<textarea
							className="h-28 w-full rounded border border-edge bg-transparent px-2 py-1 font-mono text-[11px]"
							onChange={event => { setDirty(true); setFields(event.currentTarget.value); }}
							spellCheck={false}
							value={fields}
						/>
						{error && <p className="text-[11px] text-destructive-ink">{error}</p>}
						<div className="flex gap-2">
							<button
								className="rounded bg-brand px-2 py-1 text-[12px] text-page disabled:opacity-50"
								disabled={saving}
								onClick={save}
								type="button"
							>
								{saving ? "Saving…" : "Save"}
							</button>
							{!needsInput && (
								<button
									className="text-[12px] text-text-tertiary"
									onClick={() => setEditing(false)}
									type="button"
								>
									Cancel
								</button>
							)}
						</div>
					</div>
				)
				: (
					<div className="mt-2 flex items-center gap-3">
						<button
							className="rounded bg-brand px-2 py-1 text-[12px] text-page disabled:opacity-50"
							disabled={!wire || item.status === "pushing" || item.status === "pushed"}
							onClick={() => wire?.send("cadence:push", { id: item.id })}
							type="button"
						>
							{item.status === "pushed"
								? "Pushed"
								: item.status === "pushing"
								? "Pushing…"
								: item.status === "failed"
								? "Retry push"
								: "Push to Cadence"}
						</button>
						<button
							className="text-[12px] text-text-tertiary hover:text-text-secondary"
							onClick={() => setEditing(true)}
							type="button"
						>
							Edit
						</button>
						{item.pushed_url && (
							<a
								className="text-[12px] text-brand-ink hover:underline"
								href={item.pushed_url}
								rel="noreferrer"
								target="_blank"
							>
								Open in Cadence
							</a>
						)}
					</div>
				)}

			{item.error && item.status === "failed" && (
				<p className="mt-1.5 text-[11px] text-destructive-ink">{item.error}</p>
			)}
			{item.updated_by && (
				<p className="mt-1 text-[10px] text-text-tertiary">last edited by {item.updated_by}</p>
			)}
		</div>
	);
}

function StatusChip({ status }: { status: Wire.Update["status"] }) {
	let label = status === "needs_input"
		? "Needs input"
		: status === "ready"
		? "Ready"
		: status === "pushing"
		? "Pushing"
		: status === "pushed"
		? "Pushed"
		: "Failed";
	return <span className="rounded px-1.5 text-[11px] text-text-tertiary">{label}</span>;
}
