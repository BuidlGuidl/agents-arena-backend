#!/usr/bin/env bash

set -Eeuo pipefail

# The arena repo pins packageManager=pnpm, which makes strict corepack refuse
# to run the yarn shim from this cwd. The chain repo genuinely uses yarn.
export COREPACK_ENABLE_STRICT=0

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly DEMO_DIR="$ROOT_DIR/.demo"
# Not `:?` — that would fire at load time and break `token`, `status`, and `down`
# in a terminal that has no reason to know where the chain repo lives.
readonly CHAIN_DIR="${AI_CTF_REPO:-}"
readonly NODE_VERSION="22.20.0"
readonly BACKEND_PORT="4177"
readonly FRONTEND_PORT="5173"
readonly CHAIN_PORT="8545"

readonly CHAIN_PID="$DEMO_DIR/chain.pid"
readonly BACKEND_PID="$DEMO_DIR/backend.pid"
readonly FRONTEND_PID="$DEMO_DIR/frontend.pid"
readonly CHAIN_LOG="$DEMO_DIR/chain.log"
readonly BACKEND_LOG="$DEMO_DIR/backend.log"
readonly FRONTEND_LOG="$DEMO_DIR/frontend.log"
readonly TOKEN_FILE="$DEMO_DIR/operator-token"

mkdir -p "$DEMO_DIR"

usage() {
  cat <<'EOF'
Usage: scripts/demo.sh <up|status|fake|real|smoke|token|down>
EOF
}

# The backend refuses to start without an operator token. Reuse the caller's, or
# keep one per demo directory so a later `fake`/`real` still authenticates.
operator_token() {
  if [[ -n "${ARENA_OPERATOR_TOKEN:-}" ]]; then
    printf '%s' "$ARENA_OPERATOR_TOKEN"
    return
  fi
  if [[ ! -s "$TOKEN_FILE" ]]; then
    ( umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE" )
  fi
  tr -d '\n' < "$TOKEN_FILE"
}

fail_with_fix() {
  local message="$1"
  local fix="$2"

  printf 'Error: %s\n' "$message" >&2
  printf 'Fix: %s\n' "$fix" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  local fix="$2"

  command -v "$command_name" >/dev/null 2>&1 || \
    fail_with_fix "The '$command_name' command is missing." "$fix"
}

require_chain_dir() {
  [[ -n "$CHAIN_DIR" ]] || \
    fail_with_fix 'AI_CTF_REPO is unset.' \
      'export AI_CTF_REPO=/path/to/ai.ctf.buidlguidl.com (see DEMO.md)'
}

preflight() {
  local node_version

  require_chain_dir
  require_command curl 'brew install curl'
  require_command docker 'brew install --cask docker && open -a Docker'
  docker info >/dev/null 2>&1 || \
    fail_with_fix 'The Docker daemon is not ready.' 'open -a Docker'
  docker image inspect arena-entrant:dev >/dev/null 2>&1 || \
    fail_with_fix 'The arena-entrant:dev image is missing.' "cd \"$ROOT_DIR\" && ./docker/build.sh"

  require_command fnm 'brew install fnm'
  node_version="$(fnm exec --using="$NODE_VERSION" node --version 2>/dev/null || true)"
  [[ "$node_version" == "v$NODE_VERSION" ]] || \
    fail_with_fix "Node $NODE_VERSION is not installed in fnm." "fnm install $NODE_VERSION"

  fnm exec --using="$NODE_VERSION" pnpm --version >/dev/null 2>&1 || \
    fail_with_fix 'pnpm is unavailable under Node 22.' \
      "fnm exec --using=$NODE_VERSION corepack enable && fnm exec --using=$NODE_VERSION corepack prepare pnpm@9.14.2 --activate"
  [[ -f "$CHAIN_DIR/package.json" ]] || \
    fail_with_fix "The chain repo is missing at $CHAIN_DIR." \
      "git clone https://github.com/BuidlGuidl/ai.ctf.buidlguidl.com.git \"$CHAIN_DIR\""
}

pidfile_running() {
  local pidfile="$1"
  local pid

  [[ -s "$pidfile" ]] || return 1
  read -r pid < "$pidfile" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

clear_stale_pidfile() {
  local pidfile="$1"

  if [[ -e "$pidfile" ]] && ! pidfile_running "$pidfile"; then
    rm -f "$pidfile"
  fi
}

http_responds() {
  local port="$1"

  curl --silent --show-error --output /dev/null --max-time 2 \
    "http://127.0.0.1:$port/" 2>/dev/null
}

port_has_listener() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    [[ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]]
    return
  fi
  http_responds "$port"
}

rpc_ready() {
  local response
  local chain_id

  response="$(curl --silent --show-error --max-time 2 \
    --header 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    "http://127.0.0.1:$CHAIN_PORT" 2>/dev/null || true)"
  chain_id="$(printf '%s' "$response" | sed -nE \
    's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p')"
  [[ -n "$chain_id" ]]
}

wait_for_rpc() {
  local pidfile="$1"
  local attempt

  for attempt in {1..60}; do
    rpc_ready && return 0
    pidfile_running "$pidfile" || return 1
    sleep 1
  done
  return 1
}

wait_for_http() {
  local port="$1"
  local pidfile="$2"
  local attempt

  for attempt in {1..60}; do
    http_responds "$port" && return 0
    pidfile_running "$pidfile" || return 1
    sleep 1
  done
  return 1
}

start_background() {
  local name="$1"
  local workdir="$2"
  local logfile="$3"
  local pidfile="$4"
  shift 4

  : > "$logfile"
  (
    cd "$workdir"
    exec "$@"
  ) >> "$logfile" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$pidfile"
  printf 'Started %s with pid %s.\n' "$name" "$pid"
}

deployment_present() {
  local deployments_dir="$CHAIN_DIR/packages/hardhat/deployments"
  local artifact
  local address
  local response
  local code

  [[ -d "$deployments_dir" ]] || return 1
  while IFS= read -r artifact; do
    address="$(sed -nE \
      's/.*"address"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]{40})".*/\1/p' \
      "$artifact" | head -n 1)"
    [[ -n "$address" ]] || continue
    response="$(curl --silent --show-error --max-time 2 \
      --header 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$address\",\"latest\"],\"id\":1}" \
      "http://127.0.0.1:$CHAIN_PORT" 2>/dev/null || true)"
    code="$(printf '%s' "$response" | sed -nE \
      's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p')"
    if [[ -n "$code" && "$code" != '0x' && "$code" != '0x0' ]]; then
      return 0
    fi
  done < <(find "$deployments_dir" -type f -name '*.json' 2>/dev/null)
  return 1
}

