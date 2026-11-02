// Failures captured verbatim from Kata v0.20.0 (`kata ... --json`): the JSON
// error envelope goes to stderr, and the exit code is the documented one.
export const daemonUnavailable = () => ({ code: 7, stdout: "", stderr: '{"error":{"kind":"daemon_unavailable","code":"daemon_unavailable","message":"selected daemon is unavailable while connecting","exit_code":7}}\n' });
// `kata list` in a workspace whose git alias is not registered.
export const notInitialized = (alias = "local:///tmp/tmp.ZOhRsgV0uZ/ws") => ({ code: 4, stdout: "", stderr: `{"error":{"kind":"not_found","code":"project_not_initialized","hint":"run \\"kata init\\" in this workspace","message":"alias ${alias} is not registered","exit_code":4}}\n` });
// `kata close` with [close.throttle] enabled after three sibling closes.
export const siblingThrottle = () => ({ code: 1, stdout: "", stderr: '{"error":{"kind":"internal","code":"sibling_throttle","message":"sibling-close throttle: you closed 3 children of g940 in the last 60 sec:\\n  t1gr closed 0 sec ago\\n  kz2s closed 0 sec ago\\n  fkv4 closed 0 sec ago\\nSlow down and review the scope of each remaining child before closing. Wait for the throttle window to clear, or ask a human reviewer to inspect and close","exit_code":1}}\n' });
// A host that cannot spawn the executable: Bun's own error, as omp's exec throws it.
export const missingExecutable = () => Object.assign(new Error('Executable not found in $PATH: "kata"'), { code: "ENOENT", path: "kata", errno: -2 });
