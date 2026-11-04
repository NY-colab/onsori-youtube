# OnSori cloud pilot gateway

This is an independent upload gateway prepared for a small CPU-only server.
It does not change the existing local server or extension. It does not load a
model, download weights, fetch YouTube URLs or accept an arbitrary source URL.
Only explicitly uploaded PCM16 mono 16 kHz WAV files are accepted.

The default `ONSORI_PROVIDER=disabled` rejects inference. `mock` produces visibly
labelled synthetic test captions without a network request. DeepInfra is enabled
only when **both** `ONSORI_PROVIDER=deepinfra` and `ONSORI_ALLOW_PAID=true` are set
along with a provider API key. No actual paid inference was performed for this
preparation. The external integration still needs an authorized, consented sample
and review of real Korean timestamps before production use.

## Run locally / on the eventual server

Use Python 3.12 and a **separate virtual environment**, not the local ASR server's
requirements. Run commands from the `outputs/onsori` directory:

```sh
python3.12 -m venv .venv-gateway
.venv-gateway/bin/python -m pip install -r cloud_gateway/requirements.txt
# Supply the environment variables in .env.example through the service manager.
# The application does not automatically read .env files.
.venv-gateway/bin/python -m uvicorn cloud_gateway.app:app --host 127.0.0.1 --port 8775 --workers 1 --no-access-log
```

Set `ONSORI_API_TOKEN` and `ONSORI_METRICS_TOKEN` to independent random ASCII
secrets of at least 32 characters (for example, two separately generated
`secrets.token_urlsafe(32)` values). Keep the API token restricted to the pilot
administrator; it grants access to all pilot jobs. Provider credentials belong
only on the server. The metrics token cannot call job routes and the API token
cannot read metrics. Startup fails closed for missing or equal tokens.

The configured data directory is locked against a second gateway instance.
Use exactly one process and one worker. Bind to loopback behind a TLS reverse
proxy; apply proxy upload/body timeouts and per-client connection/request limits.
Do not expose port 8775 or the administrator token publicly. No permissive CORS
policy is installed. An extension integration needs its explicit host permission
and an intentional client configuration; the existing extension remains local.

`ONSORI_DATA_DIR` should be a dedicated persistent directory owned by the service
user with mode 0700 and a service umask of 0077. SQLite must remain on persistent
local disk across restarts. Deleting/restoring an old database also deletes or
rewinds its budget/idempotency evidence and can allow a new paid call. Keep this
state outside release replacement paths. Encrypted storage/backups and their
retention policy are deployment responsibilities.

## HTTP contract

All `/v1/*` routes require `Authorization: Bearer <ONSORI_API_TOKEN>`.

| Method/path | Behavior |
| --- | --- |
| `GET /healthz` | Public minimal worker readiness (`status` only). |
| `GET /v1/status` | Configured provider, enabled/synthetic flags, scope, counts and limits. |
| `POST /v1/jobs` | Multipart `file`, `consent=true`, `language=ko`, optional `video_id` (11 YouTube ID characters), optional `title` (300 chars). Requires `Idempotency-Key` (8–128 ASCII letters/digits/`._:-`). New job: 202; identical replay: 200; different body under the same key: 409. |
| `GET /v1/jobs/{id}` | Poll status and final `result` document. |
| `DELETE /v1/jobs/{id}` | Cancel locally; cancellation cannot guarantee cancellation/refund of an accepted external inference. |
| `GET /metrics` | Prometheus text; **metrics token only**. |

Job states are `queued`, `running`, `done`, `error`, `cancelled`. The response
includes `id`, `status`, `progress` (0 or 1 only), `result`, `error`, `duration`,
`created_at`, `updated_at`, `result_expired`, `message`. Poll every 1.5–2 seconds
and stop on a terminal state. Error text is a bounded, controlled error code;
provider response bodies and exception text are never returned or logged.

Limits are 40 MiB per audio file and 20 minutes from the **parsed PCM frame
count**. Uploaded duration hints are not accepted. The total multipart body is
also bounded to 40 MiB + 64 KiB, including chunked requests. One inference runs
at a time and the waiting queue is bounded (default four). Full queue: 429.
Unsupported audio/fields or missing explicit consent: 422. Disabled provider:
503. This pilot is Korean-only; it does not silently translate or fall back to
mock data when a real provider fails.

