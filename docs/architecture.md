# RoamDeck architecture and contracts

## 1. Scope

RoamDeck is a single-owner remote workspace. It joins server-resident agents, project sessions, files, PTY and background commands behind one authenticated gateway. An authenticated owner can execute server commands; this is not a multi-tenant isolation boundary.

## 2. Interfaces

```text
Android bundled React UI / browser
  → HTTPS reverse proxy
    → Express gateway :3080 (loopback)
      → CloudCLI :3001 (loopback)
      → Codex App Server local stdio
      → optional FileBrowser Quantum :3081 (loopback)
      → file roots / persistent job queue / tmux
```

| Interface | Contract |
| --- | --- |
| `POST /api/login` | Owner credentials → independent gateway token and secure cookie |
| `POST /api/conversations` | `{provider,projectName,title?,cwd,createDirectory?}` → stable conversation ID and absolute project path |
| `DELETE /api/conversations/:id` | Explicitly confirmed deletion, rejects running sessions; retains project files |
| `/api/files*` | Root + relative path for listing, optimistic text save, upload, move and download |
| `/api/jobs*` | Persistent command queue, status, log and cancellation |
| `/api/socket-ticket` | One-use channel ticket, 30-second lifetime |
| `/ws/chat`, `/ws/terminal` | Real-time agent events and PTY using ticket authentication |
| `/preview/:capability/*` | Scoped signed resource, 15-minute lifetime and byte ranges |

## 3. Data and runtime contracts

- `shared/protocol.ts` owns locations, events, decoders and replay reducer. Do not duplicate event parsing in UI components.
- `STUDIO_BASE` supplies `project`, `inputs`, `outputs`, `logs`. Gateway session state defaults to `.state`, configurable by `STUDIO_STATE`. `COMPILEVERSE_ROOT` remains a legacy alias.
- CloudCLI persists projects and stable app session IDs. Project display name is bound to a full directory path. A custom session title is retained across messages.
- Claude uses the upstream normalized protocol. Owned Codex sessions use `codex app-server --listen stdio://`, with `initialize`, `initialized`, `thread/start` or `thread/resume`, then `turn/start`.
- Codex request sandbox is `workspace-write`; response type is `workspaceWrite`. Use `approvalPolicy: on-request` and explicit accept/decline. Unsupported interaction forms surface an error and terminal fallback.
- Delete checks running state. Owned Codex threads are archived before gateway history is removed; project source directories are retained.
- WebSocket reconnect uses replay cursors and pending approvals. Codex cursors persist across turns; upstream Claude cursors have their own reset behavior.
- The queue reserves one worker before asynchronous lookup, persists state/logs, signals process groups on cancel, and marks old running jobs interrupted after restart.

## 4. Validation and errors

| Condition | Result |
| --- | --- |
| Missing/expired/revoked login | 401; logout closes owned sockets |
| Foreign origin / private upstream admin endpoint | 403 / 404 |
| Reused or wrong-channel socket ticket | Handshake 401 |
| Absolute path / escaped symlink or traversal | 400 / 403 |
| Existing upload destination / stale text version | 409, original retained |
| Oversized file/editor / binary edit | 413 / 415 |
| Invalid/expired preview capability | 403 / 410 |
| Unsatisfiable Range | 416 with `Content-Range` |
| Running session deletion | 409, stop first |

Resolve both lexical and real paths under the chosen root. Text writes compare mtime and replace atomically. HTML is sandboxed without same-origin access; relative resources share its scoped capability. Do not put long-lived tokens in URLs or disable TLS verification.

Android stores the gateway token using AES-GCM and Android Keystore; web uses sessionStorage. Upstream credentials remain on the server. Native downloads use the system document picker. Android trusts system CAs; deployment certificates/private keys stay outside Git.

## 5. Good / base / bad cases

- Good: select an existing repository or create a named project folder; send a task to an agent; review tool approval; leave a background command and inspect its output later.
- Base: empty directories and unauthorized agent accounts show useful state. Native restart restores the encrypted workbench session.
- Bad: traversal, forged preview, stale edit, reused ticket or active-session deletion must fail explicitly without overwriting project files.

## 6. Verification

`npm run typecheck`, `npm test`, `npm run build` form the basic gate. UI changes additionally run `npm run test:ui`; its upstream is a fixture, not model inference. Native changes require APK signing verification and Android checks; actual device results are labeled separately.

