// Failures captured verbatim from Kata v0.23.0 (`kata ... --json`): the JSON
// error envelope goes to stderr, and the exit code is the documented one.
export const daemonUnavailable = () => ({ code: 7, stdout: "", stderr: '{"error":{"kind":"daemon_unavailable","code":"daemon_unavailable","message":"selected daemon is unavailable while connecting","exit_code":7}}\n' });
// `kata list` in a git workspace whose alias is not registered: the alias is in error.data.
export const notInitialized = () => ({ code: 4, stdout: "", stderr: '{"error":{"kind":"not_found","code":"project_not_initialized","hint":"run \\"kata init\\" in this workspace","message":"alias github.com/acme/inferred-widgets is not registered","exit_code":4,"data":{"alias":"github.com/acme/inferred-widgets"}}}\n' });
// `kata list --project nope`: the project is in error.data.
export const notInitializedProject = () => ({ code: 4, stdout: "", stderr: '{"error":{"kind":"not_found","code":"project_not_initialized","hint":"run \\"kata init\\" in this workspace","message":"project nope is not registered","exit_code":4,"data":{"project":"nope"}}}\n' });
// `kata list` in a workspace whose .kata.toml names a project the daemon does not know.
export const notInitializedBound = () => ({ code: 4, stdout: "", stderr: '{"error":{"kind":"not_found","code":"project_not_initialized","hint":"run \\"kata init\\" in this workspace","message":"project bound-proj is not registered","exit_code":4,"data":{"project":"bound-proj"}}}\n' });
// `kata list` outside any .kata.toml and git repository: no error.data.
export const notInitializedNoData = () => ({ code: 4, stdout: "", stderr: '{"error":{"kind":"not_found","code":"project_not_initialized","hint":"run \\"kata init --project <name>\\" in the workspace root, or pass --project <name>","message":"no .kata.toml ancestor and no git ancestor","exit_code":4}}\n' });
// `kata close` with [close.throttle] enabled after three sibling closes.
export const siblingThrottle = () => ({ code: 1, stdout: "", stderr: '{"error":{"kind":"internal","code":"sibling_throttle","message":"sibling-close throttle: you closed 3 children of k56s in the last 60 sec:\\n  91ny closed 0 sec ago\\n  8p1c closed 0 sec ago\\n  qzfr closed 2 sec ago\\nSlow down and review the scope of each remaining child before closing. Wait for the throttle window to clear, or ask a human reviewer to inspect and close","exit_code":1}}\n' });
// A host that cannot spawn the executable: Bun's own error, as omp's exec throws it.
export const missingExecutable = () => Object.assign(new Error('Executable not found in $PATH: "kata"'), { code: "ENOENT", path: "kata", errno: -2 });