require_yarn() {
  fnm exec --using="$NODE_VERSION" yarn --version >/dev/null 2>&1 || \
    fail_with_fix 'yarn is unavailable under Node 22 (needed to start or deploy the chain).' \
      "fnm exec --using=$NODE_VERSION corepack enable && fnm exec --using=$NODE_VERSION corepack prepare yarn@3.2.3 --activate"
}

deploy_chain() {
  require_yarn
  printf 'Deploying local chain contracts.\n'
  if ! (
    cd "$CHAIN_DIR"
    fnm exec --using="$NODE_VERSION" yarn deploy
  ) >> "$CHAIN_LOG" 2>&1; then
    fail_with_fix 'The chain deployment failed. Read .demo/chain.log.' \
      "cd \"$CHAIN_DIR\" && fnm exec --using=$NODE_VERSION yarn deploy"
  fi
}

ensure_chain() {
  clear_stale_pidfile "$CHAIN_PID"

  if rpc_ready; then
    if pidfile_running "$CHAIN_PID"; then
      printf 'Reusing the chain started by this launcher.\n'
    else
      printf 'Reused the existing JSON-RPC chain on port %s.\n' "$CHAIN_PORT" > "$CHAIN_LOG"
      printf 'Reusing the existing JSON-RPC chain on port %s.\n' "$CHAIN_PORT"
    fi
    if deployment_present; then
      printf 'Chain contracts are already deployed.\n'
    else
      deploy_chain
    fi
    return
  fi

  if pidfile_running "$CHAIN_PID"; then
    wait_for_rpc "$CHAIN_PID" || \
      fail_with_fix 'The chain process did not answer eth_chainId. Read .demo/chain.log.' \
        "cd \"$ROOT_DIR\" && ./scripts/demo.sh down && ./scripts/demo.sh up"
  elif port_has_listener "$CHAIN_PORT"; then
    fail_with_fix "Port $CHAIN_PORT is occupied but does not answer eth_chainId." \
      "lsof -nP -iTCP:$CHAIN_PORT -sTCP:LISTEN"
  else
    require_yarn
    start_background chain "$CHAIN_DIR" "$CHAIN_LOG" "$CHAIN_PID" \
      fnm exec --using="$NODE_VERSION" yarn chain
    wait_for_rpc "$CHAIN_PID" || \
      fail_with_fix 'The chain did not become ready. Read .demo/chain.log.' \
        "tail -n 80 \"$CHAIN_LOG\""
  fi

  deploy_chain
}