Terminal layout changes must assert the rightmost cell is visible in fit mode and reachable in 80/120-column mode. Verify real server pane dimensions, touch scrolling, rotation and a single PTY connection across display changes. FitAddon measures its direct parent, so keep the measurement surface zero-padding and put horizontal scrolling outside it.

## 7. Wrong versus correct

- Wrong: store project names only in React; crop a padded terminal measure surface; reconnect the shell when changing font; automatically accept unknown tool requests.
- Correct: persist names through CloudCLI; use a zero-padding measurement surface and reachable scroll viewport; resize the existing PTY; show explicit approvals and errors.

Dependency versions are pinned in the app and upstream lock files. Native package identity and existing service paths remain stable during the product rename to preserve upgrades.

## 8. Workspace 0.2 contracts

- Each normalized HTTPS origin owns an independent token slot. Android encrypts each slot using AES-GCM and Android Keystore; web uses origin-keyed sessionStorage. The legacy single-token slot migrates once. Switching remounts the workspace and closes old sockets. Login completion writes to its captured origin, even if selection changed while the request was pending.
- `GET /api/file-modules` returns `FileModule[] {id,name,folders:[{id,name,path}]}`; `PUT /api/file-modules/:id` validates/persists a module; `DELETE` removes only its mapping. `GET /api/roots` flattens folders into stable root IDs with module metadata. Old project/inputs/outputs/logs IDs survive migration.
- `GET /api/directories?path` browses allowed real directories (home/base by default, override with STUDIO_BROWSE_ROOTS). `POST /api/files/resolve {root,path}` supplies actual path and terminal rc; never reconstruct custom paths by replacing `/project`.
- Preview capabilities carry a hash of the canonical bound directory. Relabeling preserves them; rebinding invalidates them with 410. Active job references block remapping/removal, with active state checked after asynchronous directory validation.
- `POST /api/chat/attachments` accepts one multipart file up to 512MB and returns a `ChatAttachment` containing an opaque uploadId. Files live in state/attachments/UUID with private metadata. Client messages send at most ten checked `{uploadId}` or `{root,path}` references, never arbitrary local paths.
- For Claude native image input, verified images are copied into the upstream `~/.cloudcli/assets` direct-child store because CloudCLI rejects image descriptors elsewhere. General files use checked absolute paths. Codex uses `localImage` items. SVG and other unsupported native image types remain file references.
- `GET /api/agents/:provider/models` returns normalized `AgentModel[] {id,name,efforts,defaultEffort,isDefault,images}`. CloudCLI 1.37.5 returns `data.models.OPTIONS`, not an array. Codex model/list uses `supportedReasoningEfforts`; turn/start uses `effort`. Validate against the current catalog before sending. No hard-coded model or effort catalog in the UI.
- Pending Codex approvals use unique client request IDs separate from RPC IDs. `chat.permission-response` carries allow plus optional answers keyed by question ID (`{answers:string[]}`). Claude AskUserQuestion instead carries updatedInput with answers keyed by question text (multi-selection joined with comma + space). Unknown question shapes cannot be approved through a generic card.
- `STUDIO_CLIENT_ORIGINS` explicitly extends REST/WebSocket CORS for browser clients hosted elsewhere. Do not allow arbitrary origins or move tokens into URLs to make multi-server work.

