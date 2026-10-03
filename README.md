# Pi response visibility

Passive response-wait diagnostics for Pi (proven on **0.99.2**; any version whose patch anchors match), Node **>=22.19**, macOS and Linux desktops. This is a Git-distributed package, not a published npm artifact. It does not change model selection, requests, retries, fallback, timeouts or abort behavior. Silence is not evidence of a server hang or internal reasoning.

## Install without chezmoi

Review the source first. With Pi installed:

```sh
pi install https://github.com/cartwmic/pi-response-visibility
pi list
```

For a maintained local checkout, use `pi install "$PWD"` instead; Pi records that path (possibly relative to its settings file), so keep the directory available. Restart Pi to load it. There are no installation or startup patch scripts. For a one-session trial: `pi -e "$PWD/index.ts"`.

To transfer a snapshot without publishing:

```sh
npm pack --dry-run
npm pack --pack-destination /absolute/archive-directory
mkdir -p /absolute/install-directory
tar -xzf /absolute/archive-directory/pi-response-visibility-0.1.0.tgz -C /absolute/install-directory
pi install /absolute/install-directory/package
```

The archive must be extracted first: a `.tgz` is not a Pi local package directory. `pi remove /absolute/install-directory/package` removes the declaration, not your extracted source or diagnostic state. Pi supplies the extension's Pi API/TUI imports; no separate npm runtime dependencies or chezmoi are required. See [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## Operate

The persistent widget uses at most two lines while a request is active and collapses to one idle line after completion, regardless of preset. Compact shows phase/time and an optional quiet warning; expanded adds a short section-filtered summary; timeline shows the latest transition. Full fields and the bounded timeline stay in the on-demand inspector, not the conversation area. `/latency` or Ctrl+Shift+L opens an opaque, full-width panel capped at 60% of terminal height (24 rows maximum); Escape closes it. Scroll details with `j`/`k`, PageUp/PageDown, or Home/End. `p` cycles presets; `t`/`r`/`v`/`h` toggle timing/transport/provider/health. Arrows select history requests; `l` returns to the live request. Detail wraps to the panel width and remains scrollable after resize. Panel colors use Pi's active `text`/`userMessageBg` theme tokens, including terminal-default colors and live theme changes; no guessed RGB palette is imposed.

| Command | Effect |
| --- | --- |
| `/latency off\|compact\|expanded\|timeline` | Live display preset; off does **not** stop recording |
| `/latency inspect` / `/latency history` | Current request details / bounded session history |
| `/latency sections timing\|transport\|provider\|health on\|off` | Toggle an information family |
| `/latency capture off\|metadata\|events\|bodies` | Independent recording mode; rich modes require the supported helper and show a sensitive-content warning |
| `/latency settings` | Show current configuration |
| `/latency settings quietMs 30000` | Passive no-progress warning interval |
| `/latency settings slowMs 30000` | Slow-success summary threshold |
| `/latency settings historyLimit 50` | In-memory recent-request limit |
| `/latency settings traceBytes 104857600` | Aggregate trace byte limit |
| `/latency settings save` | Save current defaults for future sessions |

Live changes do not persist until saved. History is session-local, not reloaded from traces. Failed/aborted requests and slow successes get brief summaries; fast successes do not. Quiet warnings name the observed phase without intervention. Preparation uses activity age; waiting/streaming uses content age. Lifecycle activity does not impersonate reasoning/text/tool progress.

## Observations and gaps

Stock hooks measure local turn/preparation boundaries, parsed provider activity and content deltas. Activity and content ages are distinct. These are client observations, not original wire bytes or server inference measurements. Final numeric token usage and reported cost are retained when Pi supplies them; missing usage stays unavailable, never estimated. Stock `after_provider_response` supplies numeric HTTP response status, retained in the inspector, history and default metadata trace without the helper. This is a response-hook observation, not wire telemetry; stock headers and response/error containers are not copied. Transport dispatch/bytes, provider request identifiers, retries and server queue/concurrency are unavailable when not exposed; the UI says so rather than estimating them. The four section families remain selectable even when detail is unavailable.