ensure_backend() {
  clear_stale_pidfile "$BACKEND_PID"
  if pidfile_running "$BACKEND_PID"; then
    wait_for_http "$BACKEND_PORT" "$BACKEND_PID" || \
      fail_with_fix 'The backend process is not serving HTTP. Read .demo/backend.log.' \
        "tail -n 80 \"$BACKEND_LOG\""
    printf 'Reusing the backend started by this launcher.\n'
    return
  fi

  if port_has_listener "$BACKEND_PORT"; then
    fail_with_fix "Port $BACKEND_PORT is already in use by another process." \
      "lsof -nP -iTCP:$BACKEND_PORT -sTCP:LISTEN"
  fi

  # The mock frontend has no funding controls, so the demo funds entrants itself.
  start_background backend "$ROOT_DIR" "$BACKEND_LOG" "$BACKEND_PID" \
    env ARENA_DB=:memory: PORT="$BACKEND_PORT" ARENA_OPERATOR_TOKEN="$(operator_token)" \
    ARENA_LOCAL_FAUCET=true \
    fnm exec --using="$NODE_VERSION" pnpm --filter backend start
  wait_for_http "$BACKEND_PORT" "$BACKEND_PID" || \
    fail_with_fix 'The backend did not become ready. Read .demo/backend.log.' \
      "tail -n 80 \"$BACKEND_LOG\""
}

ensure_frontend() {
  clear_stale_pidfile "$FRONTEND_PID"
  if pidfile_running "$FRONTEND_PID"; then
    wait_for_http "$FRONTEND_PORT" "$FRONTEND_PID" || \
      fail_with_fix 'The frontend process is not serving HTTP. Read .demo/frontend.log.' \
        "tail -n 80 \"$FRONTEND_LOG\""
    printf 'Reusing the frontend started by this launcher.\n'
    return
  fi

  if port_has_listener "$FRONTEND_PORT"; then
    fail_with_fix "Port $FRONTEND_PORT is already in use by another process." \
      "lsof -nP -iTCP:$FRONTEND_PORT -sTCP:LISTEN"
  fi

  # The vite dev proxy adds the operator header, so the token stays out of the browser.
  start_background frontend "$ROOT_DIR" "$FRONTEND_LOG" "$FRONTEND_PID" \
    env ARENA_OPERATOR_TOKEN="$(operator_token)" \
    fnm exec --using="$NODE_VERSION" pnpm --filter mock-frontend dev \
      --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort
  wait_for_http "$FRONTEND_PORT" "$FRONTEND_PID" || \
    fail_with_fix 'The frontend did not become ready. Read .demo/frontend.log.' \
      "tail -n 80 \"$FRONTEND_LOG\""
}

up() {
  preflight
  ensure_chain
  ensure_backend
  ensure_frontend
  printf 'Demo services are ready. Frontend: http://127.0.0.1:%s\n' "$FRONTEND_PORT"
  # The token is not printed here: `up` runs on the streamed terminal. Read it
  # with `demo.sh token` when a curl needs it.
  printf 'Operator token: scripts/demo.sh token\n'
}

print_service_status() {
  local name="$1"
  local port="$2"
  local logfile="$3"
  local health="$4"
  local state='down'

  if "$health" "$port"; then
    state='up'
  fi
  printf '%-8s %s port=%s log=%s\n' "$name" "$state" "$port" "$logfile"
}

status() {
  print_service_status chain "$CHAIN_PORT" "$CHAIN_LOG" rpc_ready
  print_service_status backend "$BACKEND_PORT" "$BACKEND_LOG" http_responds
  print_service_status frontend "$FRONTEND_PORT" "$FRONTEND_LOG" http_responds
}

extract_run_id() {
  fnm exec --using="$NODE_VERSION" node -e '
    let json = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { json += chunk; });
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(json);
        const id = body.run && body.run.id;
        if (typeof id !== "string" || id.length === 0) process.exit(1);
        process.stdout.write(id);
      } catch {
        process.exit(1);
      }
    });
  '
}

