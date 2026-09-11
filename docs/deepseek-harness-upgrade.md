# DeepSeek Harness 0.1.5-rc.1

Aegis pins its SDK client and bundled runtime to `0.1.5-rc.1` (upstream prerelease, released September 10, 2026):
https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1

The SDK now launches with `dshBin`, `profile`, `patches` and `processCwd`.
Aegis supplies its own runtime entry and complete Cordis composition. Temporary
MCP configs resolve plugin packages from the bundled runtime via app-boot's
`bareModuleBaseUrl`; they do not load the user's global CLI profile.
The removed `agent-spine-demo` bundle is replaced by explicit plugin entries.
Standard, PTC, Minimal and Creator retain their existing tool surfaces. The
stored Aegis `code` preset maps to the upstream tool presentation value `ptc`.
`deepseek-flash` (DeepSeek-V41-Flash) is the default for new sessions. The picker
hides the duplicate `deepseek-v4-flash` alias when the current Flash id is configured;
saved selections retain the alias and its runtime capabilities. Its new price schedule is not inferred
from the older V4 pricing table. Goal UI capabilities remain controlled by
Aegis's provider adapter, independently of the SDK version.

Image understanding is enabled for `deepseek-flash` and `deepseek-v4-flash`.
The official API now serves the legacy Flash id using V4.1 Flash; both declare
`inputModalities: [text, image]`. Pro retains its text-only runtime declaration. Both composers
show a model-switch hint and retain the draft/attachments when the selected
model cannot accept images. Aegis never changes the selected model silently.

PNG, JPEG, WebP and GIF can be picked, dropped or pasted. The SDK receives encoded
image blocks, and `dsh-attachment-local` validates, normalizes and stores them
before admitting the prompt. Aegis limits uploads to 10 MB per image and 20 images
per message; native pixel/dimension limits also apply. The upstream image pipeline
handles raster normalization and Files API/inline serialization. Animated GIFs
are interpreted through that native image pipeline, not as video input.

Native image objects and Aegis preview copies live in `~/.aegis/deepseek` (or the
explicit `AEGIS_DSH_ATTACHMENT_HOME`). This does not change the user's CLI config
or DSH_HOME. Tool results keep image metadata and durable preview paths in chat
history, rather than base64. `read_image` works in Standard and Creator; PTC/Code
nested image results also reach the workstream preview. Minimal accepts uploaded
images but keeps its original two-tool surface. Native session recovery retains
uploaded image references after the original attachment file is removed.

The upstream JSON-RPC server still creates a new agent for an unknown process-local
session ID. Aegis checks `sessionPersistence.stat(id).header` and resumes an existing
same-directory session through `agents.resume()`. Missing logs or a different
directory fail explicitly instead of silently starting an empty conversation.
Native persistence owns migration and write locks. Existing logs remain immutable;
continuation writes a V3 successor. An old Harness cannot resume the newer successor.
The upgrade does not bulk-migrate or modify user sessions during installation.

The SDK now depends on the CLI's larger package graph. Electron packaging checks
both peer-only dependencies and nested package versions at their actual paths,
and excludes optional native binaries for other target platforms.

Verification:

```sh
npm run prepare:deepseek-runtime
npm run verify:deepseek-sdk-adapter
npm run verify:deepseek-packaging
npm run verify:deepseek-runtime-upgrade
npm run verify:deepseek-images
npm run verify:deepseek-images-ui
npm run probe:deepseek-presets
npm run probe:deepseek-mcp
node scripts/tests/browser-use-deepseek-electron.test.mjs
```

The upgrade test uses `scripts/fixtures/deepseek-session-rc8.jsonl`, captured from
the actual 0.1.0-rc.8 runtime against a local mock API. Workspace paths and the
developer's skill catalog are redacted; turn, tool-call and tool-result identities
are retained. It verifies migration, two process lifetimes, historical tool results,
reasoning effort, write-lock exclusion/release and unsafe-resume guards. Other
probes exercise real Harness/MCP/Electron code against local mock model responses;
they do not require credentials or verify live model quality.

