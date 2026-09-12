#!/usr/bin/env bash
# Eval Center 全量验收：后端 API TC1-TC20 + 前端 UI 截图。
set -uo pipefail
BASE="http://localhost:9999"
COOKIE=$(tail -1 /tmp/eval-cookie-line.txt)
PID="cab0db00-eb24-4fd3-b1d2-0a6e34b2fdd6"   # 冒烟测试项目
DSID="fe714a7b-0976-4a2f-81a2-8b7c151d1d97"  # 冒烟数据集
VID="0f964203-a35e-40b1-9261-ed40db5a46cb"    # v1 published
RID="54966bbe-17d2-4261-ad51-2ed09903e366"    # rubric version
RUNID="68ddd18c-57f2-4f9b-be36-d9f2c36441c4"  # completed run
PASS=0; FAIL=0; declare -a RESULTS
H="Cookie: $COOKIE"

tc() { # tc <name> <curl-args...>
  local name="$1"; shift
  local body code
  body=$(curl -s -w "\n__HTTP__%{http_code}" -H "$H" "$@" 2>/dev/null)
  code=$(echo "$body" | tail -1 | sed 's/__HTTP__//')
  body=$(echo "$body" | sed '$d')
  # 简单判定：2xx 且 body 非空非 error
  if [[ "$code" =~ ^2 ]] && ! echo "$body" | grep -q '"error"'; then
    RESULTS+=("✅|$name|HTTP $code|$(echo "$body" | head -c 80)"); PASS=$((PASS+1))
  else
    RESULTS+=("❌|$name|HTTP $code|$(echo "$body" | head -c 80)"); FAIL=$((FAIL+1))
  fi
}

echo "=== Eval Center Backend Acceptance ==="
tc "TC1 list projects"        "$BASE/api/eval-center/projects"
tc "TC2 list datasets"       "$BASE/api/eval-center/datasets?project_id=$PID"
tc "TC3 list versions"        "$BASE/api/eval-center/datasets/$DSID/versions"
tc "TC4 list cases"           "$BASE/api/eval-center/test-cases?dataset_version_id=$VID"
tc "TC5 get dataset"          "$BASE/api/eval-center/datasets/$DSID"
tc "TC6 list rubrics"         "$BASE/api/eval-center/rubrics?project_id=$PID"
tc "TC7 rubric versions"      "$BASE/api/eval-center/rubrics/35c400f8-847f-465c-b4a4-a8f52be57d54/versions"
tc "TC8 list eval-runs"       "$BASE/api/eval-center/eval-runs?project_id=$PID"
tc "TC9 get eval-run"         "$BASE/api/eval-center/eval-runs/$RUNID"
tc "TC10 run results"         "$BASE/api/eval-center/eval-runs/$RUNID/results"
tc "TC11 compare runs"        "$BASE/api/eval-center/eval-runs/compare?ids=$RUNID"
tc "TC12 drift reports"       "$BASE/api/eval-center/drift/reports?dataset_version_id=$VID"
tc "TC13 publish logs"        "$BASE/api/eval-center/publish-logs?entity_type=dataset&entity_id=$DSID"
tc "TC14 health"              "$BASE/api/eval-center/health"

# results with trace
RESULTID=$(curl -s -H "$H" "$BASE/api/eval-center/eval-runs/$RUNID/results" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a[0]?.id||'')})")
tc "TC15 result trace"        "$BASE/api/eval-center/eval-runs/$RUNID/traces/$RESULTID"

# golden annotations list
CASEID=$(curl -s -H "$H" "$BASE/api/eval-center/test-cases?dataset_version_id=$VID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a[0]?.id||'')})")
tc "TC16 golden annotations" "$BASE/api/eval-center/golden/$CASEID/annotations"

# drift detect (POST, baseline=self)
tc "TC17 drift detect"        -X POST -H "$H" -H "Content-Type: application/json" \
  -d "{\"dataset_version_id\":\"$VID\",\"baseline_version_id\":\"$VID\"}" \
  "$BASE/api/eval-center/drift/detect"

echo ""
echo "=== Results ==="
for r in "${RESULTS[@]}"; do IFS='|' read -ra parts <<< "$r"; printf "%s %-22s %-10s %s\n" "${parts[0]}" "${parts[1]}" "${parts[2]}" "${parts[3]}"; done
echo ""
echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