Evidence: pinned CloudCLI 1.37.5 runtime/types and installed Codex 0.164.0 generated schema; official [Codex App Server](https://developers.openai.com/codex/app-server). Tests in workspace.test.ts and check-ui.mjs cover real data flow with protocol fixtures; check-workspace-remote.mjs and check-native.mjs cover Oracle/Android without claiming model inference.


## 9. Usage and notifications (0.3)

`shared/usage.ts` normalizes actual reported values; unknown is undefined, never a manufactured zero. `state/token-usage.json` retains up to 1000 session snapshots. Codex thread totals include cached input/reasoning subsets; Claude token_budget is a context snapshot. GET `/api/usage/accounts` aggregates server-local Codex RPC account/rateLimits/read + account/usage/read (60-second cache) and Claude OAuth usage when available. GET `/api/usage/sessions/:id` verifies session identity and returns `{snapshot:null,reason}` until reported. Claude OAuth uses a fixed HTTPS endpoint with redirects refused; credentials and raw error bodies never leave the server. Its endpoint is version dependent, so unavailable is expected with unsupported login modes.

`state/notifications.json` atomically persists 500 notices, 3000 dedup keys and active Claude run IDs. GET `/api/notifications[?after=seq]` returns `{items,cursor,unread,hasMore,gap}`; ascending catch-up pages are at most 100. Without after it returns the latest 100 in reverse order. GET `/api/notifications/:id` and POST `/:id/read` / `/read-all` are authenticated. Reading does not resolve or approve. Completed/failed Codex turns and terminal queue states emit through callbacks. Claude per-run seq is not an event identity; gateway generated run keys and request IDs deduplicate multiple subscriptions. CloudObserver polls running state and subscribes independently of browser sockets; it never executes model requests. Missed completed replay produces an honest ended notice after grace and repeated confirmed absence. Provider outages do not imply completion.

Android `StudioNotifications` validates HTTPS origins and exposes configure/status/syncServers/openSettings plus notification-open events. `StudioNotificationService` is a user-enabled specialUse foreground service with an ongoing low-priority status notification and pause action; Android 13+ POST_NOTIFICATIONS is requested from the visible App. Every 15 seconds it sequentially polls selected origins with the matching Keystore token, normal TLS and no redirects. Config/cursors contain no credentials. Cold/warm notification intents carry only origin + opaque event ID; React matches a known server, restores its login and fetches the authenticated notice before routing. Intent consumption occurs after the live React effect accepts it, preserving cold launch under StrictMode. Notification actions never approve. OS force-stop and battery limits are documented, not bypassed.

`tests/usage-notifications.test.ts` covers quota normalization, fixed endpoint/caching/redaction, persistence/replay, exact read semantics, jobs, and server observation after client closure across seq resets. Fixtures explicitly inject fake Codex/Claude quota sources so tests cannot consume desktop accounts. `check-notifications-native.mjs` uses the isolated emulator and a named real HTTPS task, permission dialog, background delivery, exact log navigation and pause/resume dedup. `check-usage-remote.mjs` validates the installed ARM account APIs and failure notice; none of these checks claim authenticated model inference.

## 0.3.1 interaction refinements

- Model settings use app-owned selectable cards rather than native `<select>` menus; supported models/efforts and processing lock remain unchanged.
- Folder creation belongs to the selected physical directory. The action is hidden when choosing a module folder, disabled during loading/error, and the sheet shows the parent location.
- Terminal viewport provides 14px padding; xterm's measurement surface remains zero-padding. Fit width explicitly subtracts both insets; fixed columns and pan remain on the same PTY. Copy snapshots the current xterm selection or retained active buffer into a native-selectable readonly textarea. Copy uses the system clipboard, with manual selection fallback. It does not issue shell commands or enter terminal copy mode.
- `PUT /api/jobs/:id {title,command?}` edits names; changed commands require `queued`. `DELETE /api/jobs/:id` removes records/logs and rejects running/cancelling jobs (409). Output files remain. Completed/running commands remain immutable; copying creates an editable new task. “已完成” includes all terminal states.
- `GET /api/agents/:provider/config` returns `{provider,path,content,revision,exists}`; `PUT` accepts `{content,revision}`. Only `codex/config.toml` and `claude/settings.json` under the CLI configuration homes are addressable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, otherwise service-user home). Auth files and arbitrary paths are excluded. New files are allowed; JSON must be an object, TOML uses pinned smol-toml. Syntax validation does not validate provider-specific option semantics. Responses are `no-store`, edits use content/existence hashes, conflict 409, a per-provider save lock, atomic mode-600 replacement, final-file symlink rejection and a 512KB limit. Drafts are not persisted to browser storage. Existing agent processes may need restarting to apply configuration; the editor does not restart running work.
- Native builds may supply `VITE_STUDIO_ORIGIN=https://your-domain:port` to customize the initial server without committing instance configuration. Saved server profiles and credential scope still take priority.

## 0.4 user-level extension management and compact controls

Each provider card has an independent settings button opening Configuration / Skills / MCP / Plugins. File upload/create/view use one compact icon toolbar with accessible labels. Terminal copy/fullscreen/tools remain visible; width/font/reconnect/login commands are in a tools sheet, and extended control/arrow/Enter keys expand only when requested. Presentation changes retain the same PTY.

