#!/usr/bin/env python3
import base64
import json
import os
import sys
import time
import uuid

try:
    from curl_cffi import requests
except ModuleNotFoundError as error:
    raise SystemExit(
        "Missing Python dependency curl_cffi. Install it with: python3 -m pip install curl_cffi"
    ) from error


VENICE_ORIGIN = "https://venice.ai"
CLERK_BASE_URL = "https://clerk.venice.ai"
OUTFACE_BASE_URL = "https://outerface.venice.ai"
CLERK_API_VERSION = "2025-11-10"
CLERK_JS_VERSION = "5.125.10"
VENICE_VERSION = "interface@20260429.025033+f3675fb"
MIDDLEFACE_VERSION = "0.1.692"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
SIGN_IN_URL = (
    f"{VENICE_ORIGIN}/sign-in#/?"
    "sign_up_force_redirect_url=https%3A%2F%2Fvenice.ai%2Fsign-up-migration&"
    "sign_in_force_redirect_url=https%3A%2F%2Fvenice.ai%2Fchat&"
    "redirect_url=https%3A%2F%2Fvenice.ai%2Fchat"
)


def required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required env var: {name}")
    return value


def now_ms():
    return int(time.time() * 1000)


def decode_jwt_payload(jwt):
    try:
        payload = jwt.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
    except Exception:
        return {}


def read_json_response(response):
    text = response.text
    try:
        data = response.json() if text else None
    except Exception:
        data = text
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(
            f"HTTP {response.status_code}: "
            f"{data if isinstance(data, str) else json.dumps(data, separators=(',', ':'))}"
        )
    return data


def browser_headers(extra=None):
    headers = {
        "user-agent": USER_AGENT,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
    }
    if extra:
        headers.update(extra)
    return headers


def export_cookies(session):
    cookies = []
    for cookie in session.cookies.jar:
        expires_at = None
        if cookie.expires:
            expires_at = int(cookie.expires * 1000)
        domain = cookie.domain or ""
        cookies.append(
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": domain,
                "path": cookie.path or "/",
                "secure": bool(cookie.secure),
                "httpOnly": "HttpOnly" in getattr(cookie, "_rest", {}),
                "hostOnly": not domain.startswith("."),
                "expiresAt": expires_at,
            }
        )
    return cookies


