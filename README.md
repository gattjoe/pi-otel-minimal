# Pi OTel Minimal

**One extension for pi coding agent telemetry: OTel endpoint status, live Tempo traces, and full session shipping to Loki.**

## Why Pi OTel Minimal

Three things, one extension, no external dependency:

- **Status** — pings the OTel endpoint every 15 minutes and shows a colored dot in the status bar so you know the collector is reachable.
- **Traces** — mirrors the session as a live OTel span tree (`pi.session` → `pi.agent` → `pi.turn` → `pi.tool: <name>`) to Tempo in real time, truncated (not redacted) for dashboards.
- **Logs** — ships the complete session `.jsonl` to Loki once a session ends — the same content pi uses for `--continue`/`--resume`/`--fork` — so full transcripts (including token usage/cost that never made it into spans) are searchable and retained centrally instead of living only on disk.

## Install

```bash
pi install git:github.com/gattjoe/pi-otel-minimal
```

Requires Pi v0.37.3+.

## What it does

**Status**: on session start, POSTs a minimal empty `ExportTraceServiceRequest` to the configured OTel endpoint every 15 minutes and reflects the result in the status bar. The poll stops and the status clears when the session ends.

| Status | Meaning |
|--------|---------|
| `● traces OK` | Endpoint returned 2xx |
| `● traces <code>` | Endpoint reachable but returned an error status |
| `● traces unreachable` | Request failed (network error, timeout, DNS, etc.) |

**Traces**: spans start and end live as the session runs (session/agent/turn/tool hierarchy), exported via OTLP/HTTP.

**Logs**: on `session_switch` and `session_shutdown`, reads the full session file and POSTs its lines as one stream to Loki (labels: `job=pi-session`, `project`, `session_id`). Each session is shipped exactly once, in full, after it ends — this does not stream partial content from a session that's still running.

| Status | Meaning |
|--------|---------|
| `● logs shipped` | Loki accepted the push |
| `● logs <code>` | Loki reachable but returned an error status |
| `● logs unreachable` | Request failed (network error, timeout, DNS, etc.) |

## Configuration

- OTel endpoint defaults to `https://otel.echobase.network/v1/traces`, overridable via `PI_OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` (and `_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`). The reachability status ping always targets this same configured endpoint.
- Loki endpoint (`http://kenobi.echobase.network:30300/loki/api/v1/push`) is a constant in `index.ts`.

Both paths ship raw session content as-is (tool output, file contents, everything) — these are private logs, so no redaction is applied anywhere. The only limit is an 8KB-per-attribute truncation on the Tempo path (payload size, not content filtering).
