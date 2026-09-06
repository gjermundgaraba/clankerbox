#!/usr/bin/env python3
"""Resolve the experiment's registry inputs to immutable amd64 manifests."""
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

IMAGES = {
    "CUBE_PROXY_COREDNS_IMAGE": "cube-sandbox-image.tencentcloudcr.com/opensource/coredns/coredns:1.14.2",
    "CUBE_SANDBOX_MYSQL_IMAGE": "cube-sandbox-image.tencentcloudcr.com/opensource/mysql:8.0",
    "CUBE_SANDBOX_REDIS_IMAGE": "cube-sandbox-image.tencentcloudcr.com/opensource/redis:7-alpine",
    "WEB_UI_IMAGE": "cube-sandbox-image.tencentcloudcr.com/opensource/openresty:1.21.4.1-6-alpine-fat",
    "CUBE_SANDBOX_MINIO_IMAGE": "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/minio:RELEASE.2025-09-07T16-13-09Z",
    "CUBE_SANDBOX_CUBE_PROXY_IMAGE": "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-proxy:v0.7.0",
    "CUBE_SANDBOX_CUBE_LCM_IMAGE": "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-lifecycle-manager:v0.7.0",
    "CUBE_SANDBOX_CUBE_EGRESS_IMAGE": "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-egress:v0.7.0",
    "GUEST_BASE": "ghcr.io/tencentcloud/cubesandbox-base:latest",
    "REGISTRY_IMAGE": "registry-1.docker.io/library/registry:2.8.3",
    "RUNNER_BASE": "registry-1.docker.io/library/ubuntu:24.04",
}


def resolve(ref):
    host, tail = ref.split("/", 1)
    repo, tag = tail.rsplit(":", 1)
    headers = {"Accept": ", ".join([
        "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json"])}

    def fetch(tag):
        url = f"https://{host}/v2/{repo}/manifests/{tag}"
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            auth = dict(re.findall(r'(\w+)="([^"]+)"', e.headers["WWW-Authenticate"]))
            realm = auth.pop("realm")
            token_url = realm + "?" + urllib.parse.urlencode(auth)
            token = json.load(urllib.request.urlopen(token_url, timeout=60))
            headers["Authorization"] = "Bearer " + (token.get("token") or token["access_token"])
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60).read()

    raw = fetch(tag)
    manifest = json.loads(raw)
    if "manifests" in manifest:
        choices = [m for m in manifest["manifests"] if m.get("platform", {}).get("architecture") == "amd64"
                   and m.get("platform", {}).get("os") == "linux"]
        if len(choices) != 1:
            raise ValueError(f"Expected one Linux amd64 manifest: {ref}")
        raw = fetch(choices[0]["digest"])
        manifest = json.loads(raw)
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    return {"source": ref, "pinned": f"{host}/{repo}@{digest}",
            "compressed_layer_bytes": sum(l["size"] for l in manifest["layers"])}


if __name__ == "__main__":
    output = {}
    for name, ref in IMAGES.items():
        print(name, flush=True)
        output[name] = resolve(ref)
        Path("images.lock.json").write_text(json.dumps(output, indent=2) + "\n")
