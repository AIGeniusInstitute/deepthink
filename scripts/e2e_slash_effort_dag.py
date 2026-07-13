"""
DeepThink slash/effort/DAG UI E2E test (playwright).

Covers:
  1. Login + reach chat page
  2. Slash command popover: type /, see filtered list, Tab to complete
  3. Effort selector: open env panel, change effort, verify persisted
  4. DAG tab: switch to DAG sidebar, verify empty state renders
  5. Trace nodes injected via API, verify reactflow canvas renders nodes
  6. Click a node, verify detail panel shows
  7. Edit annotation input/output, save, verify persisted
  8. Continue-from-here: builds context-augmented message with parent chain
"""

import json
import sqlite3
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:5174"
API_URL = "http://localhost:9911"
DB_PATH = "/tmp/dt-e2e-test/db/messages.db"
ENV_FILE = "/tmp/dt-e2e-test/config/container-env/main.json"
SHOTS_DIR = Path("/tmp/dt-e2e-shots")
SHOTS_DIR.mkdir(exist_ok=True)

USERNAME = "admin"
PASSWORD = "admin123"


def api(method: str, path: str, cookies: str, body=None):
    url = f"{API_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Cookie", cookies)
    with urlopen(req) as r:
        return r.status, r.read().decode()


def login_and_setup_provider():
    """Login as admin and configure a dummy Claude provider so the app
    doesn't redirect to /setup/providers on first visit."""
    s, body = api("POST", "/api/auth/login", "", {"username": USERNAME, "password": PASSWORD})
    if s != 200:
        raise RuntimeError(f"login failed: {s} {body}")
    # Extract set-cookie from a manual request — urllib won't expose it via the
    # helper above. Re-do with a lower-level call.
    import http.client
    conn = http.client.HTTPConnection("localhost", 9911)
    conn.request(
        "POST", "/api/auth/login",
        body=json.dumps({"username": USERNAME, "password": PASSWORD}),
        headers={"Content-Type": "application/json"},
    )
    resp = conn.getresponse()
    cookies = resp.getheader("set-cookie") or ""
    resp.read()
    # Parse the session cookie value
    cookie_parts = []
    for c in cookies.split(","):
        c = c.strip()
        if c.startswith("session="):
            # take up to first ;
            cookie_parts.append(c.split(";")[0])
            break
    session_cookie = cookie_parts[0] if cookie_parts else ""
    # Create provider
    api(
        "POST",
        "/api/config/claude/providers",
        session_cookie,
        {
            "name": "test",
            "type": "third_party",
            "anthropicBaseUrl": "https://api.example.com",
            "anthropicAuthToken": "test-token",
            "enabled": True,
        },
    )
    return session_cookie


