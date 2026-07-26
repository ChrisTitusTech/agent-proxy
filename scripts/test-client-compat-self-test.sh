#!/usr/bin/env bash
# Exercise compatibility harness redaction, isolation, cleanup, and skip policy.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
SERVER_PID=
cd "$PROJECT_DIR"

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill -TERM "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf -- "$TEST_DIR"
}

trap cleanup EXIT

FAKE_BIN_DIR="$TEST_DIR/bin"
RUNNER_DIR="$TEST_DIR/runners"
mkdir -p "$FAKE_BIN_DIR" "$RUNNER_DIR"

for client in codex grok; do
	{
		printf '#!/usr/bin/env bash\n'
		printf 'set -eu\n'
		# shellcheck disable=SC2016 # The fake script must receive this expansion literally.
		printf '%s\n' '[[ ${1:-} == --version ]]'
		printf 'printf "%s-test 1.2.3\\\\n"\n' "$client"
	} >"$FAKE_BIN_DIR/$client"
	chmod 0700 "$FAKE_BIN_DIR/$client"
done

cat >"$RUNNER_DIR/codex.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$COMPAT_FIXTURE_DIR"
printf '%s\n' "$HOME" >"$COMPAT_FIXTURE_DIR/state-path.txt"
printf 'Authorization: Bearer %s\n' "$PROXY_API_KEY" \
	>"$COMPAT_FIXTURE_DIR/request.txt"
printf '{"api_key":"%s","access_token":"unstructured-test-token"}\n' \
	"$PROXY_API_KEY" >>"$COMPAT_FIXTURE_DIR/request.txt"
printf 'x-admin-token: admin-test-secret\n' >>"$COMPAT_FIXTURE_DIR/request.txt"
printf 'event: response.completed\ndata: {"token":"response-token"}\n' \
	>"$COMPAT_FIXTURE_DIR/response.sse"
printf 'unstructured secret value: %s\n' "$PROXY_API_KEY"
EOF
chmod 0700 "$RUNNER_DIR/codex.sh"

cat >"$RUNNER_DIR/grok.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$COMPAT_FIXTURE_DIR"
printf '%s\n' "$HOME" >"$COMPAT_FIXTURE_DIR/state-path.txt"
printf 'intentional runner failure\n'
exit 42
EOF
chmod 0700 "$RUNNER_DIR/grok.sh"

PORT_FILE="$TEST_DIR/health-port"
node -e '
const { writeFileSync } = require("node:fs");
const http = require("node:http");
const server = http.createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    status: "ok",
    version: "test-server-4.5.6",
    providers: ["codex"],
  }));
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(process.argv[1], String(server.address().port), { mode: 0o600 });
});
' "$PORT_FILE" &
SERVER_PID=$!

for _ in {1..50}; do
	[[ -s "$PORT_FILE" ]] && break
	kill -0 "$SERVER_PID" 2>/dev/null || {
		printf 'Health fixture exited before publishing its port.\n' >&2
		exit 1
	}
	sleep 0.1
done
[[ -s "$PORT_FILE" ]] || {
	printf 'Health fixture did not publish its port.\n' >&2
	exit 1
}
PORT=$(<"$PORT_FILE")
for _ in {1..50}; do
	if curl --silent --fail "http://127.0.0.1:$PORT/health" >/dev/null; then
		break
	fi
	sleep 0.1
done
curl --silent --fail "http://127.0.0.1:$PORT/health" >/dev/null

export AGENT_PROXY_BASE_URL="http://127.0.0.1:$PORT"
export PROXY_API_KEY=sk-proxy-self-test-secret
export PATH="$FAKE_BIN_DIR:$PATH"
export AGENT_PROXY_COMPAT_RUNNER_DIR="$RUNNER_DIR"

PASS_ARTIFACTS="$TEST_DIR/pass-artifacts"
PASS_OUTPUT="$TEST_DIR/pass-output"
scripts/test-client-compat.sh \
	--client codex \
	--require-live \
	--artifacts-dir "$PASS_ARTIFACTS" >"$PASS_OUTPUT"

grep -q 'PASS \[codex\]' "$PASS_OUTPUT"
node -e '
const { readFileSync } = require("node:fs");
const metadata = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (
  metadata.client !== "codex"
  || metadata.client_version !== "codex-test 1.2.3"
  || metadata.server_version !== "test-server-4.5.6"
  || metadata.result !== "passed"
) {
  throw new Error("Unexpected compatibility metadata");
}
' "$PASS_ARTIFACTS/codex/metadata.json"

if grep -R -n -E \
	'sk-proxy-self-test-secret|unstructured-test-token|admin-test-secret|response-token' \
	-- "$PASS_ARTIFACTS"; then
	printf 'Sanitized artifacts retained a test credential.\n' >&2
	exit 1
fi
grep -R -q '\[REDACTED\]' "$PASS_ARTIFACTS/codex/fixtures"

PASS_STATE_PATH=$(<"$PASS_ARTIFACTS/codex/fixtures/protocol/state-path.txt")
[[ "$PASS_STATE_PATH" != "$HOME" ]]
[[ ! -e "$PASS_STATE_PATH" ]]

EMPTY_RUNNER_DIR="$TEST_DIR/empty-runners"
mkdir -p "$EMPTY_RUNNER_DIR"
export AGENT_PROXY_COMPAT_RUNNER_DIR="$EMPTY_RUNNER_DIR"

SKIP_OUTPUT="$TEST_DIR/skip-output"
scripts/test-client-compat.sh \
	--client claude \
	--artifacts-dir "$TEST_DIR/skip-artifacts" >"$SKIP_OUTPUT"
grep -q 'SKIP \[claude\]' "$SKIP_OUTPUT"

if scripts/test-client-compat.sh \
	--client claude \
	--require-live \
	--artifacts-dir "$TEST_DIR/required-artifacts" \
	>"$TEST_DIR/required-output" 2>&1; then
	printf 'Required-live mode accepted an unavailable client runner.\n' >&2
	exit 1
fi
grep -q 'FAIL \[claude\]' "$TEST_DIR/required-output"

export AGENT_PROXY_COMPAT_RUNNER_DIR="$RUNNER_DIR"
FAIL_ARTIFACTS="$TEST_DIR/fail-artifacts"
if scripts/test-client-compat.sh \
	--client grok \
	--require-live \
	--artifacts-dir "$FAIL_ARTIFACTS" \
	>"$TEST_DIR/fail-output" 2>&1; then
	printf 'Harness accepted a failing client runner.\n' >&2
	exit 1
fi
grep -q 'runner exited with 42' "$TEST_DIR/fail-output"
FAIL_STATE_PATH=$(<"$FAIL_ARTIFACTS/grok/fixtures/protocol/state-path.txt")
[[ ! -e "$FAIL_STATE_PATH" ]]

if AGENT_PROXY_COMPAT_TURN_TIMEOUT=invalid scripts/test-client-compat.sh \
	--client codex \
	--artifacts-dir "$TEST_DIR/invalid-timeout-artifacts" \
	>"$TEST_DIR/invalid-timeout-output" 2>&1; then
	printf 'Harness accepted an invalid live-turn timeout.\n' >&2
	exit 1
fi
grep -q 'must be a positive integer' "$TEST_DIR/invalid-timeout-output"

printf 'Client compatibility harness self-tests passed.\n'
