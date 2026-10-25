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
