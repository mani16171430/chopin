import { describe, expect, it } from "bun:test";

import {
	readGeneralChannelRecovery,
	readGeneralDocumentRecovery,
	rememberGeneralChannel,
} from "./general-recovery";

function storage(): Storage {
	let entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear: () => entries.clear(),
		getItem: key => entries.get(key) ?? null,
		key: index => [...entries.keys()][index] ?? null,
		removeItem: key => void entries.delete(key),
		setItem: (key, value) => void entries.set(key, value),
	};
}

describe("general channel recovery", () => {
	it("remembers a general document by channel id and by its general path", () => {
		let session = storage();
		rememberGeneralChannel(
			"user-one",
			{ id: "channel-one", title: "Launch brief", slug: "launch-brief" },
			session,
		);

		expect(readGeneralChannelRecovery("user-one", "channel-one", session)).toEqual({
			channel: { id: "channel-one", title: "Launch brief", slug: "launch-brief" },
		});
		expect(readGeneralDocumentRecovery("user-one", "launch-brief", session)).toEqual({
			channel: { id: "channel-one", title: "Launch brief", slug: "launch-brief" },
		});
		expect(readGeneralDocumentRecovery("user-one", "other-slug", session)).toBeUndefined();
		expect(readGeneralChannelRecovery("user-two", "channel-one", session)).toBeUndefined();
	});

	it("never throws when storage is unavailable", () => {
		let broken = {
			get length() {
				throw new Error("blocked");
			},
			clear() {},
			getItem(): null {
				throw new Error("blocked");
			},
			key(): null {
				throw new Error("blocked");
			},
			removeItem() {},
			setItem() {
				throw new Error("blocked");
			},
		} as unknown as Storage;
		expect(() => rememberGeneralChannel("user-one", { id: "c", title: "t", slug: "s" }, broken)).not
			.toThrow();
		expect(readGeneralDocumentRecovery("user-one", "s", broken)).toBeUndefined();
	});
});