create_run() {
  local preset="$1"
  local response
  local run_id
  local token

  require_command curl 'brew install curl'
  http_responds "$BACKEND_PORT" || \
    fail_with_fix 'The backend is down.' "cd \"$ROOT_DIR\" && ./scripts/demo.sh up"
  token="$(operator_token)"
  response="$(curl --fail --silent --show-error \
    --request POST "http://127.0.0.1:$BACKEND_PORT/runs" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $token" \
    --data "{\"preset\":\"$preset\",\"autoStart\":true}")" || \
    fail_with_fix "The backend rejected the $preset run (a 401 means it holds a different operator token)." \
      "tail -n 80 \"$BACKEND_LOG\"; cd \"$ROOT_DIR\" && ./scripts/demo.sh down && ./scripts/demo.sh up"
  run_id="$(printf '%s' "$response" | extract_run_id)" || \
    fail_with_fix 'The create-run response did not contain an id.' \
      "curl -sS http://127.0.0.1:$BACKEND_PORT/runs"

  printf 'Run ID: %s\n' "$run_id"
  printf 'SSE: curl -N http://127.0.0.1:%s/runs/%s/events\n' "$BACKEND_PORT" "$run_id"
  # An absolute path to this script, so the line pastes into any cwd. The command
  # substitution is printed literally — the token itself never reaches the screen.
  printf 'Steer: curl -fsS -X POST -H "content-type: application/json" -H "authorization: Bearer $(%s/demo.sh token)" "http://127.0.0.1:%s/runs/%s/entrants/codex-1/steer" -d '"'"'{"text":"..."}'"'"'\n' \
    "$SCRIPT_DIR" "$BACKEND_PORT" "$run_id"
  printf 'Frontend: http://127.0.0.1:%s\n' "$FRONTEND_PORT"
}

smoke() {
  local harness
  local failed=0
  local logfile

  preflight
  rpc_ready || \
    fail_with_fix 'The local chain is down.' "cd \"$ROOT_DIR\" && ./scripts/demo.sh up"

  for harness in codex opencode claude; do
    logfile="$DEMO_DIR/smoke-$harness.log"
    if (
      cd "$ROOT_DIR"
      fnm exec --using="$NODE_VERSION" pnpm --filter backend exec \
        tsx scripts/demo-entrant.ts "$harness"
    ) 2>&1 | tee "$logfile"; then
      printf '%s: PASS\n' "$harness"
    else
      printf '%s: FAIL (log: %s)\n' "$harness" "$logfile" >&2
      failed=1
    fi
  done
  return "$failed"
}

collect_descendants() {
  local parent="$1"
  local child

  command -v pgrep >/dev/null 2>&1 || return 0
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    collect_descendants "$child"
    printf '%s\n' "$child"
  done
}

stop_owned() {
  local name="$1"
  local pidfile="$2"
  local pid
  local child
  local descendants
  local attempt

  if ! pidfile_running "$pidfile"; then
    rm -f "$pidfile"
    printf '%s: no owned process\n' "$name"
    return
  fi

  read -r pid < "$pidfile"
  descendants="$(collect_descendants "$pid")"
  for child in $descendants; do
    kill -TERM "$child" 2>/dev/null || true
  done
  kill -TERM "$pid" 2>/dev/null || true

  for attempt in {1..40}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    for child in $descendants; do
      kill -KILL "$child" 2>/dev/null || true
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  printf '%s: stopped pid %s\n' "$name" "$pid"
}

down() {
  stop_owned frontend "$FRONTEND_PID"
  stop_owned backend "$BACKEND_PID"
  stop_owned chain "$CHAIN_PID"
  sweep_arena_containers
}

# Killing the backend mid-race orphans that run's containers: teardown lives in
# the backend process, so the agents inside keep working and hitting the chain.
sweep_arena_containers() {
  local containers networks
  containers="$(docker ps -aq --filter 'label=arena.runId' 2>/dev/null || true)"
  if [ -n "$containers" ]; then
    printf 'entrants: removing %s orphaned arena container(s)\n' "$(printf '%s\n' "$containers" | wc -l | tr -d ' ')"
    printf '%s\n' "$containers" | xargs docker rm -f >/dev/null 2>&1 || true
  fi
  networks="$(docker network ls -q --filter 'label=arena.runId' 2>/dev/null || true)"
  if [ -n "$networks" ]; then
    printf '%s\n' "$networks" | xargs -n1 docker network rm >/dev/null 2>&1 || true
  fi
}

case "${1:-}" in
  up)
    up
    ;;
  status)
    status
    ;;
  fake)
    create_run fake-duel
    ;;
  real)
    create_run docker-duel
    ;;
  smoke)
    smoke
    ;;
  token)
    operator_token
    printf '\n'
    ;;
  down)
    down
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