def main():
    email = required_env("VENICE_EMAIL")
    password = required_env("VENICE_PASSWORD")
    session_file = os.environ.get("VENICE_SESSION_FILE", ".venice-web-session.json").strip()

    clerk_query = (
        f"__clerk_api_version={CLERK_API_VERSION}&_clerk_js_version={CLERK_JS_VERSION}"
    )
    session = requests.Session(impersonate=os.environ.get("VENICE_CURL_IMPERSONATE", "chrome131"))

    session.get(
        SIGN_IN_URL,
        headers=browser_headers(
            {
                "accept": (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,"
                    "image/avif,image/webp,image/apng,*/*;q=0.8,"
                    "application/signed-exchange;v=b3;q=0.7"
                ),
                "referer": f"{VENICE_ORIGIN}/",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
            }
        ),
    )
    session.get(
        f"{VENICE_ORIGIN}/api/auth/session",
        headers=browser_headers(
            {
                "content-type": "application/json",
                "referer": f"{VENICE_ORIGIN}/sign-in",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
            }
        ),
    )
    read_json_response(
        session.get(
            f"{CLERK_BASE_URL}/v1/environment?{clerk_query}",
            headers=browser_headers(
                {
                    "origin": VENICE_ORIGIN,
                    "referer": f"{VENICE_ORIGIN}/",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                }
            ),
        )
    )
    read_json_response(
        session.get(
            f"{CLERK_BASE_URL}/v1/client?{clerk_query}",
            headers=browser_headers(
                {
                    "origin": VENICE_ORIGIN,
                    "referer": f"{VENICE_ORIGIN}/",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                }
            ),
        )
    )

    sign_in = read_json_response(
        session.post(
            f"{CLERK_BASE_URL}/v1/client/sign_ins?{clerk_query}",
            headers=browser_headers(
                {
                    "content-type": "application/x-www-form-urlencoded",
                    "origin": VENICE_ORIGIN,
                    "referer": f"{VENICE_ORIGIN}/",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                    "priority": "u=1, i",
                }
            ),
            data={"locale": "en-US", "identifier": email},
        )
    )
    sign_in_attempt_id = (
        sign_in.get("response", {}).get("id")
        or sign_in.get("client", {}).get("sign_in", {}).get("id")
    )
    if not sign_in_attempt_id:
        raise RuntimeError("Could not resolve Clerk sign-in attempt id.")

    verification = read_json_response(
        session.post(
            f"{CLERK_BASE_URL}/v1/client/sign_ins/{sign_in_attempt_id}/attempt_first_factor?{clerk_query}",
            headers=browser_headers(
                {
                    "content-type": "application/x-www-form-urlencoded",
                    "origin": VENICE_ORIGIN,
                    "referer": f"{VENICE_ORIGIN}/",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                    "priority": "u=1, i",
                }
            ),
            data={"strategy": "password", "password": password},
        )
    )
    response = verification.get("response", {})
    session_id = response.get("created_session_id")
    user_id = (
        response.get("created_user_id")
        or verification.get("client", {}).get("sessions", [{}])[0].get("user", {}).get("id")
        or response.get("user_data", {}).get("id")
    )
    if not session_id:
        raise RuntimeError("Could not resolve Clerk session id.")

    session.post(
        f"{VENICE_ORIGIN}/sign-in/continue",
        headers=browser_headers(
            {
                "accept": "text/x-component",
                "content-type": "text/plain;charset=UTF-8",
                "origin": VENICE_ORIGIN,
                "referer": f"{VENICE_ORIGIN}/sign-in/continue",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
            }
        ),
        data="[]",
    )

    touched = read_json_response(
        session.post(
            f"{CLERK_BASE_URL}/v1/client/sessions/{session_id}/touch?{clerk_query}",
            headers=browser_headers(
                {
                    "content-type": "application/x-www-form-urlencoded",
                    "origin": VENICE_ORIGIN,
                    "referer": f"{VENICE_ORIGIN}/",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                    "priority": "u=1, i",
                }
            ),
            data={"active_organization_id": "", "intent": "select_session"},
        )
    )
    clerk_jwt = touched.get("response", {}).get("last_active_token", {}).get("jwt")
    if not clerk_jwt:
        raise RuntimeError("Could not resolve Clerk session JWT from touch response.")

    distinct_id = str(uuid.uuid4())
    user_session = read_json_response(
        session.get(
            f"{OUTFACE_BASE_URL}/api/user/session",
            headers=browser_headers(
                {
                    "authorization": f"Bearer {clerk_jwt}",
                    "origin": VENICE_ORIGIN,
                    "referer": f"{VENICE_ORIGIN}/",
                    "x-venice-distinct-id": distinct_id,
                    "x-venice-locale": "en",
                    "x-venice-request-timestamp-ms": str(now_ms()),
                    "x-venice-version": VENICE_VERSION,
                    "x-venice-middleface-version": MIDDLEFACE_VERSION,
                }
            ),
        )
    )

    payload = decode_jwt_payload(clerk_jwt)
    snapshot = {
        "savedAt": now_ms(),
        "sessionFile": session_file,
        "email": email,
        "sessionId": session_id,
        "clerkJwt": clerk_jwt,
        "clerkJwtExpiresAt": payload.get("exp") * 1000 if payload.get("exp") else None,
        "userId": user_id or user_session.get("userId") or user_session.get("authSystemUserId"),
        "userDistinctId": user_session.get("id") or user_session.get("user", {}).get("id") or distinct_id,
        "deviceDistinctId": distinct_id,
        "veniceVersion": VENICE_VERSION,
        "middlefaceVersion": MIDDLEFACE_VERSION,
        "cookies": export_cookies(session),
        "lastValidatedAt": now_ms(),
        "loginMethod": "curl_cffi",
    }
    with open(session_file, "w", encoding="utf-8") as output:
        json.dump(snapshot, output, indent=2)

    print(
        json.dumps(
            {
                "ok": True,
                "source": "login",
                "sessionFile": session_file,
                "email": user_session.get("email") or email,
                "sessionId": session_id,
                "clerkJwtPreview": clerk_jwt[:24] + "...",
                "hasOuterfaceToken": bool(user_session.get("token")),
                "canPost": user_session.get("canPost"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