Image regression tests run the actual Aegis adapter and bundled Harness against a
local HTTP server implementing chat completions and the Files API. They verify
all four formats, image-only turns, text-only-model rejection, native and PTC
`read_image`, malformed data and native image history after a process restart.
The isolated Electron test exercises picker/drop/paste, preserved drafts, model
selection, image results, the lightbox and renderer history reload. These tests
verify integration and byte delivery, not the live model's recognition accuracy.


## Model capabilities and cost estimates

Model names, descriptions, input modalities, context limits and effective output
caps come from the runtime profile. The picker exposes these without evaluating
`!!js`. Custom per-model limits override plugin defaults; disabled thinking offers
only `off` and the adapter passes `off` to the runtime. Bundled models use a 1M
context and 256K request output cap (the Harness default), even though the API
supports a maximum of 384K. Saved ids and the configured default are retained.

The context ring's hover/focus panel shows `Cost`, the cumulative USD cost of
completed turns in the current conversation, without an explanatory subtitle;
Usage shows estimated, unavailable or partial costs. The Usage page's cost cell tooltip
explains the source and exclusions. Positive tiny amounts are never rounded down
to free. Unknown/custom model names do not inherit a price through prefix matching.

Prices verified September 10, 2026:
https://api-docs.deepseek.com/quick_start/pricing
https://api-docs.deepseek.com/updates

Per million tokens (cache hit / uncached input / output):
- V4.1 Flash, including the legacy Flash aliases: $0.003 / $0.15 / $0.60 off-peak;
  $0.006 / $0.30 / $1.20 peak.
- V4 Pro: $0.022 / $0.66 / $1.98 off-peak; $0.044 / $1.32 / $3.96 peak.
- From September 14, 2026 at 04:00 UTC, Pro billing uses Flash prices, matching
  the announced server reroute. This does not broaden Pro's local image policy.
- Peak hours are Monday-Friday 01:00-04:00 and 06:00-10:00 UTC, end-exclusive.
  Weekends are off-peak. Earlier V4 pricing schedules remain available for history.
- The V4.1 release gives a date, not an exact activation time. Historical estimates
  use September 10 at 00:00 UTC as a date-level boundary; it is not an official
  minute-level billing cutoff. Unverified pre-release Flash prices stay unknown.

Usage chunks and committed messages are deduplicated per request. Each request
retains its first observed usage timestamp for pricing, so a multi-step turn can
cross a price boundary. Estimates cover reported main-agent usage; unreported
background/title/compaction requests and child-agent usage are excluded. Native
image tokens are already part of input; reasoning tokens are already part of
output. Neither is billed twice. Interrupted request usage absent from the SDK
cannot be reconstructed; completed request samples survive subsequent failures.

New estimates persist with an accounting version. Reports preserve those values,
repair legacy doubled usage and previously unpriced Flash rows, include cache reads
in total tokens, and identify results with no verified price. Context occupancy
uses the latest request rather than the cumulative turn's billable tokens.

Adapter verification covers catalog overrides, disabled thinking, schedule edges,
weekends, aliases, unknown models, usage deduplication, multiple requests and error
retention. Image Electron QA also checks the real model picker, live cost tooltip,
SQLite history/reload and Usage's unavailable/partial states with a local mock API.


The adapter seeds context limits from the selected model's effective profile on
startup, then accepts any runtime `request/context` override. Native resumed
sessions only re-emit this event when context changes; waiting for it on every
restart would leave the ring stuck on an older turn. Electron QA exercises a
warm follow-up, a process restart with the same native session id, and history
reload, verifying both context occupancy and the latest turn's cost.


The ring reads its cumulative cost from all persisted result rows for that
conversation, independently of the renderer's history page. It refreshes after
each turn result, retains the completed total during the next turn, and survives
session switching, process restarts and loading only the latest page. Per-turn
result accounting is unchanged; live usage chunks are never added a second time.
