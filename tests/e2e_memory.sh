#!/usr/bin/env bash
# E2E check for the memory core: chat persistence + learnings loop + approval.
# Requires the API on :3000 and the warehouse Postgres on :5437 (docker compose).
# Runs against a local mock Anthropic-protocol provider — no real key needed.
set -uo pipefail

API=http://localhost:3000
PSQL="docker exec -i $(docker ps -qf publish=5437) psql -U insightful -d warehouse -tAc"
FAIL=0
ok() { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; FAIL=1; }

curl -sf $API/api/status >/dev/null || { echo "API not on :3000"; exit 1; }

# never clobber a real provider config: save + restore around the mock
$PSQL "create table if not exists settings_e2e_backup as select * from settings where key='ai_provider' and false" >/dev/null
$PSQL "delete from settings_e2e_backup" >/dev/null
$PSQL "insert into settings_e2e_backup select * from settings where key='ai_provider'" >/dev/null

export E2E_RUN_ID="$$-$(date +%s)" # run-unique learning texts (see mock_provider.py)
python3 "$(dirname "$0")/mock_provider.py" & MOCK=$!
trap 'kill $MOCK 2>/dev/null; $PSQL "delete from settings where key='"'"'ai_provider'"'"'" >/dev/null; $PSQL "insert into settings select * from settings_e2e_backup" >/dev/null; $PSQL "drop table settings_e2e_backup" >/dev/null' EXIT
sleep 1

echo "1. configure mock provider + chat turn"
curl -sf -X POST $API/api/chat/config -H 'content-type: application/json' \
  -d '{"provider":"custom","base_url":"http://127.0.0.1:9099/api/anthropic","model":"mock-1","api_key":"e2e"}' >/dev/null \
  && ok "provider configured" || bad "provider config"

STREAM=$(curl -sf -N -X POST $API/api/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Why did checkout latency spike last week?"}]}')
echo "$STREAM" | grep -q '"type":"session"' && ok "session event emitted" || bad "session event"
SID=$(echo "$STREAM" | python3 -c "import json,sys; print([json.loads(l[5:])['id'] for l in sys.stdin if l.startswith('data:') and 'session' in l][0])")

echo "2. session persisted"
sleep 1
N=$($PSQL "select count(*) from chat_messages where session_id='$SID'")
[ "$N" -ge 1 ] && ok "chat_messages rows: $N" || bad "no messages persisted"

echo "3. learnings extracted (pending, with provenance)"
sleep 2
M=$($PSQL "select count(*) from memories where status='pending' and provenance->>'session_id'='$SID'")
[ "$M" -ge 1 ] && ok "pending memories: $M" || bad "no memories extracted"
MID=$($PSQL "select id from memories where status='pending' and provenance->>'session_id'='$SID' limit 1")
MID=${MID:-0}

echo "4. approve → surfaces in search + MCP"
curl -sf -X PATCH $API/api/context/memories/$MID -H 'content-type: application/json' -d '{"status":"approved"}' >/dev/null
curl -sf "$API/api/context/search?q=checkout" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert isinstance(d['memories'], list), 'memories should be a flat list'
assert any(m['id'] == $MID and m['status'] == 'approved' for m in d['memories']), 'approved memory missing from search'
" && ok "search returns approved memory" || bad "search grounding"
curl -sf -X POST $API/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"context_search","arguments":{"query":"checkout"}}}' \
  | grep -q "approved" && ok "MCP context_search returns it" || bad "MCP grounding"

echo "5. dedupe on re-learn"
BEFORE=$($PSQL "select count(*) from memories")
curl -sf -N -X POST $API/api/chat -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"Why did checkout latency spike last week?\"}]}" >/dev/null
sleep 2
AFTER=$($PSQL "select count(*) from memories")
[ "$BEFORE" = "$AFTER" ] && ok "no duplicates ($AFTER rows)" || bad "duplicates: $BEFORE → $AFTER"

if [ "$FAIL" = "0" ]; then echo "PASS"; else echo "FAIL"; fi
exit $FAIL