def insert_trace_nodes():
    """Inject sample nodes directly into the DB so the DAG canvas has content."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM chat_trace_nodes WHERE chat_jid = 'web:main'")
    rows = [
        (1, "web:main", None, None, "turn", "用户消息", "hello, please list files", None, 500, "done", None, None, "2026-07-08T10:00:00Z", None),
        (2, "web:main", None, 1, "tool", "Bash", "ls -la", "file1\nfile2", 100, "done", None, None, "2026-07-08T10:00:01Z", "2026-07-08T10:00:02Z"),
        (3, "web:main", None, 1, "skill", "Skill:github-trending", '{"name":"github-trending"}', "trending repos fetched", 200, "done", None, None, "2026-07-08T10:00:05Z", "2026-07-08T10:00:10Z"),
        (4, "web:main", None, 1, "subagent", "web-researcher", "research topic X", None, 0, "running", None, None, "2026-07-08T10:00:15Z", None),
    ]
    cur.executemany(
        "INSERT INTO chat_trace_nodes (id, chat_jid, session_id, parent_node_id, node_type, title, "
        "input_summary, output_summary, tokens, status, annotation_input, annotation_output, "
        "started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    conn.close()
    print(f"[setup] inserted {len(rows)} trace nodes")


def main():
    insert_trace_nodes()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.set_default_timeout(10000)

        # ---- 1. Login ----
        page.goto(f"{BASE_URL}/login")
        page.wait_for_load_state("networkidle")
        page.fill('input[name="username"], input[type="text"]', USERNAME)
        page.fill('input[name="password"], input[type="password"]', PASSWORD)
        page.screenshot(path=str(SHOTS_DIR / "01-login.png"))
        page.click('button[type="submit"]')
        page.wait_for_url(lambda url: "/chat" in url, timeout=10000)
        print(f"[1] login OK, url={page.url}")
        page.screenshot(path=str(SHOTS_DIR / "02-chat-landed.png"))

        # ---- 2. Slash command popover ----
        # Find the textarea
        textarea = page.locator("textarea").first
        textarea.click()
        textarea.fill("/")
        page.wait_for_timeout(300)  # let useMemo recompute
        # Popover should be visible with builtin commands
        popover = page.locator('div[class*="absolute"]').filter(has=page.locator('text=/^\\/(clear|cost|skills|recall|list|status|ls|rc|require_mention)$/'))
        # Try simpler: look for any element containing /clear
        expect_clear = page.get_by_text("/clear", exact=False)
        if expect_clear.count() == 0:
            page.screenshot(path=str(SHOTS_DIR / "03-slash-fail.png"))
            print("[2] FAIL: slash popover did not show /clear")
            sys.exit(1)
        print(f"[2] slash popover visible, /clear found (count={expect_clear.count()})")
        page.screenshot(path=str(SHOTS_DIR / "03-slash-popover.png"))

        # Filter by typing "co"
        textarea.fill("/")
        page.keyboard.type("co")
        page.wait_for_timeout(300)
        # /cost should still be visible, /clear should not
        if page.get_by_text("/cost", exact=False).count() == 0:
            print("[2] FAIL: /cost not visible after typing /co")
            sys.exit(1)
        # Tab to complete
        page.keyboard.press("Tab")
        page.wait_for_timeout(200)
        textarea_value = textarea.input_value()
        if not textarea_value.startswith("/cost"):
            print(f"[2] FAIL: textarea not completed to /cost, got: {textarea_value!r}")
            sys.exit(1)
        print(f"[2] slash completion OK, textarea={textarea_value!r}")
        page.screenshot(path=str(SHOTS_DIR / "04-slash-completed.png"))

        # Clear textarea
        textarea.fill("")

        # ---- 3. Effort selector ----
        # Open the right sidebar panel (collapsed by default on desktop)
        open_panel_btn = page.get_by_role("button", name="展开面板").first
        if open_panel_btn.count() == 0:
            open_panel_btn = page.get_by_role("button", name="收起面板").first
        if open_panel_btn.count() > 0:
            open_panel_btn.click()
            page.wait_for_timeout(400)
        # SIDEBAR_TABS order: files(0), env(1), skills(2), mcp(3), dag(4), members?(5)
        # Click env tab (index 1) in the icon tab bar
        sidebar_tab_buttons = page.locator(
            'div.flex.border-b.border-border > button'
        )
        if sidebar_tab_buttons.count() < 5:
            print(f"[3] FAIL: sidebar tabs not rendered (count={sidebar_tab_buttons.count()})")
            sys.exit(1)
        sidebar_tab_buttons.nth(1).click()  # env
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS_DIR / "05-env-panel.png"))

        # Find the CLAUDE_EFFORT select
        effort_select = page.locator('select').filter(has=page.locator('option:has-text("High")')).first
        if effort_select.count() == 0:
            print("[3] FAIL: effort select not found")
            sys.exit(1)
        effort_select.select_option("high")
        page.wait_for_timeout(300)
        # Save button
        save_btn = page.get_by_role("button", name="保存并重建工作区").first
        save_btn.click()
        page.wait_for_timeout(2000)
        # Verify persisted to file
        import json as _json
        env_data = _json.loads(Path(ENV_FILE).read_text())
        if env_data.get("customEnv", {}).get("CLAUDE_EFFORT") != "high":
            print(f"[3] FAIL: CLAUDE_EFFORT not persisted, env={env_data}")
            sys.exit(1)
        print(f"[3] effort=high persisted to {ENV_FILE}")
        page.screenshot(path=str(SHOTS_DIR / "06-effort-saved.png"))

        # ---- 4. DAG Tab ----
        # Click dag tab (index 4) in the icon tab bar
        sidebar_tab_buttons = page.locator(
            'div.flex.border-b.border-border > button'
        )
        if sidebar_tab_buttons.count() < 5:
            print(f"[4] FAIL: sidebar tabs not rendered (count={sidebar_tab_buttons.count()})")
            sys.exit(1)
        sidebar_tab_buttons.nth(4).click()  # dag
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS_DIR / "07-dag-tab.png"))
        # The canvas should show nodes. reactflow renders .react-flow__node
        nodes = page.locator(".react-flow__node")
        node_count = nodes.count()
        if node_count == 0:
            print(f"[4] FAIL: no DAG nodes rendered")
            sys.exit(1)
        print(f"[4] DAG canvas rendered {node_count} nodes")
        page.screenshot(path=str(SHOTS_DIR / "08-dag-nodes.png"))

        # ---- 5. Click a node (node #3 = skill) ----
        # Nodes have data-id attributes
        skill_node = page.locator('.react-flow__node[data-id="3"]')
        if skill_node.count() == 0:
            print("[5] FAIL: skill node #3 not found")
            sys.exit(1)
        skill_node.click()
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS_DIR / "09-node-detail.png"))
        # Detail panel should show "#3" and "Skill (技能)"
        if page.get_by_text("#3", exact=False).count() == 0:
            print("[5] FAIL: detail panel #3 not visible")
            sys.exit(1)
        if page.get_by_text("Skill (技能)", exact=False).count() == 0:
            print("[5] FAIL: detail panel Skill label not visible")
            sys.exit(1)
        print("[5] node detail panel visible for #3")

        # ---- 6. Edit annotations ----
        # Find the two textareas in the detail panel (input + output)
        detail_textareas = page.locator('textarea')
        count = detail_textareas.count()
        # The first textarea in the detail panel should be the annotation input
        # (chat input textarea is in the main chat box — but we're in env/dag panel area)
        # Get the last two textareas which should be the annotation fields
        if count < 2:
            print(f"[6] FAIL: not enough textareas found ({count})")
            sys.exit(1)
        ann_input = detail_textareas.nth(count - 2)
        ann_output = detail_textareas.nth(count - 1)
        ann_input.fill("edited skill input")
        ann_output.fill("edited skill output")
        page.wait_for_timeout(200)
        # Save annotation button
        save_ann_btn = page.get_by_role("button", name="保存注解").first
        save_ann_btn.click()
        page.wait_for_timeout(1000)
        # Verify DB persistence
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("SELECT annotation_input, annotation_output FROM chat_trace_nodes WHERE chat_jid='web:main' AND id=3")
        row = cur.fetchone()
        conn.close()
        if row != ("edited skill input", "edited skill output"):
            print(f"[6] FAIL: annotation not persisted, got {row}")
            sys.exit(1)
        print(f"[6] annotation saved OK, db={row}")
        page.screenshot(path=str(SHOTS_DIR / "10-annotation-saved.png"))

        # ---- 7. Continue from here (build context message) ----
        # Click "从此续跑"
        continue_btn = page.get_by_role("button", name="从此续跑").first
        # Expect a confirm dialog
        page.on("dialog", lambda d: d.accept())
        continue_btn.click()
        page.wait_for_timeout(1500)
        # The message should have been sent — check messages API
        cookies = "; ".join([f"{c['name']}={c['value']}" for c in context.cookies()])
        status, body = api("GET", "/api/groups/web:main/messages?limit=1", cookies)
        if status != 200:
            print(f"[7] FAIL: messages API returned {status}")
            sys.exit(1)
        data = json.loads(body)
        messages = data.get("messages", [])
        if not messages:
            print("[7] FAIL: no messages returned")
            sys.exit(1)
        last_msg = messages[0]
        content = last_msg.get("content", "")
        if "[从节点 #3 续跑]" not in content:
            print(f"[7] FAIL: last message does not contain continue marker, content={content[:200]!r}")
            sys.exit(1)
        if "## 父节点链路" not in content:
            print(f"[7] FAIL: parent chain not in message, content={content[:300]!r}")
            sys.exit(1)
        if "Skill:github-trending" not in content:
            print(f"[7] FAIL: skill title not in message, content={content[:400]!r}")
            sys.exit(1)
        print(f"[7] continue-from-here message built OK (len={len(content)})")
        print(f"    message preview: {content[:200]!r}")
        page.screenshot(path=str(SHOTS_DIR / "11-continue-sent.png"))

        print("\n=== ALL UI E2E TESTS PASSED ===")
        browser.close()


if __name__ == "__main__":
    main()
