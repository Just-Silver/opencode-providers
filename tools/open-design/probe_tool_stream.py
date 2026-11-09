#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探测 Open Design 网关的流式工具调用分片是否可靠
=================================================================
背景：两条路由用不同的键把「分散在多个 SSE chunk 里的同一个工具调用」拼回来——

- `/v1/chat/completions`：按 `choices[].delta.tool_calls[].index`
- `/v1/responses`：按 `response.function_call_arguments.delta.item_id`

如果网关让两个不同的调用复用同一个键，客户端就会把它们拼成
`{"a":1}{"b":2}`，JSON 解析失败（opencode 报 `tool.input-json`）。

判定口径（任一命中即记为一次异常）：
  A. 同一键先后绑定两个不同的 id
  B. 同一 id 出现在两个不同的键
  C. 合并后的 arguments 不是单个合法 JSON 对象
  D. responses：delta 的 item_id 从未被 output_item.added 注册

用法：
  python probe_tool_stream.py                 # chat 与 responses 各 12 次
  python probe_tool_stream.py -n 40 -c 3      # 加大样本 / 并发
  python probe_tool_stream.py --only chat     # 只测一条路由

key 读取顺序与 od_ttft.py 相同（--api-key / OPEN_DESIGN_API_KEY / opencode auth export）。
"""
from __future__ import annotations

import argparse
import http.client
import json
import queue
import ssl
import sys
import threading

import od_ttft

HOST = "amr-link.open-design.ai"
MODEL = "deepseek-v4.1-flash"

# 两条路由的工具 schema 形状不同：chat 包一层 function，responses 是扁平结构。
TOOL_SPECS = (
    ("shell", "执行一条 PowerShell 命令",
     {"command": {"type": "string"}, "workdir": {"type": "string"}}, ["command"]),
    ("read", "读取文件",
     {"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}, ["path"]),
    ("grep", "正则搜索文件内容",
     {"pattern": {"type": "string"}, "include": {"type": "string"}}, ["pattern"]),
    ("glob", "按通配符找文件", {"pattern": {"type": "string"}}, ["pattern"]),
)

# 逼模型一次给出多个独立调用 —— 单调用请求打不出这个缺陷。
PROMPT = (
    "请并行发起 4 个独立工具调用（必须一次给出，不要合并成一条命令）：\n"
    "1) read D:\\repo\\a.axaml 前 30 行\n"
    "2) read D:\\repo\\b.axaml 前 30 行\n"
    "3) grep 'x:Key' 在 D:\\repo\n"
    "4) shell 统计 .axaml 文件数量"
)


def tools_for(route: str) -> list[dict]:
    if route == "chat":
        return [
            {"type": "function", "function": {
                "name": name, "description": desc,
                "parameters": {"type": "object", "properties": props, "required": required}}}
            for name, desc, props, required in TOOL_SPECS
        ]
    return [
        {"type": "function", "name": name, "description": desc,
         "parameters": {"type": "object", "properties": props, "required": required}}
        for name, desc, props, required in TOOL_SPECS
    ]


def payload_for(route: str) -> tuple[str, dict]:
    if route == "chat":
        return "/v1/chat/completions", {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": "You are a coding agent running in a terminal on Windows."},
                {"role": "user", "content": PROMPT},
            ],
            "tools": tools_for("chat"),
            "reasoning_effort": "high",
            "stream": True,
            "max_tokens": 900,
        }
    return "/v1/responses", {
        "model": MODEL,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "reasoning": {"effort": "high"},
        "tools": tools_for("responses"),
        "stream": True,
        "max_output_tokens": 1200,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": PROMPT}]}],
    }


def sse(resp):
    while True:
        line = resp.readline()
        if not line:
            return
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if not text.startswith("data:"):
            continue
        body = text[5:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            yield json.loads(body)
        except json.JSONDecodeError:
            continue


def request(route: str, key: str, timeout: float = 200.0):
    path, payload = payload_for(route)
    conn = http.client.HTTPSConnection(HOST, 443, timeout=timeout, context=ssl.create_default_context())
    conn.request("POST", path, json.dumps(payload).encode(), headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    })
    return conn, conn.getresponse()


def judge_chat(events) -> list[str]:
    """按 index 聚合，检查 id 复用与 arguments 合法性。"""
    args: dict[object, str] = {}
    ids: dict[object, str] = {}
    key_of_id: dict[str, object] = {}
    problems: list[str] = []
    for obj in events:
        for choice in obj.get("choices") or []:
            for call in (choice.get("delta") or {}).get("tool_calls") or []:
                index = call.get("index")
                if index is None:
                    problems.append("A. delta 缺少 index")
                    continue
                call_id = call.get("id")
                if call_id:
                    if index in ids and ids[index] != call_id:
                        problems.append(f"A. index={index} 复用两个 id：{ids[index]} -> {call_id}")
                    ids[index] = call_id
                    if call_id in key_of_id and key_of_id[call_id] != index:
                        problems.append(f"B. id={call_id} 出现在 index {key_of_id[call_id]} 与 {index}")
                    key_of_id[call_id] = index
                args[index] = args.get(index, "") + ((call.get("function") or {}).get("arguments") or "")
    for index, raw in args.items():
        try:
            json.loads(raw or "{}")
        except json.JSONDecodeError:
            problems.append(f"C. index={index} 的 arguments 不是合法 JSON（{len(raw)} 字符）：{raw[:120]!r}")
    return problems


def judge_responses(events) -> tuple[list[str], int]:
    """按 item_id 聚合；返回 (异常列表, 调用数)。"""
    args: dict[str, str] = {}
    items: set[str] = set()
    call_ids: set[str] = set()
    problems: list[str] = []
    for obj in events:
        kind = obj.get("type")
        if kind == "response.output_item.added":
            item = obj.get("item") or {}
            if item.get("type") != "function_call":
                continue
            if item.get("id") in items:
                problems.append(f"A. item_id 重复：{item.get('id')}")
            if item.get("call_id") in call_ids:
                problems.append(f"B. call_id 重复：{item.get('call_id')}")
            items.add(item.get("id"))
            call_ids.add(item.get("call_id"))
        elif kind == "response.function_call_arguments.delta":
            item_id = obj.get("item_id")
            if item_id not in items:
                problems.append(f"D. delta 的 item_id 未注册：{item_id}")
            args[item_id] = args.get(item_id, "") + (obj.get("delta") or "")
    for item_id, raw in args.items():
        try:
            json.loads(raw or "{}")
        except json.JSONDecodeError:
            problems.append(f"C. item_id={item_id} 的 arguments 不是合法 JSON：{raw[:120]!r}")
    return problems, len(items)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="探测 Open Design 流式工具调用的分片键是否可靠")
    ap.add_argument("--api-key", default=None, help="不传则读 OPEN_DESIGN_API_KEY 或 opencode auth export")
    ap.add_argument("-n", "--count", type=int, default=12, help="每条路由的请求次数（默认 12）")
    ap.add_argument("-c", "--concurrency", type=int, default=3, help="并发数（默认 3）")
    ap.add_argument("--only", choices=["chat", "responses"], default=None, help="只测一条路由")
    args = ap.parse_args(argv)

    key, source = od_ttft.load_key(args)
    print(f"key 来源：{source}（{key[:6]}…{len(key)} 字符）")

    for route in [args.only] if args.only else ["chat", "responses"]:
        tally = {"ok": 0, "bad": 0, "error": 0, "calls": 0}
        reports: queue.Queue = queue.Queue()

        def run(tag: str) -> None:
            try:
                conn, resp = request(route, key)
            except Exception as exc:                       # noqa: BLE001
                reports.put((tag, "error", f"请求异常：{type(exc).__name__}: {exc}", 0))
                return
            try:
                if resp.status != 200:
                    reports.put((tag, "error", f"HTTP {resp.status}：{resp.read(200)[:160]!r}", 0))
                    return
                events = list(sse(resp))
            finally:
                conn.close()
            if route == "chat":
                problems, calls = judge_chat(events), None
            else:
                problems, calls = judge_responses(events)
            reports.put((tag, "bad" if problems else "ok", problems, calls))

        print("\n" + "=" * 74)
        print(f"[{route}] {args.count} 次，并发 {args.concurrency}")
        pending = queue.Queue()
        for i in range(args.count):
            pending.put(f"r{i}")

        def worker() -> None:
            while True:
                try:
                    tag = pending.get_nowait()
                except queue.Empty:
                    return
                run(tag)

        threads = [threading.Thread(target=worker) for _ in range(max(1, args.concurrency))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        while not reports.empty():
            tag, status, detail, calls = reports.get()
            if status == "ok":
                tally["ok"] += 1
                if calls:
                    tally["calls"] += calls
                continue
            tally[status] += 1
            print(f"  [{tag}] {status.upper()}")
            if status == "error":
                print(f"      {detail}")
            else:
                for problem in detail:
                    print(f"      {problem}")

        print(f"  小结：正常 {tally['ok']} · 异常 {tally['bad']} · 请求失败 {tally['error']}"
              + (f" · 累计调用 {tally['calls']}" if tally["calls"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
