#!/usr/bin/env python3
"""
Trigger INTELLIGENT pour hébergement (50s OK).

Ne lance GitHub Actions QUE si le BUILD_NUMBER Canary a changé.
Sinon : un simple check HTTP, zéro spam Actions.

Setup:
  1. export GITHUB_TOKEN=... (PAT classic : repo + workflow)
  2. python3 scripts/trigger_host.py

Env:
  GITHUB_TOKEN, GITHUB_REPO, INTERVAL (défaut 50)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
# Ne jamais coller de token dans ce fichier : utiliser la variable d’environnement GITHUB_TOKEN.

REPO = os.environ.get("GITHUB_REPO", "kmljkjj/discord-canary-scraper")
EVENT = "trigger-scraping"
INTERVAL = int(os.environ.get("INTERVAL", "50"))
STATE_FILE = os.environ.get("BUILD_STATE_FILE", "last_canary_build.txt")
CANARY_URL = "https://canary.discord.com/app"
UA = "Mozilla/5.0 (compatible; canary-host-trigger/2.0)"


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def http_get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def get_canary_build() -> str | None:
    try:
        html = http_get(CANARY_URL)
    except Exception as e:
        log(f"canary fetch fail: {e}")
        return None
    m = re.search(r'"BUILD_NUMBER"\s*:\s*"?(\d+)"?', html)
    return m.group(1) if m else None


def read_last() -> str | None:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def write_last(build: str) -> None:
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            f.write(build)
    except Exception as e:
        log(f"write state fail: {e}")


def dispatch() -> bool:
    if not TOKEN or len(TOKEN) < 20:
        log("TOKEN manquant (GITHUB_TOKEN ou ligne TOKEN= dans le fichier)")
        return False
    url = f"https://api.github.com/repos/{REPO}/dispatches"
    body = json.dumps({"event_type": EVENT}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {TOKEN}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "canary-host-trigger",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            log(f"DISPATCH OK {res.status} → {REPO}")
            return True
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        log(f"DISPATCH HTTP {e.code}: {err[:300]}")
        return False
    except Exception as e:
        log(f"DISPATCH err: {e}")
        return False


def tick() -> None:
    build = get_canary_build()
    if not build:
        log("pas de BUILD_NUMBER")
        return
    last = read_last()
    if last == build:
        log(f"build {build} inchangé — pas de dispatch")
        return
    log(f"NOUVEAU build {last} → {build} — dispatch Actions")
    if dispatch():
        write_last(build)
    else:
        log("dispatch échoué — on réessaiera")


def main() -> None:
    log(f"smart trigger interval={INTERVAL}s repo={REPO}")
    if not TOKEN:
        log("ATTENTION: pas de TOKEN")
    while True:
        try:
            tick()
        except Exception as e:
            log(f"tick error: {e}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
