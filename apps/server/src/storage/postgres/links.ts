import { corrupt } from "../errors";

import type { SQL } from "bun";
import type { ChannelLink, NewChannelLink } from "../model";
import type { ChannelLinkStore } from "../port";

type Timestamp = Date | string;

type Row = {
	id: string;
	channelId: string;
	kind: string;
	refKey: string;
	title: string;
	subtitle: string | null;
	url: string | null;
	createdBy: string;
	createdAt: Timestamp;
};

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;

const COLUMNS = `
	id,
	channel_id AS "channelId",
	kind,
	ref_key AS "refKey",
	title,
	subtitle,
	url,
	created_by AS "createdBy",
	created_at AS "createdAt"
`;

const KINDS = new Set(["repo", "pull_request", "ai_doc"]);

function date(value: Timestamp, field: string): Date {
	let parsed = value instanceof Date ? new Date(value) : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw corrupt(`storage returned an invalid ${field}`);
	return parsed;
}

function link(row: Row): ChannelLink {
	if (!row.id || !row.channelId || !KINDS.has(row.kind) || !row.refKey) {
		throw corrupt("storage returned an invalid channel link");
	}
	return {
		id: row.id,
		channelId: row.channelId,
		kind: row.kind as ChannelLink["kind"],
		refKey: row.refKey,
		title: row.title,
		...(row.subtitle ? { subtitle: row.subtitle } : {}),
		...(row.url ? { url: row.url } : {}),
		createdBy: row.createdBy,
		createdAt: date(row.createdAt, "channel link created time"),
	};
}

/** Channel-scoped relation links — the "Links" graph's durable edge set. */
export class PostgresChannelLinkStore implements ChannelLinkStore {
	readonly #sql: SQL;
	readonly #run: Run;

	constructor(sql: SQL, run: Run) {
		this.#sql = sql;
		this.#run = run;
	}

	readonly list = (channelId: string): Promise<ChannelLink[]> =>
		this.#run("list channel links", async () => {
			let rows = await this.#sql<Row[]>`
				SELECT ${this.#sql.unsafe(COLUMNS)}
				FROM channel_links
				WHERE channel_id = ${channelId}
				ORDER BY kind ASC, title ASC
			`;
			return rows.map(link);
		});

	readonly add = (channelId: string, input: NewChannelLink, now: Date): Promise<ChannelLink> =>
		this.#run("add channel link", async () => {
			// Idempotent on the (channel, kind, refKey) identity: a known link is
			// refreshed in place, keeping its id, rather than duplicated.
			let rows = await this.#sql<Row[]>`
				INSERT INTO channel_links (
					id, channel_id, kind, ref_key, title, subtitle, url, created_by, created_at
				)
				VALUES (
					${crypto.randomUUID()},
					${channelId},
					${input.kind},
					${input.refKey},
					${input.title},
					${input.subtitle ?? null},
					${input.url ?? null},
					${input.createdBy},
					${now}
				)
				ON CONFLICT (channel_id, kind, ref_key)
				DO UPDATE SET
					title = EXCLUDED.title,
					subtitle = EXCLUDED.subtitle,
					url = EXCLUDED.url,
					created_by = EXCLUDED.created_by
				RETURNING ${this.#sql.unsafe(COLUMNS)}
			`;
			let row = rows[0];
			if (!row) throw corrupt("storage returned no channel link on add");
			return link(row);
		});

	readonly remove = (channelId: string, id: string): Promise<boolean> =>
		this.#run("remove channel link", async () => {
			let rows = await this.#sql<{ id: string }[]>`
				DELETE FROM channel_links
				WHERE channel_id = ${channelId} AND id = ${id}
				RETURNING id
			`;
			return rows.length > 0;
		});
}
