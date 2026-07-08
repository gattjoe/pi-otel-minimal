import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const extName = "otel-status";
	const endpoint = "https://otel.echobase.network/v1/traces";
	const intervalMs = 15 * 60 * 1000;

	// Minimal valid ExportTraceServiceRequest — one empty resourceSpan.
	const probe = JSON.stringify({
		resourceSpans: [{ scopeSpans: [] }],
	});

	let timer: ReturnType<typeof setInterval> | null = null;

	const update = async (ctx: ExtensionContext) => {
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: probe,
			});
			ctx.ui.setStatus(
				extName,
				res.ok
					? ctx.ui.theme.fg("success", "● traces OK")
					: ctx.ui.theme.fg("error", `● traces ${res.status}`),
			);
		} catch {
			ctx.ui.setStatus(extName, ctx.ui.theme.fg("error", "● traces unreachable"));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		update(ctx);
		timer = setInterval(() => update(ctx), intervalMs);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		ctx.ui.setStatus(extName, undefined);
	});
}
