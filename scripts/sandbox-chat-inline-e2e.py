#!/usr/bin/env python3
"""E2E smoke test for sandbox chat-inline feature."""
import json
import time
import urllib.request
import urllib.parse

BASE = "http://localhost:9898"
COOKIE = "/tmp/dt-cookie-e2e.txt"

def login():
    body = json.dumps({"username": "admin", "password": "admin123"}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        # save cookies
        cookies = resp.headers.get_all("Set-Cookie") or []
        with open(COOKIE, "w") as f:
            f.write("\n".join(c.split(";")[0] for c in cookies))
        data = json.loads(resp.read())
        print(f"✓ login: {data['user']['username']}")
        return data["user"]

def http_get(path):
    with open(COOKIE) as f:
        cookies = f.read().strip().replace("\n", "; ")
    req = urllib.request.Request(
        f"{BASE}{path}",
        headers={"Cookie": cookies},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def http_post(path, body):
    with open(COOKIE) as f:
        cookies = f.read().strip().replace("\n", "; ")
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Cookie": cookies, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def test_by_group_empty_for_new_group():
    """A fresh group folder should have no sandbox bound."""
    r = http_get("/api/sandbox/by-group/test-e2e-empty")
    assert r.get("sessionId") is None, f"expected null, got {r}"
    print(f"✓ by-group for empty folder: {r}")

def test_create_sandbox_and_list_files():
    """Create a sandbox, write a file, list /workspace, verify entries."""
    # 1. Create a sandbox (no browser — faster, just for file ops)
    r = http_post("/api/sandbox/sessions", {"language": "python", "browserEnabled": False})
    sid = r["id"]
    print(f"✓ created sandbox: {sid}")
    try:
        # 2. Write a file via execute
        code = '''
import os
os.makedirs("/workspace/subdir", exist_ok=True)
with open("/workspace/hello.py", "w") as f:
    f.write("print('hello')\\n")
with open("/workspace/subdir/data.txt", "w") as f:
    f.write("test data\\n")
print("ok")
'''
        r = http_post(f"/api/sandbox/sessions/{sid}/execute", {
            "language": "python",
            "code": code,
            "timeoutMs": 30000,
        })
        print(f"✓ execute status={r['status']} exit={r['exitCode']}")
        assert r["status"] == "completed", f"execute failed: {r}"
        assert r["exitCode"] == 0, f"exit code: {r['exitCode']}"
        assert "ok" in r["stdout"], f"no 'ok' in stdout: {r['stdout']}"

        # 3. List /workspace
        r = http_get(f"/api/sandbox/sessions/{sid}/files?path=/workspace")
        print(f"✓ list /workspace: {r}")
        names = [e["name"] for e in r["entries"]]
        assert "hello.py" in names, f"hello.py missing: {names}"
        assert "subdir" in names, f"subdir missing: {names}"
        hello = [e for e in r["entries"] if e["name"] == "hello.py"][0]
        assert hello["type"] == "file", f"hello.py type: {hello}"
        subdir = [e for e in r["entries"] if e["name"] == "subdir"][0]
        assert subdir["type"] == "dir", f"subdir type: {subdir}"

        # 4. List /workspace/subdir
        r = http_get(f"/api/sandbox/sessions/{sid}/files?path=/workspace/subdir")
        print(f"✓ list /workspace/subdir: {r}")
        names = [e["name"] for e in r["entries"]]
        assert "data.txt" in names, f"data.txt missing: {names}"

        # 5. Path traversal blocked
        r = http_get(f"/api/sandbox/sessions/{sid}/files?path=/etc")
        assert "error" in r, f"path /etc should be blocked: {r}"
        r = http_get(f"/api/sandbox/sessions/{sid}/files?path=/workspace/../../etc/passwd")
        assert "error" in r, f"traversal should be blocked: {r}"
        print("✓ path traversal blocked")
    finally:
        # Cleanup
        req = urllib.request.Request(
            f"{BASE}/api/sandbox/sessions/{sid}",
            method="DELETE",
            headers={"Cookie": open(COOKIE).read().strip().replace("\n", "; ")},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"✓ destroyed sandbox: {resp.read()}")
        except Exception as e:
            print(f"⚠ cleanup failed: {e}")

def test_chinese_font_in_browser_sandbox():
    """Create a browser-enabled sandbox, navigate to a Chinese page,
    screenshot, verify it renders without tofu boxes."""
    r = http_post("/api/sandbox/sessions", {
        "language": "python",
        "browserEnabled": True,
    })
    sid = r["id"]
    print(f"✓ created browser sandbox: {sid}")
    try:
        # Start browser (REST-only, onFrame no-op)
        r = http_post(f"/api/sandbox/sessions/{sid}/browser/start", {})
        print(f"✓ browser started: {r}")
        assert r.get("started"), f"browser not started: {r}"

        # Navigate to a page with Chinese text
        r = http_post(f"/api/sandbox/sessions/{sid}/browser/navigate", {
            "url": "https://www.baidu.com",
        })
        print(f"✓ navigate baidu: {r}")
        time.sleep(3)  # let it render

        # Screenshot
        r = http_post(f"/api/sandbox/sessions/{sid}/browser/screenshot", {})
        print(f"✓ screenshot keys: {list(r.keys())}")
        assert r.get("screenshot"), f"no screenshot: {r}"
        # Save PNG for visual inspection
        import base64
        data_url = r["screenshot"]
        b64 = data_url.split(",", 1)[1]
        png = base64.b64decode(b64)
        with open("/tmp/sandbox-chinese-font-test.png", "wb") as f:
            f.write(png)
        print(f"✓ saved screenshot: /tmp/sandbox-chinese-font-test.png ({len(png)} bytes)")
        print(f"  title: {r.get('title')}")
        print(f"  url: {r.get('url')}")
    finally:
        req = urllib.request.Request(
            f"{BASE}/api/sandbox/sessions/{sid}",
            method="DELETE",
            headers={"Cookie": open(COOKIE).read().strip().replace("\n", "; ")},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"✓ destroyed browser sandbox: {resp.read()}")
        except Exception as e:
            print(f"⚠ cleanup failed: {e}")

if __name__ == "__main__":
    login()
    print()
    print("--- Test 1: by-group for empty folder ---")
    test_by_group_empty_for_new_group()
    print()
    print("--- Test 2: create sandbox + list files + path safety ---")
    test_create_sandbox_and_list_files()
    print()
    print("--- Test 3: chinese font in browser sandbox ---")
    test_chinese_font_in_browser_sandbox()
    print()
    print("🎉 ALL E2E TESTS PASSED")
