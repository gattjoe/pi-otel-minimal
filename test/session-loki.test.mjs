import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

async function withSessionFile(lines, run) {
	const dir = await mkdtemp(join(tmpdir(), "--Users-joegatt-code-demo--"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	try {
		return await run(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// Drives the extension against a fake pi/ctx and a stubbed fetch, exercising
// the session_start(startup) -> session_start(resume) -> session_shutdown ship sequence.
// `pi.on` collects handlers into arrays (like the real runtime) since the
// extension registers more than one handler for session_start/shutdown.
function run(sessionFile, fetchImpl) {
	const script = `
		globalThis.fetch = ${fetchImpl};

		const handlers = {};
		const pi = {
			on: (event, handler) => { (handlers[event] ??= []).push(handler); },
		};
		async function dispatch(event, payload, ctx) {
			for (const handler of handlers[event] ?? []) await handler(payload, ctx);
		}

		const statuses = [];
		const requests = [];
		globalThis.__capture = (url, body) => requests.push({ url, body });

		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (key, text) => statuses.push([key, text]),
				theme: { fg: (color, text) => \`\${color}:\${text}\` },
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => ${JSON.stringify(sessionFile)},
				getEntries: () => [],
			},
		};

		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);

		await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		await dispatch("session_shutdown", { type: "session_shutdown" }, ctx);

		console.log(JSON.stringify({ statuses, requests }));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("ships session lines to Loki on shutdown", async () => {
	await withSessionFile(
		[
			{ type: "session", id: "session-1", timestamp: "2026-07-10T00:00:00.000Z" },
			{ type: "message", id: "m1", timestamp: "2026-07-10T00:00:01.000Z" },
		],
		async (file) => {
			const { statuses, requests } = run(
				file,
				`async (url, opts) => {
					globalThis.__capture(url, JSON.parse(opts.body));
					return new Response(null, { status: 204 });
				}`,
			);

			const lokiRequests = requests.filter((r) => r.url === "http://kenobi.echobase.network:30300/loki/api/v1/push");
			assert.equal(lokiRequests.length, 1);
			const stream = lokiRequests[0].body.streams[0];
			assert.equal(stream.stream.job, "pi-session");
			assert.equal(stream.stream.session_id, "session-1");
			assert.equal(stream.values.length, 2);
			assert.equal(statuses.filter(([key]) => key === "otel-loki").at(-1)[1], "success:● logs shipped");
		},
	);
});

test("does not ship the same session twice", async () => {
	await withSessionFile([{ type: "session", id: "session-1", timestamp: "2026-07-10T00:00:00.000Z" }], async (file) => {
		const script = `
			let lokiCalls = 0;
			globalThis.fetch = async (url) => {
				if (url === "http://kenobi.echobase.network:30300/loki/api/v1/push") lokiCalls++;
				return new Response(null, { status: 204 });
			};

			const handlers = {};
			const pi = {
				on: (event, handler) => { (handlers[event] ??= []).push(handler); },
			};
			async function dispatch(event, payload, ctx) {
				for (const handler of handlers[event] ?? []) await handler(payload, ctx);
			}
			const ctx = {
				hasUI: true,
				ui: { setStatus: () => {}, theme: { fg: (_c, t) => t } },
				sessionManager: {
					getSessionId: () => "session-1",
					getSessionFile: () => ${JSON.stringify(file)},
					getEntries: () => [],
				},
			};

			const extension = (await import(${JSON.stringify(indexUrl)})).default;
			extension(pi);

			await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
			await dispatch("session_start", { type: "session_start", reason: "resume" }, ctx);
			await dispatch("session_shutdown", { type: "session_shutdown" }, ctx);

			console.log(JSON.stringify({ lokiCalls }));
		`;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		assert.equal(JSON.parse(child.stdout.trim()).lokiCalls, 1);
	});
});

test("runs a full agent/turn/tool lifecycle without throwing and still ships to Loki", async () => {
	await withSessionFile([{ type: "session", id: "session-1", timestamp: "2026-07-10T00:00:00.000Z" }], async (file) => {
		const script = `
			globalThis.fetch = async (url) => {
				if (url === "http://kenobi.echobase.network:30300/loki/api/v1/push") {
					globalThis.__shipped = true;
				}
				return new Response(null, { status: 204 });
			};

			const handlers = {};
			const pi = {
				on: (event, handler) => { (handlers[event] ??= []).push(handler); },
			};
			async function dispatch(event, payload, ctx) {
				for (const handler of handlers[event] ?? []) await handler(payload, ctx);
			}
			const ctx = {
				hasUI: false,
				ui: { setStatus: () => {}, theme: { fg: (_c, t) => t } },
				sessionManager: {
					getSessionId: () => "session-1",
					getSessionFile: () => ${JSON.stringify(file)},
					getEntries: () => [],
				},
			};

			const extension = (await import(${JSON.stringify(indexUrl)})).default;
			extension(pi);

			await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
			await dispatch("input", { text: "do the thing", source: "interactive" }, ctx);
			await dispatch("agent_start", {}, ctx);
			await dispatch("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
			await dispatch("tool_call", { toolName: "bash", toolCallId: "call-1", input: { command: "ls" } }, ctx);
			await dispatch("tool_result", { toolName: "bash", toolCallId: "call-1", content: "ok", isError: false }, ctx);
			await dispatch("turn_end", { turnIndex: 0, toolResults: [], message: { stopReason: "stop" } }, ctx);
			await dispatch("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
			await dispatch("session_shutdown", { type: "session_shutdown" }, ctx);

			console.log(JSON.stringify({ shipped: Boolean(globalThis.__shipped) }));
		`;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim());
		assert.equal(result.shipped, true);
	});
});
