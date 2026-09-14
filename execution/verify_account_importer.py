import json
import urllib.request
import urllib.parse
import http.cookiejar

BASE_URL = "http://localhost:3000"

def test_account_importer():
    print("=== Testing Universal Account Migration Endpoint ===")
    
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # 1. Login or Register
    login_data = json.dumps({"username": "TestUser999", "password": "Password123!"}).encode('utf-8')
    req = urllib.request.Request(f"{BASE_URL}/api/auth/login", data=login_data, headers={'Content-Type': 'application/json'})
    
    try:
        res = opener.open(req)
    except urllib.error.HTTPError as e:
        reg_data = json.dumps({
            "username": "TestUser999",
            "password": "Password123!",
            "storeNickname": "TestUser",
            "email": "testuser999@example.com"
        }).encode('utf-8')
        req_reg = urllib.request.Request(f"{BASE_URL}/api/auth/register", data=reg_data, headers={'Content-Type': 'application/json'})
        res = opener.open(req_reg)

    # 2. Test Multi-Deck Importer
    raw_text = """// Universal Test Deck 1
1 Sol Ring
1 Command Tower
1 Kaalia of the Vast *CMDR*

// Universal Test Deck 2
1 Yuriko, the Tiger's Shadow *CMDR*
1 Ponder
1 Brainstorm
"""
    import_payload = json.dumps({
        "platform": "text",
        "decksText": raw_text
    }).encode('utf-8')

    req_import = urllib.request.Request(f"{BASE_URL}/api/decks/import-account", data=import_payload, headers={'Content-Type': 'application/json'})
    try:
        res_import = opener.open(req_import)
        data = json.loads(res_import.read().decode('utf-8'))
        print("Import Result:", data)
        assert data.get("success") is True
        assert data.get("count") == 2, f"Expected 2 imported decks, got {data.get('count')}"
        print("Universal Account Migration Integration Test Passed!")
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8')
        print(f"HTTP {e.code} Error Response: {err_msg}")
        raise e

if __name__ == "__main__":
    test_account_importer()
