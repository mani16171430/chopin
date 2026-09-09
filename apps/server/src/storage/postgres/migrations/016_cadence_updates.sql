-- Channel-scoped Cadence work-item proposals. The agent regenerates the whole
-- list for a channel; members edit fields, set status, and record push
-- results. Rows cascade with the channel. Non-secret — stored in the clear.

CREATE TABLE channel_cadence_updates (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	team text NOT NULL DEFAULT '',
	op text NOT NULL,
	target_id text,
	kind text NOT NULL,
	title text NOT NULL,
	fields jsonb NOT NULL DEFAULT '{}'::jsonb,
	confidence real NOT NULL DEFAULT 0,
	needs jsonb NOT NULL DEFAULT '[]'::jsonb,
	status text NOT NULL,
	mcp_server text NOT NULL,
	mcp_tool text NOT NULL,
	pushed_url text,
	error text,
	updated_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX channel_cadence_updates_group ON channel_cadence_updates (channel_id, team, title);
