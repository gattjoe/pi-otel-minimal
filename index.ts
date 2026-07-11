import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Attributes, type Span, SpanStatusCode, type Tracer, context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { TraceEnvStack, readParentSpanContext } from "./lib/trace-env.ts";

// ---------------------------------------------------------------------------
// Loki: ship the full session transcript once a session ends.
// ---------------------------------------------------------------------------

const lokiEndpoint = "http://kenobi.echobase.network:30300/loki/api/v1/push";

// Session dirs are named like "--Users-joegatt-code-pi-omlx--"; trim the
// delimiters so the Loki label reads as a project name.
export function extractProject(sessionFile: string): string {
	return basename(dirname(sessionFile)).replace(/^-+|-+$/g, "");
}

// Loki requires non-decreasing timestamps within a stream; session entries
// are chronological already but can share a millisecond, so nudge ties.
export function toNanosSequence(lines: string[]): string[] {
	let last = -1n;
	return lines.map((line) => {
		let nanos: bigint;
		try {
			const parsed = JSON.parse(line) as { timestamp?: string };
			const ms = parsed.timestamp ? Date.parse(parsed.timestamp) : Number.NaN;
			nanos = Number.isNaN(ms) ? BigInt(Date.now()) * 1_000_000n : BigInt(ms) * 1_000_000n;
		} catch {
			nanos = BigInt(Date.now()) * 1_000_000n;
		}
		if (nanos <= last) nanos = last + 1n;
		last = nanos;
		return nanos.toString();
	});
}

