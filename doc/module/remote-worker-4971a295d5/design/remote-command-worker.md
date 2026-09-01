# Remote Command Worker Design

## Local State And Trust Boundary

`plugin/delivery-task-planner/delivery_bridge/remote_worker.py` persists a stable `workerId` and the local mapping `{programId, bizLine, workspace}` under the plugin runtime directory. Both files have mode `0600` on Unix-like platforms.

The mapping is written only after `http_bridge.py` has validated a local bridge request against the existing task-board API and read the project record. `workspace` never appears in a Worker registration, activity, completion result or error. Missing or deleted local mappings are removed before Worker registration, so another same-user Worker can win the server-side claim.

The Worker uses the current credential managed by `server.py`'s existing heartbeat storage. `DELIVERY_COMMAND_API_URL` is deployment configuration and is never accepted from a browser or a command input. A missing value disables remote polling without affecting any existing local bridge route.

## Protocol Lifecycle

1. Group local mappings by their authoritative business line, then register one Worker capability set and its mapped numeric `programIds` for each group.
2. Send a heartbeat per business line, then long-poll `POST /workers/commands/claim`.
3. The server atomically grants at most one lease. The Worker resolves the returned `programId` only from its local mapping.
4. Report a start event and periodic activity. Task commands relay the existing `ProgressStore` events. Activity renews the two-minute lease and detects `cancelRequested`.
5. Complete with `succeeded`, `failed` or `cancelled`. The server's authoritative lease expiry recovery handles a process restart; the Worker never guesses a prior process's incomplete local state.

Task cancellation invokes the existing `ExecutionBridge.stop_conversation` or `stop_all_executions` path where an active Codex turn exists. Git operations cannot be force-killed safely by the existing Git helpers, so cancellation remains best-effort and the final command status records that request after the helper returns.

## Supported Command Types

| Command type | Adapter |
| --- | --- |
| `task.execute` | Resolve `itemKey`, fetch the authoritative task detail, call `ExecutionBridge.execute`, wait for the local turn, then cloud-sync if enabled. |
| `task.execute-batch` / `task.execute-sequence` | Call the existing queue adapters and wait for their persisted local batch state. |
| `task.session` / `task.conversation` / `task.stop` / `task.stop-all` | Read or control the corresponding `ExecutionBridge` conversation session. |
| `documents.cloud-sync` | Call `ExecutionBridge.sync_cloud_workspace`. |
| `git.status`, `git.branches`, `git.changes`, `git.change`, `git.projects`, `git.merge-preview`, `git.workspace-check` | Call the existing read-only `git_ops.py` helpers on the mapped workspace. |
| `git.init`, `git.submodules`, `git.branch`, `git.prepare`, `git.push`, `git.merge` | Call the existing validated Git helpers or `GitMixin` methods on the mapped workspace. |

There is deliberately no generic route forwarding, arbitrary Python dispatch, environment setup, plugin update or shell command type. Every output is recursively path-sanitized and bounded before completion is sent to app-api.
