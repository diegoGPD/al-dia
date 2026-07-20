#!/usr/bin/env bash
# End-to-end smoke test against a scratch database.
# Usage: DATA_DIR=/tmp/aldia-smoke bash scripts/smoke-test.sh
# Starts its own server on port 3999 and verifies every module's math.
set -e
PORT=${PORT:-3999}
export DATA_DIR=${DATA_DIR:-/tmp/aldia-smoke}
rm -rf "$DATA_DIR"
B="http://localhost:$PORT/api"
J="-H Content-Type:application/json"
FAIL=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" == "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 (expected $2, got $3)"; FAIL=1; fi
}

PORT=$PORT node server.js & SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
sleep 1.5

echo "== auth =="
chk "status needs setup" '{"needsSetup":true,"setupCodeRequired":false}' "$(curl -s $B/status)"
curl -s -c /tmp/sm.cj -X POST $B/setup $J -d '{"email":"o@t.mx","name":"O","password":"password123","locationName":"L1"}' >/dev/null
C="-b /tmp/sm.cj -H Content-Type:application/json"
chk "wrong pw" 401 "$(curl -s -X POST $B/login $J -d '{"email":"o@t.mx","password":"nope"}' -o /dev/null -w '%{http_code}')"
chk "unauthed" 401 "$(curl -s $B/dashboard?location=1 -o /dev/null -w '%{http_code}')"

