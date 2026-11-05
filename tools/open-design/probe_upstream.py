#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探测 Open Design API 背后真实上游供应商
==============================================================
思路：不猜，让对方的响应自己说。

三条线索，按可靠度排序：

1. 流式元数据（最硬）
   OpenAI 兼容的流里，Open Design 每个 chunk 都带 extra_fields：
       routing_info.provider / routing_info.key / resolved_model_used
   这是网关自己写进去的，等于直接报家名。

2. 错误响应（指纹）
   网关如果把上游的报错原样透传，错误结构会带上上游的特征：
   - 火山方舟 / BytePlus：{"error":{"code":"InvalidParameter","message":...}}，
     常见 code：InvalidParameter / ModelNotOpen / AuthenticationError，
     响应头常带 x-tt-logid（tt = 字节系）
   - DeepSeek 官方：{"error":{"message":...,"type":"invalid_request_error",
     "param":null,"code":"invalid_request_error"}}
   两边字段名和 code 取值完全不同，很好区分。

3. 响应头 + id 前缀
   - X-Tt-Logid / x-tt-trace-id → 字节系
   - id 形如 resp_02...（本例）还是 chatcmpl-...（OpenAI/DeepSeek 风格）

用法：
  python probe_upstream.py                 # 跑全部探测
  python probe_upstream.py --only baseline # 只看流元数据
"""
from __future__ import annotations

import argparse
import http.client
import json
import re
import ssl
import sys

import od_ttft

HOST = "amr-link.open-design.ai"
PATH = "/v1/chat/completions"
MODEL = "deepseek-v4.1-flash"

HEADER_KEYS = ("server", "via", "cf-ray", "x-request-id", "x-tt-logid",
               "x-tt-trace-id", "x-ratelimit-limit-requests", "retry-after",
               "content-type")


def call(key: str, payload: dict, stream: bool, timeout: float = 25.0):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPSConnection(HOST, 443, timeout=timeout,
                                       context=ssl.create_default_context())
    conn.request("POST", PATH, body=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    })
    resp = conn.getresponse()
    headers = {k.lower(): v for k, v in resp.getheaders()}
    if stream:
        raw = b""
        while len(raw) < 4096:
            piece = resp.read1(1024)
            if not piece:
                break
            raw += piece
    else:
        raw = resp.read(8192)
    conn.close()
    return resp.status, headers, raw


def show_headers(headers: dict) -> None:
    picked = {k: headers[k] for k in HEADER_KEYS if k in headers}
    extra = {k: v for k, v in headers.items() if k.startswith("x-tt")}
    print("    响应头:", json.dumps({**picked, **extra}, ensure_ascii=False))


def show_body(raw: bytes) -> str:
    text = raw.decode("utf-8", "replace")
    print("    正文:", text[:400].replace("\n", " ").strip())
    return text


def parse_stream_meta(raw: bytes) -> dict:
    """从流式响应里挖网关自己的元数据。"""
    meta = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            obj = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        extra = obj.get("extra_fields") or {}
        routing = extra.get("routing_info") or {}
        for name, value in (("provider", routing.get("provider") or extra.get("provider")),
                            ("key", routing.get("key")),
                            ("resolved_model", extra.get("resolved_model_used")),
                            ("id", obj.get("id")),
                            ("model", obj.get("model")),
                            ("system_fingerprint", obj.get("system_fingerprint"))):
            if value and name not in meta:
                meta[name] = value
        if meta.get("provider"):
            break
    return meta


def fingerprint(headers: dict, text: str, meta: dict) -> list[str]:
    low = text.lower()
    hits = []
    provider = (meta.get("provider") or "").lower()
    if "byteplus" in provider:
        hits.append(f"流元数据直接点名 provider={meta['provider']}")
    if meta.get("key"):
        hits.append(f"routing key={meta['key']}")
    if any(k.startswith("x-tt") for k in headers):
        hits.append("响应头带 x-tt-*（字节系基础设施特征）")
    if str(meta.get("id", "")).startswith("resp_"):
        hits.append("响应 id 前缀 resp_（Ark 风格，不是 chatcmpl-）")
    if "ark responses" in low or "on ark" in low:
        hits.append("错误消息点名上游：Ark（火山方舟 / BytePlus Ark）")
    if re.search(r"request id: 0217", low):
        hits.append("错误里带 0217… 格式的 Request id（字节/Ark 特征）")
    if "[code=upstream_error]" in text:
        hits.append("网关原样透传上游错误（[code=upstream_error]），可用来指纹")
    # 网关自己也会返回 invalid_request_error，这个字段单独不能当上游证据
    return hits


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="探测 Open Design API 的真实上游")
    ap.add_argument("--only", default=None, help="只跑指定名字的探测")
    args = ap.parse_args(argv)

    key, source = od_ttft.load_key(argparse.Namespace(api_key=None))
    print(f"key 来源：{source}（{key[:6]}…{len(key)} 字符）\n")

    base = {"model": MODEL,
            "messages": [{"role": "user", "content": "说一个字"}],
            "max_tokens": 16}

    probes = [
        ("baseline", True, {**base, "stream": True}),
        ("non-stream", False, base),
        ("bad-param-n", True, {**base, "n": 2, "stream": True}),
        ("bad-param-logprobs", True,
         {**base, "logprobs": True, "top_logprobs": 5, "stream": True}),
        ("too-many-tokens", True, {**base, "max_tokens": 999999, "stream": True}),
        ("bad-model", True, {**base, "model": "deepseek-v4.1-flash-nonexistent",
                             "stream": True}),
        ("bad-temperature", True, {**base, "temperature": 9, "stream": True}),
        ("image-to-text-model", True, {**base, "messages": [{"role": "user", "content": [
            {"type": "text", "text": "这是什么"},
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}]}],
            "stream": True}),
        ("empty-messages", True, {**base, "messages": [], "stream": True}),
        ("tool-bad-schema", True, {**base, "tools": [{"type": "function", "function": {
            "name": "f", "parameters": {"type": "nonsense"}}}], "stream": True}),
    ]

    all_hits: list[str] = []
    for name, stream, payload in probes:
        if args.only and name != args.only:
            continue
        print("=" * 74)
        print(f"[{name}] stream={stream}")
        try:
            status, headers, raw = call(key, payload, stream)
        except Exception as exc:                    # noqa: BLE001
            print(f"    请求异常: {type(exc).__name__}: {str(exc)[:120]}")
            continue
        print(f"    HTTP {status}")
        show_headers(headers)
        text = show_body(raw)
        meta = parse_stream_meta(raw) if status == 200 else {}
        if meta:
            print("    流元数据:", json.dumps(meta, ensure_ascii=False))
        for hit in fingerprint(headers, text, meta):
            if hit not in all_hits:
                all_hits.append(hit)
        print()

    print("=" * 74)
    print("命中线索：")
    for hit in all_hits:
        print(f"  - {hit}")
    if not all_hits:
        print("  （没有明确指向：网关可能统一了错误结构，或上游是全托管）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
