import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// Drives the extension's default export against a fake pi/ctx and a stubbed
// fetch, exercising the ok / non-2xx / network-failure status branches plus
// the session_shutdown cleanup.
function run(fetchImpl) {
	const script = `
		globalThis.fetch = ${fetchImpl};

		const handlers = {};
		const pi = { on: (event, handler) => { handlers[event] = handler; } };

		const statuses = [];
		const ctx = {
			ui: {
				setStatus: (key, text) => statuses.push([key, text]),
				theme: { fg: (color, text) => \`\${color}:\${text}\` },
			},
		};

		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);

		await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		const afterStart = statuses.at(-1);

		await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		const afterShutdown = statuses.at(-1);

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