The optional helper correlates foreground SDK calls by options/callback identity, not timing. Associated prepare/auth and SDK callback durations reach the observer; cache warming, hooks and unassociated calls remain separate or unknown-origin. Virtual routing that replaces options loses association. Callback durations are not transport durations.

On supported built-in `openai-completions` requests, it observes actual fetch dispatch, request-body bytes, response status/header arrival, allowlisted request/rate metadata and native attempts. Response wire bytes and socket details remain unavailable. On `openai-codex-responses`, it observes WebSocket acquisition/reuse, send/received payload bytes, parser registration/close, SSE dispatch/header/read bytes, native fallback and requested backoff. Acquisition is not a measured TCP/TLS handshake. Counts exclude headers, framing, TLS and network overhead; parsed events are never labeled wire bytes. Server queue depth, account concurrency and internal inference remain unavailable. See the [exact core coverage](CORE-HANDOFF.md).

## Recording, privacy and bounds

Defaults: metadata capture, 50 history entries, 100 MiB total traces, 30-second quiet/slow thresholds. Settings and rotated JSONL traces live under `~/.local/state/pi-response-visibility/`, in `settings.json` and `traces/`. Files are private (0600), directories created private (0700). Keep this state out of Git and shared archives. Metadata is allowlisted: no prompts, output bodies, tool/source text, resolved API/OAuth credentials or credential headers. Provider event payloads and error snapshots are not persisted.

Stock Pi refuses `/latency capture events|bodies`. With the supported helper, explicit opt-in warns that prompts/output/source can be sensitive: `events` records sanitized parsed provider events; `bodies` additionally records the dispatched JSON request. These are not wire captures. Only proven built-in HTTP explicit resolved-auth/default-fetch paths can emit rich snapshots. The request-lifetime core sanitizer excludes resolved API/OAuth secret values and all credential header containers before publication and queueing; payloads never enter observer history or UI. Unknown/custom/ambient auth, custom fetch and Codex rich capture fail closed, even when the mode is selected. No `raw` alias exists. Do not enable rich capture unless you accept retaining sensitive non-credential content. Oversized/unsanitizable snapshots are dropped with a capacity warning; saved modes persist across restart but in-memory history does not. See [writer limits](src/trace.mjs) and [observer limits](src/observer.mjs): bounded queues/timelines, asynchronous recording, dropped/failing diagnostics reported without blocking a model request. Trace failures can leave incomplete evidence. Total trace storage is bounded, not a guarantee of complete history.

## Optional explicit core helper v1

Any `@earendil-works/pi-coding-agent` version is accepted when every patch anchor matches exactly once; a changed or missing anchor fails closed before any write. Full proof below was retained on 0.99.2. Use an absolute package root containing its `package.json` and `dist/`, not the executable path. Test on a private copy before choosing any live installation change:

```sh
node /absolute/package/bin/core.mjs check --pi-root /absolute/private-pi
node /absolute/package/bin/core.mjs apply --pi-root /absolute/private-pi
node /absolute/package/bin/core.mjs check --pi-root /absolute/private-pi
node /absolute/package/bin/core.mjs rollback --pi-root /absolute/private-pi
```

Without `--pi-root`, Node package resolution must find the supported Pi package. Prefer an explicit root. Check validates package name, unique anchors and bridge state; incompatible/partial/modified targets fail closed. Apply/check are idempotent. Rollback reverses only exact owned substitutions and preserves sibling modifications. Writes are not an atomic multi-file transaction; interruption can require manual source restoration, not blind reapplication. See [helper contract and remaining gaps](CORE-HANDOFF.md), [canonical patch](src/core-patch.mjs), and [bridge](src/core-bridge.mjs).

Owner integration prerequisites are a maintained package source/extracted snapshot, the matching Pi installation root, and the owner's separate chezmoi source checkout and wrapper. That wrapper must delegate to this same `bin/core.mjs`, not maintain a second patch payload. Follow that checkout's `AGENTS.md`, review its source diff and explicitly authorize deployment separately. Direct users need none of the owner's dotfiles. No live deployment, commit, push or publication is claimed here.

