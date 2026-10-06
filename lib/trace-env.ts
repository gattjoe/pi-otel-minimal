const TRACE_ID_ENV = "PI_AGENT_TRACE_ID";
const SPAN_ID_ENV = "PI_AGENT_SPAN_ID";

const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const TRACE_FLAGS_SAMPLED = 0x01;

interface SpanContextLike {
	traceId: string;
	spanId: string;
	traceFlags: number;
	isRemote?: boolean;
}

export interface SpanLike {
	spanContext(): { traceId: string; spanId: string };
}

function isValidHexId(value: string, length: number): boolean {
	if (value.length !== length) return false;
	if (!/^[0-9a-f]+$/i.test(value)) return false;
	return !/^0+$/.test(value);
}

function isValidTraceId(value: string): boolean {
	return isValidHexId(value, TRACE_ID_LENGTH);
}

function isValidSpanId(value: string): boolean {
	return isValidHexId(value, SPAN_ID_LENGTH);
}

export function readParentSpanContext(env: NodeJS.ProcessEnv = process.env): SpanContextLike | undefined {
	const traceId = env[TRACE_ID_ENV];
	const spanId = env[SPAN_ID_ENV];

	if (!traceId || !spanId) return undefined;
	if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return undefined;

	return {
		traceId,
		spanId,
		traceFlags: TRACE_FLAGS_SAMPLED,
		isRemote: true,
	};
}

function syncTraceEnv(span: SpanLike, env: NodeJS.ProcessEnv = process.env): void {
	const { traceId, spanId } = span.spanContext();
	const existingTraceId = env[TRACE_ID_ENV];

	if (!existingTraceId || !isValidTraceId(existingTraceId)) {
		env[TRACE_ID_ENV] = traceId;
	}

	env[SPAN_ID_ENV] = spanId;
}

/** Tracks the active span per nested scope (session/agent/turn/tool) and syncs it to env for cross-process propagation. */
export class TraceEnvStack {
	private stack: Array<{ key: string; span: SpanLike }> = [];
	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
	}

	push(key: string, span: SpanLike): void {
		const existingIndex = this.stack.findIndex((entry) => entry.key === key);
		if (existingIndex !== -1) {
			this.stack.splice(existingIndex, 1);
		}

		this.stack.push({ key, span });
		syncTraceEnv(span, this.env);
	}

	pop(key: string): void {
		const index = this.stack.findIndex((entry) => entry.key === key);
		if (index === -1) return;

		const wasTop = index === this.stack.length - 1;
		this.stack.splice(index, 1);

		const top = this.stack[this.stack.length - 1];
		if (wasTop && top) {
			syncTraceEnv(top.span, this.env);
		}
	}

	// Called only at genuine session-end boundaries (session replacement via session_start, agent_end
	// shutdown, session_shutdown). Must also drop the env vars themselves —
	// leaving them set is what let a finished session's trace/span IDs leak
	// into the next, unrelated session as a stale parent context.
	clear(): void {
		this.stack = [];
		delete this.env[TRACE_ID_ENV];
		delete this.env[SPAN_ID_ENV];
	}
}