Idempotency compares the audio bytes and normalized accepted fields, excluding
the multipart boundary/filename. Reuse the same key for an uncertain network
submission and polling. Different keys intentionally permit distinct jobs; the
shared pilot token is not a public, per-user quota system.

Successful `result` uses OnSori schema `1.0` accepted by
`extension/core.js:validateDocument`. Captions are speech-only, with every cue
`review_required=true`, `scale=1`, `dbfs=null`, `relative_db=null` and
`confidence=null`. No volume measurement, sound/music captioning, OCR correction
or accuracy certification is implied. Provider segments must contain finite,
ordered start times, positive intervals within the uploaded duration and bounded
text. A response with transcript text but no segment timestamps fails; the
gateway never divides text into fabricated time intervals. Mock data alone has
synthetic timing and is explicitly marked in warnings, source and metadata.

## Cost, cancellation and retention

Daily quota is `ONSORI_DAILY_AUDIO_MINUTES` (default 60 minutes), using UTC days.
Immediately before each possible external request, the full uploaded duration is
reserved in a durable SQLite transaction. Requests exceeding the quota fail with
`daily_audio_limit` **before** an external HTTP call. This is a conservative audio
budget, not an invoice estimate or account-wide provider spending cap.

Timeouts, provider errors, cancellations and uncertain billing do not refund the
reservation. There are no automatic paid retries, redirects or fallback
providers. HTTPX has environment proxies disabled and uses a fixed HTTPS endpoint
only. The worker timeout defaults to 180 seconds; raising it may be necessary
after real long-audio latency is measured. A cancelled remote job can continue
at the provider while the local queue proceeds, so single concurrency describes
gateway requests, not a guarantee about the provider's physical inference jobs.

On restart, all previously queued/running jobs become
`error: interrupted_no_automatic_retry`, their audio is deleted, and none is
resubmitted. Terminal jobs delete raw WAV files immediately; cancellation retries
deletion when the provider file handle closes. Orphan WAV files are also removed
on startup and sweep. Starlette multipart spool files are closed after parsing.

Results expire after `ONSORI_RESULT_TTL_SECONDS` (default 24 hours). The periodic
sweep removes result JSON, title and video ID; reads/submissions also enforce the
TTL. Reads and unchanged key replays then return 410. Opaque job/key/request
hashes, accounting durations and non-content counters remain as tombstones to
prevent accidental re-inference with expired keys. SQLite secure-delete and
checkpointing support logical deletion; forensic erasure, filesystem snapshots
and backups are not covered by this TTL. Persistent tombstones/usage consume
small but unbounded space over time and need an intentional archival policy for
a service that runs beyond a short pilot.

## Metrics

`onsori_jobs_total{status="done|error|cancelled"}` is a persistent terminal-job
counter. `onsori_jobs_active` counts queued/running jobs.
`onsori_job_duration_seconds` is a persistent histogram of elapsed processing
time (queue wait is excluded once execution starts; cancelled queued jobs include
their waiting time). `onsori_provider_audio_seconds_total` counts conservative
**reserved** external audio seconds, including uncertain failures/cancellations;
mock contributes zero. `onsori_storage_bytes` reports files in the configured data
directory, including SQLite WAL and raw queued WAV files. Metrics contain no job
ID, video ID, title, transcript or token labels.

## Offline verification

From `outputs/onsori`, the existing Python 3.10.20 virtual environment can run:

```powershell
.venv/Scripts/python.exe -m pytest tests/test_cloud_gateway.py -q --tb=short --basetemp=cloud_gateway/.test-tmp -o cache_dir=cloud_gateway/.pytest_cache
```

All provider calls in these tests use `httpx.MockTransport`. Cases cover separate
authentication, opt-in safety, consent, WAV/size/duration validation, idempotency,
bounded queue, cancellation, fixed endpoint, invalid timestamps, timeout/HTTP/
redirect/oversize failures, no retry, persistent daily quota, restart behavior,
TTL and process locking. No real cloud deployment, Rocky Linux execution or paid
provider call is established by this suite.

The DeepInfra multipart `audio` endpoint and output segment schema were checked
against its [official API documentation](https://deepinfra.com/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B/api)
on 2026-10-30. Real provider behavior remains to be tested after authorization.
