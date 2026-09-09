-- Channel-scoped MCP servers a chat's Planner may call, plus each member's
-- own credential for them. Channel rows cascade with the channel; credentials
-- cascade with the channel and are sealed per (channel, principal).

-- Channel-scoped MCP servers a chat's Planner may call, plus each member's
-- own credential for them. Channel rows cascade with the channel; credentials
-- cascade with the channel and are sealed per (channel, principal).

CREATE TABLE channel_mcps (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	name text NOT NULL,
	url text NOT NULL,
	added_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channel_mcps ADD CONSTRAINT channel_mcps_channel_name_unique UNIQUE (channel_id, name);

CREATE TABLE channel_mcp_credentials (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	name text NOT NULL,
	principal_id text NOT NULL,
	sealed bytea NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (channel_id, name, principal_id),
	FOREIGN KEY (channel_id, name) REFERENCES channel_mcps (channel_id, name) ON DELETE CASCADE
);
