-- Channel-scoped relation links — the "Links" graph. The planner connects a
-- channel's document to the repositories, pull requests and AI Docs it is
-- about. (channel_id, kind, ref_key) is unique so linking is idempotent — a
-- re-run refreshes rather than duplicates. Rows cascade with the channel.
-- Non-secret — stored in the clear.

CREATE TABLE channel_links (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	kind text NOT NULL,
	ref_key text NOT NULL,
	title text NOT NULL,
	subtitle text,
	url text,
	created_by text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX channel_links_identity ON channel_links (channel_id, kind, ref_key);
CREATE INDEX channel_links_channel ON channel_links (channel_id, kind, title);