echo "== categories =="
CATS=$(curl -s $C "$B/categories?location=1")
chk "10 channels seeded" 10 "$(echo "$CATS" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["revenue"]))')"
chk "4 accounts seeded" 4 "$(echo "$CATS" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["accounts"]))')"
UBER=$(echo "$CATS" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([c["id"] for c in d["revenue"] if "Uber Eats" in c["name"]][0])')
EFEC=$(echo "$CATS" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([c["id"] for c in d["revenue"] if c["name"]=="Efectivo en tienda"][0])')
FOOD=$(echo "$CATS" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([c["id"] for c in d["variable"] if "ingredients" in c["name"]][0])')
RENT=$(echo "$CATS" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([c["id"] for c in d["recurring"] if c["name"]=="Rent"][0])')

echo "== logging & math =="
# revenue: uber 10000 (30% comm), cash 5000; accounts: 5000 cash, 10000 delivery apps
R=$(curl -s $C -X PUT $B/revenue -d "{\"location_id\":1,\"date\":\"2026-01-05\",\"items\":[{\"category_id\":$UBER,\"amount\":10000},{\"category_id\":$EFEC,\"amount\":5000}],\"accounts\":[{\"account_id\":1,\"amount\":5000},{\"account_id\":4,\"amount\":10000}]}")
chk "commission computed" 3000 "$(echo "$R" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["commissions"]))')"
curl -s $C -X PUT $B/costs/day -d "{\"location_id\":1,\"date\":\"2026-01-05\",\"rows\":[{\"category_id\":$FOOD,\"amount\":4500,\"invoiced\":true,\"account_id\":2}]}" >/dev/null
curl -s $C -X POST $B/recurring -d "{\"location_id\":1,\"category_id\":$RENT,\"description\":\"Rent\",\"amount\":3650,\"frequency\":\"monthly\",\"invoiced\":true,\"start_date\":\"2026-01-01\",\"account_id\":2}" >/dev/null
curl -s $C -X POST $B/oneoff -d '{"location_id":1,"date":"2026-01-05","description":"Repair","amount":500,"invoiced":false,"account_id":1}' >/dev/null
D=$(curl -s $C "$B/dashboard?location=1&granularity=day&date=2026-01-05")
# profit = 15000 - 4500 - 3000 - 120(rent daily) - 500 = 6880
chk "day profit" 6880 "$(echo "$D" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["current"]["profit"]))')"
chk "BE includes commissions" 0.5 "$(echo "$D" | python3 -c 'import json,sys;b=json.load(sys.stdin)["breakEven"];print(round(b["varRatio"]+b["commRatio"],1))')"
chk "invoiced split" 7620 "$(echo "$D" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["current"]["invoiced"]["total"]))')"

echo "== accounts =="
A=$(curl -s $C "$B/accounts-view?location=1&granularity=day&date=2026-01-05")
chk "cash net (5000-500)" 4500 "$(echo "$A" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(round([a for a in d["accounts"] if a["name"]=="Cash"][0]["net"]))')"
chk "unassigned zero" 0 "$(echo "$A" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["unassigned"]["moneyIn"]))')"
curl -s $C -X POST $B/transfers -d '{"location_id":1,"date":"2026-01-05","from_account_id":1,"to_account_id":2,"amount":1000}' >/dev/null
chk "adjust wrong PIN" 403 "$(curl -s $C -X POST $B/accounts/adjust -d '{"location_id":1,"account_id":1,"new_balance":99,"pin":"0000"}' -o /dev/null -w '%{http_code}')"

echo "== team (turn-based) =="
E=$(curl -s $C -X POST "$B/employees?location=1" -d '{"location_id":1,"name":"Ana","pay_type":"hourly","rate":65}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
TURN=$(curl -s $C -X POST "$B/schedule/turns?location=1" -d '{"location_id":1,"date":"2026-01-05","label":"Mañana","start_min":540,"end_min":1020}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s $C -X POST "$B/schedule/turns/$TURN/assign?location=1" -d "{\"location_id\":1,\"employee_id\":$E}" >/dev/null
S=$(curl -s $C "$B/schedule?location=1&week=2026-01-05")
chk "8h turn cost" 520 "$(echo "$S" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["totals"]["cost"]))')"
D2=$(curl -s $C "$B/dashboard?location=1&granularity=day&date=2026-01-05")
chk "labor booked daily" 520 "$(echo "$D2" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["current"]["costs"]["labor"]))')"
chk "save day template" 200 "$(curl -s $C -X POST "$B/schedule/templates?location=1" -d '{"location_id":1,"name":"Normal","date":"2026-01-05"}' -o /dev/null -w '%{http_code}')"
chk "apply template" 200 "$(curl -s $C -X POST "$B/schedule/templates/1/apply?location=1" -d '{"location_id":1,"date":"2026-01-06"}' -o /dev/null -w '%{http_code}')"
chk "copy last week" 200 "$(curl -s $C -X POST "$B/schedule/copy-last-week" -d '{"location_id":1,"week":"2026-01-12"}' -o /dev/null -w '%{http_code}')"
S2=$(curl -s $C "$B/schedule?location=1&week=2026-01-12")
chk "copied week keeps people" 520 "$(echo "$S2" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["totals"]["cost"]))')"
echo "== custom period =="
CP=$(curl -s $C "$B/dashboard?location=1&granularity=custom&start=2026-01-01&end=2026-01-10")
chk "custom range respected" "2026-01-01" "$(echo "$CP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["current"]["start"])')"
chk "custom prev is preceding 10d" "2025-12-22" "$(echo "$CP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["previous"]["start"])')"

echo "== moves & edits =="
chk "move revenue" 200 "$(curl -s $C -X POST $B/revenue/move -d '{"location_id":1,"from_date":"2026-01-05","to_date":"2026-01-06"}' -o /dev/null -w '%{http_code}')"
chk "move back" 200 "$(curl -s $C -X POST $B/revenue/move -d '{"location_id":1,"from_date":"2026-01-06","to_date":"2026-01-05"}' -o /dev/null -w '%{http_code}')"

echo "== manager permissions =="
curl -s $C -X POST $B/users -d '{"name":"M","email":"m@t.mx","password":"manager123","locationIds":[1]}' >/dev/null
curl -s -c /tmp/sm.cm -X POST $B/login $J -d '{"email":"m@t.mx","password":"manager123"}' >/dev/null
M="-b /tmp/sm.cm -H Content-Type:application/json"
chk "mgr no categories" 403 "$(curl -s $M -X POST "$B/categories/revenue?location=1" -d '{"location_id":1,"name":"X"}' -o /dev/null -w '%{http_code}')"
chk "mgr no users" 403 "$(curl -s $M $B/users -o /dev/null -w '%{http_code}')"
chk "mgr can log" 200 "$(curl -s $M -X PUT $B/revenue -d '{"location_id":1,"date":"2026-01-07","total":1}' -o /dev/null -w '%{http_code}')"

echo "== analytics endpoints respond =="
chk "forecast" 200 "$(curl -s $C "$B/forecast?location=1" -o /dev/null -w '%{http_code}')"
chk "insights" 200 "$(curl -s $C "$B/insights?location=1" -o /dev/null -w '%{http_code}')"
chk "compare" 200 "$(curl -s $C "$B/compare" -o /dev/null -w '%{http_code}')"
chk "goals" 200 "$(curl -s $C -X PUT $B/goals -d '{"location_id":1,"type":"profit","target":10000}' -o /dev/null -w '%{http_code}')"
chk "recalc" 200 "$(curl -s $C -X POST "$B/admin/recalc-commissions?location=1" -d '{"location_id":1}' -o /dev/null -w '%{http_code}')"
chk "import" 200 "$(curl -s $C -X POST "$B/import?location=1" -d '{"location_id":1,"type":"revenue","rows":[{"date":"2026-01-02","total":"100"}]}' -o /dev/null -w '%{http_code}')"

echo
if [ $FAIL -eq 0 ]; then echo "ALL TESTS PASSED"; else echo "FAILURES PRESENT"; exit 1; fi
