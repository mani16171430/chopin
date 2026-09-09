import { corrupt } from "../errors";

import type { SQL } from "bun";
import type { CadenceUpdate, ProposedCadenceUpdate } from "../model";
import type { CadenceUpdateStore } from "../port";

type Timestamp = Date | string;

type Row = {
	id: string;
	channelId: string;
	team: string;
	op: string;
	targetId: string | null;
	kind: string;
	title: string;
	fields: unknown;
	confidence: number;
	needs: unknown;
	status: string;
	mcpServer: string;
	mcpTool: string;
	pushedUrl: string | null;
	error: string | null;
	updatedBy: string | null;
	createdAt: Timestamp;
	updatedAt: Timestamp;
};

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;

const COLUMNS = `
	id,
	channel_id AS "channelId",
	team,
	op,
	target_id AS "targetId",
	kind,
	title,
	fields,
	confidence,
	needs,
	status,
	mcp_server AS "mcpServer",
	mcp_tool AS "mcpTool",
	pushed_url AS "pushedUrl",
	error,
	updated_by AS "updatedBy",
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

const OPS = new Set(["create", "update"]);
const STATUSES = new Set(["needs_input", "ready", "pushing", "pushed", "failed"]);

function date(value: Timestamp, field: string): Date {
	let parsed = value instanceof Date ? new Date(value) : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw corrupt(`storage returned an invalid ${field}`);
	return parsed;
}

function fields(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string") {
		try {
			let parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			throw corrupt("storage returned invalid cadence fields");
		}
	}
	return {};
}

function strings(value: unknown): string[] {
	let raw = value;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	return Array.isArray(raw)
		? raw.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function item(row: Row): CadenceUpdate {
	if (!row.id || !row.channelId || !OPS.has(row.op) || !STATUSES.has(row.status)) {
		throw corrupt("storage returned an invalid cadence update");
	}
	return {
		id: row.id,
		channelId: row.channelId,
		team: row.team,
		op: row.op as CadenceUpdate["op"],
		...(row.targetId ? { targetId: row.targetId } : {}),
		kind: row.kind,
		title: row.title,
		fields: fields(row.fields),
		confidence: Number(row.confidence),
		needs: strings(row.needs),
		status: row.status as CadenceUpdate["status"],
		mcpServer: row.mcpServer,
		mcpTool: row.mcpTool,
		...(row.pushedUrl ? { pushedUrl: row.pushedUrl } : {}),
		...(row.error ? { error: row.error } : {}),
		...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
		createdAt: date(row.createdAt, "cadence update created time"),
		updatedAt: date(row.updatedAt, "cadence update updated time"),
	};
}

/** Channel-scoped Cadence work-item proposals. */
export class PostgresCadenceUpdateStore implements CadenceUpdateStore {
	readonly #sql: SQL;
	readonly #run: Run;

	constructor(sql: SQL, run: Run) {
		this.#sql = sql;
		this.#run = run;
	}

	readonly list = (channelId: string): Promise<CadenceUpdate[]> =>
		this.#run("list cadence updates", async () => {
			let rows = await this.#sql<Row[]>`
				SELECT ${this.#sql.unsafe(COLUMNS)}
				FROM channel_cadence_updates
				WHERE channel_id = ${channelId}
				ORDER BY team ASC, title ASC
			`;
			return rows.map(item);
		});

	readonly get = (channelId: string, id: string): Promise<CadenceUpdate | undefined> =>
		this.#run("read cadence update", async () => {
			let rows = await this.#sql<Row[]>`
				SELECT ${this.#sql.unsafe(COLUMNS)}
				FROM channel_cadence_updates
				WHERE channel_id = ${channelId} AND id = ${id}
			`;
			let row = rows[0];
			return row ? item(row) : undefined;
		});

	readonly replaceAll = (
		channelId: string,
		items: ProposedCadenceUpdate[],
		now: Date,
	): Promise<CadenceUpdate[]> =>
		this.#run("replace cadence updates", async () => {
			return this.#sql.begin(async transaction => {
				await transaction`DELETE FROM channel_cadence_updates WHERE channel_id = ${channelId}`;
				let saved: CadenceUpdate[] = [];
				for (let proposed of items) {
					let rows = await transaction<Row[]>`
						INSERT INTO channel_cadence_updates (
							id, channel_id, team, op, target_id, kind, title, fields,
							confidence, needs, status, mcp_server, mcp_tool, created_at, updated_at
						)
						VALUES (
							${crypto.randomUUID()},
							${channelId},
							${proposed.team},
							${proposed.op},
							${proposed.targetId ?? null},
							${proposed.kind},
							${proposed.title},
							${JSON.stringify(proposed.fields)}::jsonb,
							${proposed.confidence},
							${JSON.stringify(proposed.needs ?? [])}::jsonb,
							${proposed.status},
							${proposed.mcpServer},
							${proposed.mcpTool},
							${now},
							${now}
						)
						RETURNING ${this.#sql.unsafe(COLUMNS)}
					`;
					let row = rows[0];
					if (row) saved.push(item(row));
				}
				return saved;
			}) as Promise<CadenceUpdate[]>;
		});

	readonly updateFields = (
		channelId: string,
		id: string,
		patch: {
			team?: string;
			title?: string;
			fields?: Record<string, unknown>;
			status?: CadenceUpdate["status"];
			updatedBy?: string;
		},
		now: Date,
	): Promise<CadenceUpdate | undefined> =>
		this.#run("update cadence fields", async () => {
			let rows = await this.#sql<Row[]>`
				UPDATE channel_cadence_updates SET
					team = COALESCE(${patch.team ?? null}, team),
					title = COALESCE(${patch.title ?? null}, title),
					fields = COALESCE(${patch.fields ? JSON.stringify(patch.fields) : null}::jsonb, fields),
					status = COALESCE(${patch.status ?? null}, status),
					updated_by = COALESCE(${patch.updatedBy ?? null}, updated_by),
					updated_at = ${now}
				WHERE channel_id = ${channelId} AND id = ${id}
				RETURNING ${this.#sql.unsafe(COLUMNS)}
			`;
			let row = rows[0];
			return row ? item(row) : undefined;
		});

	readonly setStatus = (
		channelId: string,
		id: string,
		status: CadenceUpdate["status"],
		result: { pushedUrl?: string; error?: string; targetId?: string },
		now: Date,
	): Promise<CadenceUpdate | undefined> =>
		this.#run("set cadence status", async () => {
			let rows = await this.#sql<Row[]>`
				UPDATE channel_cadence_updates SET
					status = ${status},
					pushed_url = ${result.pushedUrl ?? null},
					error = ${result.error ?? null},
					target_id = COALESCE(${result.targetId ?? null}, target_id),
					updated_at = ${now}
				WHERE channel_id = ${channelId} AND id = ${id}
				RETURNING ${this.#sql.unsafe(COLUMNS)}
			`;
			let row = rows[0];
			return row ? item(row) : undefined;
		});

	readonly remove = (channelId: string, id: string): Promise<boolean> =>
		this.#run("remove cadence update", async () => {
			let rows = await this.#sql<{ id: string }[]>`
				DELETE FROM channel_cadence_updates
				WHERE channel_id = ${channelId} AND id = ${id}
				RETURNING id
			`;
			return rows.length > 0;
		});
}
