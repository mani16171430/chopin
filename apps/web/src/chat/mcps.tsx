/**
 * The chat's MCP servers.
 *
 * Definitions are shared by the channel; each member's credential for one is
 * private — set or cleared here, stored server-side sealed, and never shown.
 * Adding or removing a server, or a member setting their credential, refreshes
 * the room's Planner so the next turn sees the new set.
 *
 * The panel opens from the chat header; its trigger lives beside the Chat
 * toggle. Editors may add or remove a server; every member may set or clear
 * their own credential for one.
 */

import { useEffect, useRef, useState } from "react";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type McpsProps = {
	wire: Socket | undefined;
	canManage: boolean;
	connected: boolean;
};

type Server = Wire.Mcp;

function nameOk(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
}

export function Mcps({ canManage, connected, wire }: McpsProps) {
	let [servers, setServers] = useState<Server[]>([]);
	let [open, setOpen] = useState(false);
	let [adding, setAdding] = useState(false);
	let [name, setName] = useState("");
	let [url, setUrl] = useState("");
	let [token, setToken] = useState("");
	let [error, setError] = useState<string>();
	let panel = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!wire || !connected) return;
		let off = [
			wire.on<Wire.Mcps>("chat:mcps", frame => setServers(frame.servers)),
			wire.on<Wire.McpCredentialAck>("chat:mcp:credential", frame => {
				setServers(current =>
					current.map(server =>
						server.name === frame.name
							? { ...server, has_credential: frame.has_credential }
							: server
					)
				);
			}),
		];
		wire.send("chat:mcp:list");
		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire, connected]);

	useEffect(() => {
		if (!open) return;
		let close = (event: MouseEvent) => {
			if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
		};
		let key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", key);
		};
	}, [open]);

	let submitAdd = () => {
		if (!wire || !nameOk(name.trim()) || !url.trim()) return;
		setError(undefined);
		wire.send("chat:mcp:add", {
			name: name.trim(),
			url: url.trim(),
			...(token.trim() ? { auth: { kind: "bearer", token: token.trim() } } : {}),
		});
		setName("");
		setUrl("");
		setToken("");
		setAdding(false);
	};

	let toggleCredential = (server: Server) => {
		if (!wire) return;
		if (server.has_credential) {
			wire.send("chat:mcp:credential", { name: server.name });
		} else {
			let value = window.prompt(`Token for ${server.name} (stored for you only):`);
			if (value?.trim()) {
				wire.send("chat:mcp:credential", {
					name: server.name,
					auth: { kind: "bearer", token: value.trim() },
				});
			}
		}
	};

	if (!connected) return null;

	return (
		<div className="relative" ref={panel}>
			<button
				aria-expanded={open}
				aria-label="MCP servers"
				className="btn btn-sm btn-ghost shrink-0"
				onClick={() => setOpen(value => !value)}
				title="MCP servers for this chat"
				type="button"
			>
				<span className="" aria-hidden="true">Add MCP</span>
			</button>
			{open && (
				<div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-edge bg-page p-3 shadow-raised">
					<div className="mb-2 flex items-center justify-between">
						<h3 className="text-[13px] font-medium">MCP servers</h3>
						<button
							aria-label="Close MCP servers"
							className="text-text-tertiary hover:text-text-secondary"
							onClick={() => setOpen(false)}
							type="button"
						>
							×
						</button>
					</div>
					{servers.length === 0 && (
						<p className="text-[12px] text-text-tertiary">
							None. Added servers are private to this chat.
						</p>
					)}
					<div className="space-y-2">
						{servers.map(server => (
							<div
								key={server.name}
								className="rounded-md border border-edge p-2.5"
							>
								<div className="flex items-center justify-between gap-2">
									<div className="min-w-0">
										<div className="truncate text-[12px] font-medium">{server.name}</div>
									</div>
									{canManage && (
										<button
											className="shrink-0 text-[11px] text-text-tertiary hover:text-destructive-ink"
											onClick={() => wire?.send("chat:mcp:remove", { name: server.name })}
											type="button"
										>
											Remove
										</button>
									)}
								</div>
								<button
									className="mt-1.5 text-[11px] text-text-tertiary hover:text-text-secondary"
									onClick={() => toggleCredential(server)}
									type="button"
								>
									{server.has_credential ? "Clear my credential" : "Add my credential"}
								</button>
							</div>
						))}
					</div>
					{canManage && !adding && (
						<button
							className="mt-2 text-[12px] text-brand-ink hover:underline"
							onClick={() => setAdding(true)}
							type="button"
						>
							Add MCP server
						</button>
					)}
					{canManage && adding && (
						<div className="mt-2 space-y-2">
							<input
								className="w-full rounded border border-edge bg-transparent px-2 py-1 text-[12px]"
								onChange={event => setName(event.currentTarget.value)}
								placeholder="name (e.g. docs-search)"
								value={name}
							/>
							<input
								className="w-full rounded border border-edge bg-transparent px-2 py-1 text-[12px]"
								onChange={event => setUrl(event.currentTarget.value)}
								placeholder="https://…/mcp"
								value={url}
							/>
							<input
								className="w-full rounded border border-edge bg-transparent px-2 py-1 text-[12px]"
								onChange={event => setToken(event.currentTarget.value)}
								placeholder="my bearer token (optional, private to me)"
								type="password"
								value={token}
							/>
							{error && <p className="text-[11px] text-destructive-ink">{error}</p>}
							<div className="flex gap-2">
								<button
									className="rounded bg-brand px-2 py-1 text-[12px] text-page disabled:opacity-50"
									disabled={!nameOk(name.trim()) || !url.trim()}
									onClick={submitAdd}
									type="button"
								>
									Add
								</button>
								<button
									className="text-[12px] text-text-tertiary"
									onClick={() => {
										setAdding(false);
										setError(undefined);
									}}
									type="button"
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
