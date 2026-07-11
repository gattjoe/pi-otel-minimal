import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// Drives the extension's default export against a fake pi/ctx and a stubbed
// fetch, exercising the ok / non-2xx / network-failure reachability branches
// plus session_shutdown cleanup. The extension registers more than one
// handler per lifecycle event (status ping + Loki/span logic), so `pi.on`
// here collects handlers into arrays like the real runtime does.
function run(fetchImpl) {
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
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (key, text) => statuses.push([key, text]),
				theme: { fg: (color, text) => \`\${color}:\${text}\` },
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
				getEntries: () => [],
			},
		};

		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);

		await dispatch("session_start", { type: "session_start", reason: "startup" }, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		const afterStart = statuses.filter(([key]) => key === "otel-status").at(-1);

		await dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		const afterShutdown = statuses.filter(([key]) => key === "otel-status").at(-1);

		console.log(JSON.stringify({ afterStart, afterShutdown }));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("reachable endpoint reports success", () => {
	const { afterStart, afterShutdown } = run(`async () => new Response(null, { status: 200 })`);
	assert.deepEqual(afterStart, ["otel-status", "success:● traces OK"]);
	// JSON.stringify over the child boundary turns the real `undefined` into `null`.
	assert.deepEqual(afterShutdown, ["otel-status", null]);
});

test("non-2xx response reports the status code", () => {
	const { afterStart } = run(`async () => new Response(null, { status: 503 })`);
	assert.deepEqual(afterStart, ["otel-status", "error:● traces 503"]);
});

test("network failure reports unreachable", () => {
	const { afterStart } = run(`async () => { throw new Error("boom"); }`);
	assert.deepEqual(afterStart, ["otel-status", "error:● traces unreachable"]);
});