## Verification and current proof boundary

```sh
npm pack --dry-run
ARTIFACT_ROOT=/absolute/evidence PI_PROOF_ROOT=/absolute/pi-0.99.2 \
  PROOF_OWNER_WRAPPER=/absolute/owner-source/response-visibility/patch.mjs npm run verify
```

Verify runs syntax/unit checks, documentation-link existence checks, archive inspection and actual isolated Pi PTY journeys on macOS and Docker Linux (`node:24-bookworm`, Python 3, npm/network access required). It integrates baseline, providers, clocks, storage, controls, owner-wrapper and source/archive installation cases. Its AC-1–AC-8 gate requires successful executions, concrete retained case assertions and unchanged source hashes throughout; it does not waive missing or failed evidence. A nonzero result must be retained, not presented as full acceptance. Final stable-tree matrix reconciliation is separate. The full repository gate requires the owner's actual source wrapper via `PROOF_OWNER_WRAPPER`; Docker mounts it read-only and supplies a private target. Without it the owner cases fail, not skip. This is a development-proof prerequisite, not a package installation dependency: direct users can run the named package suites without any owner checkout.

Retained actual Pi 0.99.2 proof (scripted backends, not live-provider dogfood):

| Named runner | Completed scope |
| --- | --- |
| [Baseline](tests/tui.py) | macOS/Linux regular/fullscreen stock/patched, paired enabled/disabled requests, abort/follow-up positive and negative coherence, metadata/privacy/bounds and saved-default restart |
| [Providers](tests/providers.py) | macOS built-in HTTP completion/retry and Codex WS completion/native SSE fallback, paired captures and owner source-wrapper apply → completed Pi response → rollback; custom-provider gaps |
| [Clocks](tests/clocks.py) | macOS/Linux regular/fullscreen preparation/registration/lifecycle-only versus reasoning/text/tool progress, passive warnings and section/preset controls |
| [Storage](tests/storage.py) | macOS busy streams, small queue/timeline/history/trace limits, real write failure with completed responses, private files and UI-off metadata recording |
| [Controls](tests/controls.py) | macOS/Linux regular/fullscreen controls/shortcut/history/theme/resize, selective fast/slow/error/abort summaries, saved defaults after restart, reload/session replacement/shutdown cleanup |

Run focused slices with `python3 tests/<runner>.py --artifact-root /absolute/fresh-evidence --pi-root /absolute/pi-0.99.2` (providers also accepts `--case all`). Keep evidence outside the checkout. Proof uses small test-only bounds and accelerated thresholds; product defaults remain unchanged.

Supported HTTP rich capture is proved through real private Pi: [privacy modes](tests/safe-capture-tui.py) compare metadata/events/bodies requests and positive content markers while excluding dummy resolved credentials/header containers; [oversize/restart](tests/storage-raw.py) proves safe drops, completed responses, private bounds and persisted recording policy. The refreshed integrated verifier completed the named storage suites on both macOS and Linux, including safe rich-capture drops and restart. These are scripted private-instance results, not live-provider dogfood. Final stable-tree integrated macOS/Linux acceptance remains driver-owned. No arbitrary-provider raw coverage, live owner deployment or complete AC-1–AC-8 acceptance is claimed. See [Linux runner](tests/linux.sh) and [verification gate](scripts/verify.mjs). Source/archive installation is independent of full product acceptance. After extracting an archive, run the same named real-Pi cases from that snapshot:

```sh
python3 /absolute/checkout/tests/install.py --package-root /absolute/install-directory/package \
  --pi-root /absolute/pi-0.99.2 --artifact-root /absolute/fresh-install-evidence
```

This runner installs through Pi's package settings into fresh isolated homes (no explicit extension-loading flag for the installed package), completes regular/fullscreen stock/helper requests, tests abort/follow-up coherence and restart, and rolls back the private helper. Its scripted provider comes from the snapshot. It requires Python 3 and a matching Pi tree with dependencies; it does not install or modify the owner's runtime.
