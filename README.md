# Pi OTel Status

**Status bar indicator for Pi agent showing OpenTelemetry trace-endpoint reachability.**

## Why Pi OTel Status

**Minimal** — Pings your OTel traces endpoint every few seconds and shows a colored dot in the status bar: reachable, erroring, or unreachable. No spans, no config, no dependencies.

## Install

```bash
pi install git:github.com/gattjoe/pi-otel-status
```

Requires Pi v0.37.3+.

## What it does

On session start, the extension POSTs a minimal empty `ExportTraceServiceRequest` to the configured endpoint every 5 seconds and reflects the result in the status bar:

| Status | Meaning |
|--------|---------|
| `● traces OK` | Endpoint returned 2xx |
| `● traces <code>` | Endpoint reachable but returned an error status |
| `● traces unreachable` | Request failed (network error, timeout, DNS, etc.) |

The poll stops and the status clears when the session ends.

## Configuration

The endpoint (`https://otel.echobase.network/v1/traces`) and poll interval (5s) are set as constants in `index.ts`. Edit them directly if you point at a different collector.
