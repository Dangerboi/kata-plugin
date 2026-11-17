// Every variable Kata routes by or the plugins read. The test runner, each test fixture and the smoke runners drop them
// from what they inherit: a developer's own settings, or the ones a plugin exports into the session running the smoke,
// must not change what a run sees. The module imports nothing so that any of them can load it. The transcript names
// repeat TRANSCRIPT_ENV in core/kata-cli.ts; tests/isolation.test.ts fails when one of those is missing here.
export const SCRUBBED_ENV = ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID", "KATA_DEFAULT_PROJECT",
	"KATA_AUTHOR", "KATA_PI_PARENT", "KATA_OMP_LIVE_INBOX", "KATA_CLAUDE_LIVE_INBOX", "KATA_ATTENTION_HOST", "KATA_OMP_EXECUTABLE", "KATA_PI_EXECUTABLE", "KATA_OPENCODE_EXECUTABLE", "KATA_CLAUDE_EXECUTABLE", "KATA_CLAUDE_DEBUG", "KATA_OMP_DEBUG",
	"KATA_PI_DEBUG", "KATA_OPENCODE_DEBUG", "KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"];
