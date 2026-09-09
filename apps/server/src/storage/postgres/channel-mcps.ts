import { corrupt, unavailable } from "../errors";

import type { SQL } from "bun";
import type {
	ChannelMcp,
	ChannelMcpCredential,
	CreateChannelMcp,
	UpsertChannelMcpCredential,
} from "../model";
import type { ChannelMcpStore } from "../port";

type Timestamp = Date | string;

type McpRow = {
	id: string;
	channelId: string;
	name: string;
	url: string;
	addedBy: string;
	createdAt: Timestamp;
	updatedAt: Timestamp;
};

type CredentialRow = {
	channelId: string;
	name: string;
	principalId: string;
	sealed: Uint8Array;
	createdAt: Timestamp;
	updatedAt: Timestamp;
};

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;

const MCP_COLUMNS = `
	id,
	channel_id AS "channelId",
	name,
	url,
	added_by AS "addedBy",
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

const CREDENTIAL_COLUMNS = `
	channel_id AS "channelId",
	name,
	principal_id AS "principalId",
	sealed,
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

function date(value: Timestamp, field: string): Date {
	let parsed = value instanceof Date ? new Date(value) : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw corrupt(`storage returned an invalid ${field}`);
	return parsed;
}

function mcp(row: McpRow): ChannelMcp {
	if (!row.id || !row.channelId || !row.name || !row.url || !row.addedBy) {
		throw corrupt("storage returned an invalid channel MCP");
	}
	return {
		id: row.id,
		channelId: row.channelId,
		name: row.name,
		url: row.url,
		addedBy: row.addedBy,
		createdAt: date(row.createdAt, "channel MCP added time"),
		updatedAt: date(row.updatedAt, "channel MCP update time"),
	};
}

function credential(row: CredentialRow): ChannelMcpCredential {
	if (
		!row.channelId || !row.name || !row.principalId
		|| !(row.sealed instanceof Uint8Array) || row.sealed.length === 0
	) throw corrupt("storage returned an invalid channel MCP credential");
	return {
		channelId: row.channelId,
		name: row.name,
		principalId: row.principalId,
		sealed: new Uint8Array(row.sealed),
		createdAt: date(row.createdAt, "channel MCP credential added time"),
		updatedAt: date(row.updatedAt, "channel MCP credential update time"),
	};
}

/** Channel-scoped MCP servers and each member's own credential for them. */
export class PostgresChannelMcpStore implements ChannelMcpStore {
	readonly #sql: SQL;
	readonly #run: Run;

	constructor(sql: SQL, run: Run) {
		this.#sql = sql;
		this.#run = run;
	}

	readonly add = (input: CreateChannelMcp): Promise<ChannelMcp> =>
		this.#run("add channel MCP", async () => {
			let rows = await this.#sql<McpRow[]>`
				INSERT INTO channel_mcps (id, channel_id, name, url, added_by, created_at, updated_at)
				VALUES (
					${crypto.randomUUID()},
					${input.channelId},
					${input.name},
					${input.url},
					${input.addedBy},
					${input.now},
					${input.now}
				)
				RETURNING ${this.#sql.unsafe(MCP_COLUMNS)}
			`;
			let row = rows[0];
			if (!row) throw unavailable("channel MCP could not be added");
			return mcp(row);
		});

	readonly remove = (channelId: string, name: string): Promise<boolean> =>
		this.#run("remove channel MCP", async () => {
			let rows = await this.#sql<{ id: string }[]>`
				DELETE FROM channel_mcps
				WHERE channel_id = ${channelId} AND name = ${name}
				RETURNING id
			`;
			return rows.length > 0;
		});

	readonly list = (channelId: string): Promise<ChannelMcp[]> =>
		this.#run("list channel MCPs", async () => {
			let rows = await this.#sql<McpRow[]>`
				SELECT ${this.#sql.unsafe(MCP_COLUMNS)}
				FROM channel_mcps
				WHERE channel_id = ${channelId}
				ORDER BY name ASC
			`;
			return rows.map(mcp);
		});

	readonly get = (channelId: string, name: string): Promise<ChannelMcp | undefined> =>
		this.#run("read channel MCP", async () => {
			let rows = await this.#sql<McpRow[]>`
				SELECT ${this.#sql.unsafe(MCP_COLUMNS)}
				FROM channel_mcps
				WHERE channel_id = ${channelId} AND name = ${name}
			`;
			let row = rows[0];
			return row ? mcp(row) : undefined;
		});

	readonly setCredential = (input: UpsertChannelMcpCredential): Promise<ChannelMcpCredential> =>
		this.#run("set channel MCP credential", async () => {
			let rows = await this.#sql<CredentialRow[]>`
				INSERT INTO channel_mcp_credentials (channel_id, name, principal_id, sealed, created_at, updated_at)
				VALUES (
					${input.channelId},
					${input.name},
					${input.principalId},
					${input.sealed},
					${input.now},
					${input.now}
				)
				ON CONFLICT (channel_id, name, principal_id)
				DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = EXCLUDED.updated_at
				RETURNING ${this.#sql.unsafe(CREDENTIAL_COLUMNS)}
			`;
			let row = rows[0];
			if (!row) throw unavailable("channel MCP credential could not be set");
			return credential(row);
		});

	readonly clearCredential = (
		channelId: string,
		name: string,
		principalId: string,
	): Promise<boolean> =>
		this.#run("clear channel MCP credential", async () => {
			let rows = await this.#sql<{ principalId: string }[]>`
				DELETE FROM channel_mcp_credentials
				WHERE channel_id = ${channelId} AND name = ${name} AND principal_id = ${principalId}
				RETURNING principal_id AS "principalId"
			`;
			return rows.length > 0;
		});

	readonly credential = (
		channelId: string,
		name: string,
		principalId: string,
	): Promise<ChannelMcpCredential | undefined> =>
		this.#run("read channel MCP credential", async () => {
			let rows = await this.#sql<CredentialRow[]>`
				SELECT ${this.#sql.unsafe(CREDENTIAL_COLUMNS)}
				FROM channel_mcp_credentials
				WHERE channel_id = ${channelId} AND name = ${name} AND principal_id = ${principalId}
			`;
			let row = rows[0];
			return row ? credential(row) : undefined;
		});

	readonly credentials = (
		channelId: string,
		principalId: string,
	): Promise<ChannelMcpCredential[]> =>
		this.#run("list channel MCP credentials", async () => {
			let rows = await this.#sql<CredentialRow[]>`
				SELECT ${this.#sql.unsafe(CREDENTIAL_COLUMNS)}
				FROM channel_mcp_credentials
				WHERE channel_id = ${channelId} AND principal_id = ${principalId}
				ORDER BY name ASC
			`;
			return rows.map(credential);
		});
}