Quota reset comes from Codex `account/rateLimits/read` → Unix seconds → ISO instant. The client formats that instant using its device IANA timezone, labels GMT offset and relative duration, and updates the countdown every30s. Changing the server timezone does not change the reset instant. Pacific DST is handled by Intl, not a fixed UTC-8 subtraction.

Authenticated `/api/agents/:provider/skills` GET/POST, PUT/DELETE `/:id`, POST `/import` manage standalone user Skills. The editable roots are ~/.agents/skills and legacy CODEX_HOME/skills for Codex, CLAUDE_CONFIG_DIR/skills for Claude. Hidden/system and plugin-package folders are excluded. Opaque IDs resolve only to listed roots. Valid YAML name/description, 256KB SKILL.md limit, stale revision rejection, exclusive names, and constrained server-directory copies (20MB/2000 entries, no symlinks/special files) protect existing files. Client can import a phone SKILL.md as text or select an allowed server skill folder with supporting files. Removal explicitly deletes the selected standalone skill directory, not its original import source.

GET `/mcp` lists name/enabled/transport and a URL without query/credentials; GET `/mcp/:name` returns the authenticated editable JSON plus revision. PUT `/mcp {name,config,enabled,create?,revision}`, DELETE `/mcp/:name {revision}` mutate only user-level entries. Native Codex `mcp_servers` tables preserve unrelated typed config values and use `enabled`. Claude entries use the user `mcpServers` in ~/.claude.json (or CLAUDE_CONFIG_DIR/.claude.json). Its project-only native disable lists are not repurposed: a global disable privately archives that entry in state/claude-mcp-disabled.json before removing it from active user config; re-enable restores it and clears the archive. Active config wins if a crash leaves both copies. Hash revisions cover active and archived states. Claude account/project metadata is preserved and never included in MCP responses. JSON/TOML serialization may normalize formatting/comments while retaining unrelated values. Saving does not connect or perform OAuth.

GET `/plugins` projects installed CLI JSON into metadata; POST `/plugins {id,action:'install'|'enable'|'disable'|'remove'}` uses explicit `name@marketplace` selectors. Commands use execFile arrays, fixed provider executables, user scope, a neutral user-home cwd,120s timeout and bounded output; no shell interpolation or automatic command-install confirmation. Claude uses official list/install/enable/disable/uninstall; Codex uses list/add/remove and native plugins.<id>.enabled configuration. Directory-owned Claude plugins remain managed through their source; installation policy is left to actual CLI enforcement, not inferred from default-install labels. First-party App Server plugin RPC is under development and is not used. Interactive OAuth, marketplace catalog management and project scope remain outside this revision. CLI errors are generic to avoid leaking raw configuration or command secrets.

`Extensions.exclusive` serializes extension and raw-config writes per provider. Private document read/write is shared with the raw editor: regular files only, revisions, atomic mode600 replacements, no-store responses. Tests inject temporary homes and fake CLIs; actual ARM script `check-extension-cli.mjs` additionally validates native MCP config reads and a harmless Claude local-marketplace plugin lifecycle inside disposable config homes. No model inference is needed.

## 0.4.1 terminal lifecycle and copy

Workspace mounts Terminal lazily and hides it across tab changes. Hidden terminal overlays/fullscreen/armed Ctrl close; connection, buffer and command draft remain. Server/profile change, logout or cwd change still tears down the corresponding client. Display changes only resize.

CloudCLI 1.37.5 retains and replays raw PTY output on reuse, including secondary DA queries. xterm6 responds with `ESC[>0;276;0c`; replaying an expired query can send that response into shell input. Terminal init therefore sets `forceRestart:true` to replace only the upstream tmux attachment PTY and reattach the persistent tmux session. It must never kill the tmux shell. Do not filter literal output strings or suppress live capability negotiation. Independent regression verifies same pane PID and shell variable, legacy garbage reproduction, and three clean new attachments.

`terminalText(buffer,cols)` joins `isWrapped` continuations, preserves explicit breaks and actual spaces at wrap boundaries, omits unused null padding before wide glyphs, and excludes empty trailing screen rows. A selected xterm range takes precedence. `studio.shortcuts:<origin>` stores up to50 `{id,name,command}` entries on-device, name≤60 and command≤16000 characters; `[]` remains empty, absent/corrupt storage recovers defaults. UI actions fill the editor and never execute immediately. `studio.commands:<origin>` retains existing recent-command history separately.