export function buildLokiPayload(sessionId: string, project: string, lines: string[]) {
	const timestamps = toNanosSequence(lines);
	return {
		streams: [
			{
				stream: { job: "pi-session", project, session_id: sessionId },
				values: lines.map((line, i) => [timestamps[i], line]),
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Reachability: periodic status-bar dot showing whether the OTel endpoint is
// up, independent of whether the current session produces any spans.
// ---------------------------------------------------------------------------

const REACHABILITY_INTERVAL_MS = 15 * 60 * 1000;

// Minimal valid ExportTraceServiceRequest — one empty resourceSpan.
const REACHABILITY_PROBE_BODY = JSON.stringify({ resourceSpans: [{ scopeSpans: [] }] });

// ---------------------------------------------------------------------------
// OTel: mirror the session as a live span tree in Tempo.
// ---------------------------------------------------------------------------

const DEFAULT_OTEL_ENDPOINT = "https://otel.echobase.network/v1/traces";
const DEFAULT_SERVICE_NAME = "pi-agent";
const PAYLOAD_MAX_BYTES = 8 * 1024;
const INPUT_PREVIEW_MAX_CHARS = 50;
const TOOL_COMMAND_PREVIEW_MAX_CHARS = 120;

interface TelemetryConfig {
	endpoint: string;
	headers: Record<string, string>;
	serviceName: string;
	resourceAttributes: Record<string, string>;
}

interface SpanRegistry {
	session?: Span;
	agent?: Span;
	turns: Map<number, Span>;
	tools: Map<string, Span>;
}

interface InputSummary {
	preview: string;
	previewBytes: number;
	previewTruncated: boolean;
}

function getEnvValue(key: string): string | undefined {
	return process.env[`PI_${key}`] ?? process.env[key];
}

function parseKeyValuePairs(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	return Object.fromEntries(
		raw.split(",").flatMap((pair) => {
			const eq = pair.indexOf("=");
			return eq > 0 ? [[pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as [string, string]] : [];
		}),
	);
}

// A session inherits its agent name from PI_AGENT_CHAIN (set by pi when spawning
// sub-agents), e.g. "main>ask" -> "ask". Only the last link matters here.
function getCurrentAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.PI_AGENT_CHAIN?.trim();
	if (!raw) return undefined;
	const chain = raw
		.split(">")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return chain.length > 0 ? chain[chain.length - 1] : undefined;
}

function resolveServiceName(): string {
	const explicitServiceName = getEnvValue("OTEL_SERVICE_NAME");
	if (explicitServiceName) return explicitServiceName;

	const agentName = getCurrentAgentName();
	if (agentName) return agentName;

	return DEFAULT_SERVICE_NAME;
}

function loadOtelConfig(): TelemetryConfig {
	const rawEndpoint = getEnvValue("OTEL_EXPORTER_OTLP_ENDPOINT");
	const endpoint =
		rawEndpoint && !rawEndpoint.endsWith("/v1/traces") ? rawEndpoint + "/v1/traces" : (rawEndpoint ?? DEFAULT_OTEL_ENDPOINT);
	const headers = parseKeyValuePairs(getEnvValue("OTEL_EXPORTER_OTLP_HEADERS"));
	const serviceName = resolveServiceName();
	const resourceAttributes = parseKeyValuePairs(getEnvValue("OTEL_RESOURCE_ATTRIBUTES"));
	console.error(
		`[pi-otel-minimal] otel endpoint=${endpoint} service=${serviceName} headers=${headers ? JSON.stringify(headers) : "none"}`,
	);

	return { endpoint, headers, serviceName, resourceAttributes };
}

function serializePayload(value: unknown): { text: string; bytes: number; truncated: boolean } {
	const text = JSON.stringify(value) ?? "null";
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= PAYLOAD_MAX_BYTES) {
		return { text, bytes, truncated: false };
	}

	const truncatedText = text.slice(0, PAYLOAD_MAX_BYTES);
	return { text: truncatedText, bytes, truncated: true };
}

function buildPayloadAttributes(prefix: string, value: unknown): Attributes {
	const payload = serializePayload(value);
	return {
		[`${prefix}`]: payload.text,
		[`${prefix}.bytes`]: payload.bytes,
		[`${prefix}.truncated`]: payload.truncated,
	};
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function trimTextByWord(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) {
		return { text: value, truncated: false };
	}

	const words = value.split(" ");
	let result = "";
	for (const word of words) {
		const next = result ? `${result} ${word}` : word;
		if (next.length > maxChars) break;
		result = next;
	}

	if (!result) {
		return { text: value.slice(0, maxChars), truncated: true };
	}

	return { text: result, truncated: true };
}

function buildInputSummary(text: string): InputSummary {
	const preview = trimTextByWord(normalizeText(text), INPUT_PREVIEW_MAX_CHARS);
	return {
		preview: preview.text,
		previewBytes: Buffer.byteLength(preview.text, "utf8"),
		previewTruncated: preview.truncated,
	};
}

function buildInputSummaryAttributes(prefix: string, summary: InputSummary): Attributes {
	return {
		[`${prefix}.preview`]: summary.preview,
		[`${prefix}.preview.bytes`]: summary.previewBytes,
		[`${prefix}.preview.truncated`]: summary.previewTruncated,
	};
}

function buildToolSpanName(toolName: string, input: unknown): string {
	if (toolName !== "bash") {
		return `pi.tool: ${toolName}`;
	}

	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") {
		return `pi.tool: ${toolName}`;
	}

	const normalized = normalizeText(command);
	if (!normalized) {
		return `pi.tool: ${toolName}`;
	}

	const trimmed = trimTextByWord(normalized, TOOL_COMMAND_PREVIEW_MAX_CHARS);
	const suffix = trimmed.truncated ? `${trimmed.text}…` : trimmed.text;
	return `pi.tool: ${toolName}(${suffix})`;
}

function addSpanEvent(span: Span | undefined, type: string, attrs: Attributes): void {
	if (!span) return;
	span.addEvent(type, { "pi.event.type": type, ...attrs });
}

function ensureAttribute(span: Span, key: string, value: string | number | boolean | undefined): void {
	if (value === undefined) return;
	span.setAttribute(key, value);
}

function createTracer(config: TelemetryConfig): { tracer: Tracer; shutdown: () => Promise<void> } {
	const resource = resourceFromAttributes({
		...config.resourceAttributes,
		"service.name": config.serviceName,
	});

	const exporter = new OTLPTraceExporter({ url: config.endpoint, headers: config.headers });
	const processor = new BatchSpanProcessor(exporter);
	const provider = new BasicTracerProvider({ resource, spanProcessors: [processor] });

	return {
		tracer: provider.getTracer("pi-otel-minimal", "0.1.0"),
		shutdown: async () => {
			try {
				await provider.forceFlush();
			} catch (e) {
				console.error(`[pi-otel-minimal] otel flush error: ${(e as Error).message}`);
			}
			try {
				await provider.shutdown();
			} catch (e) {
				console.error(`[pi-otel-minimal] otel shutdown error: ${(e as Error).message}`);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	// -- Loki state --------------------------------------------------------
	const shippedToLoki = new Set<string>();
	let activeSessionId: string | undefined;
	let activeSessionFile: string | undefined;

	const shipSessionToLoki = async (
		ctx: ExtensionContext,
		sessionId: string | undefined,
		sessionFile: string | undefined,
	) => {
		if (!sessionId || !sessionFile || shippedToLoki.has(sessionId)) return;
		shippedToLoki.add(sessionId);

		try {
			const content = await readFile(sessionFile, "utf8");
			const lines = content.split("\n").filter(Boolean);
			if (lines.length === 0) return;

			const res = await fetch(lokiEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildLokiPayload(sessionId, extractProject(sessionFile), lines)),
			});

			ctx.ui.setStatus(
				"otel-loki",
				res.ok ? ctx.ui.theme.fg("success", "● logs shipped") : ctx.ui.theme.fg("error", `● logs ${res.status}`),
			);
		} catch {
			ctx.ui.setStatus("otel-loki", ctx.ui.theme.fg("error", "● logs unreachable"));
		}
	};

	// -- OTel state ----------------------------------------------------------
	const otelConfig = loadOtelConfig();
	let otelRuntime: { tracer: Tracer; shutdown: () => Promise<void> } | undefined;

	function ensureOtelRuntime() {
		otelRuntime ??= createTracer(otelConfig);
		return otelRuntime;
	}

	const spans: SpanRegistry = { turns: new Map(), tools: new Map() };
	const traceEnvStack = new TraceEnvStack();

	let otelSessionId: string | undefined;
	let activeTurnIndex: number | undefined;
	let lastInputSummary: InputSummary | undefined;
	let otelShutdownTriggered = false;

	function updateTraceStatus(ctx: ExtensionContext, traceId: string | undefined): void {
		if (!ctx.hasUI) return;
		if (!traceId) {
			ctx.ui.setStatus("otel-trace", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("otel-trace", theme.fg("dim", `trace ${traceId.slice(0, 8)}`));
	}

	function ensureSessionSpan(ctx: ExtensionContext): Span {
		if (spans.session) return spans.session;

		otelSessionId = ctx.sessionManager.getSessionId();

		const parentSpanContext = readParentSpanContext();
		const parentContext = parentSpanContext ? trace.setSpanContext(context.active(), parentSpanContext) : context.active();

		const span = ensureOtelRuntime().tracer.startSpan("pi.session", { startTime: Date.now() }, parentContext);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		ensureAttribute(span, "pi.session.file", ctx.sessionManager.getSessionFile());

		traceEnvStack.push("session", span);
		updateTraceStatus(ctx, span.spanContext().traceId);
		spans.session = span;
		return span;
	}

	function endSpan(span: Span | undefined, endTime?: number): void {
		if (!span) return;
		span.end(endTime);
	}

	function closeOrphanToolSpans(reason: string): void {
		for (const [toolCallId, span] of spans.tools.entries()) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: `Closed without tool_result (${reason})` });
			span.setAttribute("pi.tool.missing_result", true);
			span.end();
			traceEnvStack.pop(`tool:${toolCallId}`);
		}
		spans.tools.clear();
	}

	function closeOrphanTurnSpans(reason: string): void {
		for (const [turnIndex, span] of spans.turns.entries()) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: `Closed without turn_end (${reason})` });
			span.setAttribute("pi.turn.missing_end", true);
			span.end();
			traceEnvStack.pop(`turn:${turnIndex}`);
		}
		spans.turns.clear();
		activeTurnIndex = undefined;
	}

	function closeOrphanAgentSpan(reason: string): void {
		if (!spans.agent) return;
		spans.agent.setStatus({ code: SpanStatusCode.ERROR, message: `Closed without agent_end (${reason})` });
		spans.agent.setAttribute("pi.agent.missing_end", true);
		spans.agent.end();
		spans.agent = undefined;
		traceEnvStack.pop("agent");
	}

	// -- Combined session/span/Loki lifecycle hooks --------------------------

	pi.on("session_start", (_event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
		activeSessionFile = ctx.sessionManager.getSessionFile();

		otelSessionId = activeSessionId;
		lastInputSummary = undefined;
		ensureSessionSpan(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await shipSessionToLoki(ctx, activeSessionId, activeSessionFile);
		activeSessionId = ctx.sessionManager.getSessionId();
		activeSessionFile = ctx.sessionManager.getSessionFile();

		closeOrphanToolSpans("session_switch");
		closeOrphanTurnSpans("session_switch");
		closeOrphanAgentSpan("session_switch");
		endSpan(spans.session, Date.now());
		spans.session = undefined;
		traceEnvStack.clear();
		updateTraceStatus(ctx, undefined);
		otelSessionId = activeSessionId;
		lastInputSummary = undefined;
		ensureSessionSpan(ctx);
	});

	pi.on("input", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const summary = buildInputSummary(event.text);
		lastInputSummary = summary;

		addSpanEvent(sessionSpan, "input", {
			"pi.event.source": event.source,
			"pi.input.images": event.images?.length ?? 0,
			...buildPayloadAttributes("pi.input.text", event.text),
			...buildInputSummaryAttributes("pi.input", summary),
		});

		if (summary.preview) sessionSpan.updateName(`pi.session ${summary.preview}`);
	});

	pi.on("agent_start", (_event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const parent = trace.setSpan(context.active(), sessionSpan);
		const span = ensureOtelRuntime().tracer.startSpan("pi.agent", { startTime: Date.now() }, parent);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		if (lastInputSummary) {
			for (const [key, value] of Object.entries(buildInputSummaryAttributes("pi.input.latest", lastInputSummary))) {
				span.setAttribute(key, value as string | number | boolean);
			}
			if (lastInputSummary.preview) span.updateName(`pi.agent ${lastInputSummary.preview}`);
		}

		traceEnvStack.push("agent", span);
		updateTraceStatus(ctx, span.spanContext().traceId);
		spans.agent = span;
	});

	pi.on("turn_start", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const parent = trace.setSpan(context.active(), spans.agent ?? sessionSpan);
		activeTurnIndex = event.turnIndex;

		const span = ensureOtelRuntime().tracer.startSpan("pi.turn", { startTime: event.timestamp ?? Date.now() }, parent);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		ensureAttribute(span, "pi.turn.index", event.turnIndex);

		spans.turns.set(event.turnIndex, span);
		traceEnvStack.push(`turn:${event.turnIndex}`, span);
	});

	pi.on("tool_call", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const parentSpan = activeTurnIndex !== undefined ? spans.turns.get(activeTurnIndex) : spans.agent;
		const parent = trace.setSpan(context.active(), parentSpan ?? sessionSpan);

		const span = ensureOtelRuntime().tracer.startSpan(buildToolSpanName(event.toolName, event.input), { startTime: Date.now() }, parent);

		ensureAttribute(span, "pi.session.id", otelSessionId);
		ensureAttribute(span, "pi.turn.index", activeTurnIndex);
		ensureAttribute(span, "pi.tool.name", event.toolName);
		ensureAttribute(span, "pi.tool.call_id", event.toolCallId);

		spans.tools.set(event.toolCallId, span);
		traceEnvStack.push(`tool:${event.toolCallId}`, span);

		addSpanEvent(span, "tool_call", buildPayloadAttributes("pi.tool.input", event.input));
	});

	pi.on("tool_result", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const span = spans.tools.get(event.toolCallId);
		const outputPayload = { content: event.content, details: event.details };

		addSpanEvent(span ?? sessionSpan, "tool_result", {
			"pi.tool.name": event.toolName,
			"pi.tool.call_id": event.toolCallId,
			"pi.tool.is_error": event.isError,
			...buildPayloadAttributes("pi.tool.output", outputPayload),
		});

		if (span) {
			if (event.isError) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: "tool_result error" });
			}
			span.end();
			spans.tools.delete(event.toolCallId);
		}

		traceEnvStack.pop(`tool:${event.toolCallId}`);
	});

	pi.on("turn_end", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const span = spans.turns.get(event.turnIndex);
		const turnStopReason = "stopReason" in event.message ? event.message.stopReason : undefined;

		addSpanEvent(span ?? sessionSpan, "turn_end", {
			"pi.turn.index": event.turnIndex,
			"pi.turn.tool_results": event.toolResults.length,
			"pi.message.stop_reason": turnStopReason ?? "",
		});

		endSpan(span, Date.now());
		spans.turns.delete(event.turnIndex);
		traceEnvStack.pop(`turn:${event.turnIndex}`);
		if (activeTurnIndex === event.turnIndex) {
			activeTurnIndex = undefined;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
		const stopReason = lastAssistant && "stopReason" in lastAssistant ? lastAssistant.stopReason : undefined;

		addSpanEvent(spans.agent ?? sessionSpan, "agent_end", { "pi.message.stop_reason": stopReason ?? "" });

		closeOrphanToolSpans("agent_end");
		closeOrphanTurnSpans("agent_end");
		endSpan(spans.agent, Date.now());
		spans.agent = undefined;
		traceEnvStack.pop("agent");

		if (!ctx.hasUI && !otelShutdownTriggered) {
			otelShutdownTriggered = true;
			endSpan(spans.session, Date.now());
			spans.session = undefined;
			traceEnvStack.clear();
			try {
				await otelRuntime?.shutdown();
			} catch (e) {
				console.error(`[pi-otel-minimal] otel shutdown error: ${(e as Error).message}`);
			}
		}
	});

	pi.on("model_select", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		addSpanEvent(sessionSpan, "model_select", {
			"pi.model.provider": event.model.provider,
			"pi.model.id": event.model.id,
			"pi.model.source": event.source,
		});
	});

	pi.on("session_compact", (event, ctx) => {
		const sessionSpan = ensureSessionSpan(ctx);
		addSpanEvent(sessionSpan, "session_compact", {
			"pi.compaction.first_kept_entry": event.compactionEntry?.firstKeptEntryId ?? "",
			"pi.compaction.tokens_before": event.compactionEntry?.tokensBefore ?? 0,
			...buildPayloadAttributes("pi.compaction.summary", event.compactionEntry?.summary),
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await shipSessionToLoki(ctx, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());

		if (otelShutdownTriggered) return;
		otelShutdownTriggered = true;

		ensureSessionSpan(ctx);
		closeOrphanToolSpans("session_shutdown");
		closeOrphanTurnSpans("session_shutdown");
		closeOrphanAgentSpan("session_shutdown");

		endSpan(spans.session, Date.now());
		spans.session = undefined;
		traceEnvStack.clear();
		updateTraceStatus(ctx, undefined);

		try {
			await otelRuntime?.shutdown();
		} catch (e) {
			console.error(`[pi-otel-minimal] otel shutdown error: ${(e as Error).message}`);
		}
	});

	// -- Reachability: independent status-bar ping ---------------------------

	let reachabilityTimer: ReturnType<typeof setInterval> | null = null;

	async function pingOtelEndpoint(ctx: ExtensionContext): Promise<void> {
		try {
			const res = await fetch(otelConfig.endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: REACHABILITY_PROBE_BODY,
			});
			ctx.ui.setStatus(
				"otel-status",
				res.ok ? ctx.ui.theme.fg("success", "● traces OK") : ctx.ui.theme.fg("error", `● traces ${res.status}`),
			);
		} catch {
			ctx.ui.setStatus("otel-status", ctx.ui.theme.fg("error", "● traces unreachable"));
		}
	}

	pi.on("session_start", (_event, ctx) => {
		pingOtelEndpoint(ctx);
		reachabilityTimer = setInterval(() => pingOtelEndpoint(ctx), REACHABILITY_INTERVAL_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (reachabilityTimer) {
			clearInterval(reachabilityTimer);
			reachabilityTimer = null;
		}
		ctx.ui.setStatus("otel-status", undefined);
	});
}
