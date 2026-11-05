#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Open Design 首 token 延迟（TTFT）测试
==============================================================
只测「从发出请求到看到第一个 token」这段，不做端到端跑分。

为什么要拆成这几段：
  连接      TCP 握手，受线路/机房影响（CF anycast 可能甩到 LAX）
  TLS       握手，证书链越长越慢，会话复用后应接近 0
  首字节    请求发出 -> 响应头第一个字节到达（含上游排队 + 首包）
  首 token  请求发出 -> 第一个正文增量（用户真正「看到字」的时刻）
  总耗时    请求发出 -> 流结束

关键点是首 token 与首字节的差值：那一段是模型上游的耗时，
跟机房、TLS、客户端都无关。只报总耗时会把它和链路问题混在一起。

Key 默认从 `opencode auth export open-design` 读取（OpenCode 里登录过 Open Design
就不用手动粘贴）。也可以用 --api-key 或环境变量 OPEN_DESIGN_API_KEY 覆盖。

用法：
  python od_ttft.py                     # 默认 10 次，deepseek-v4.1-flash
  python od_ttft.py -n 20 -c 4          # 20 次，4 并发
  python od_ttft.py --ip 162.159.129.1  # 强制走某个 IP，对比优选效果
  python od_ttft.py --proxy http://127.0.0.1:7897   # 走代理节点测
  python od_ttft.py --prompt-chars 12000            # 模拟长上下文
  python od_ttft.py --model glm-5.3-flash
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter

DEFAULT_BASE_URL = "https://amr-link.open-design.ai/v1"
DEFAULT_INTEGRATION = "open-design"
DEFAULT_ENV = "OPEN_DESIGN_API_KEY"
DEFAULT_MODEL = "deepseek-v4.1-flash"
DEFAULT_PROMPT = "用一句话解释什么是响应式设计。"
DEFAULT_TIMEOUT = 40.0


class StreamError(Exception):
    pass


class _Closed(StreamError):
    pass


def parse_proxy(value: str | None) -> tuple[str, int] | None:
    if not value:
        return None
    text = value.strip()
    for prefix in ("http://", "https://"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    text = text.rstrip("/")
    host, _, port = text.partition(":")
    if not port:
        raise SystemExit(f"[X] --proxy 需要 host:port 形式，收到 {value}")
    return host, int(port)


def _dial(host: str, port: int, timeout: float,
          proxy: tuple[str, int] | None) -> tuple[socket.socket, float, float]:
    """建立到 host:port 的连接；走代理时用 HTTP CONNECT 隧道。

    返回 (socket, 连接耗时, 隧道耗时)。走代理时连接耗时是「连上代理 + CONNECT
    完成」的合计——那才是用户感知的「到目标站点的可达时间」。
    """
    t0 = perf_counter()
    if proxy is None:
        sock = socket.create_connection((host, port), timeout=timeout)
        return sock, (perf_counter() - t0) * 1000, 0.0

    phost, pport = proxy
    sock = socket.create_connection((phost, pport), timeout=timeout)
    t1 = perf_counter()
    target = f"{host}:{port}"
    sock.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            sock.close()
            raise StreamError("代理在 CONNECT 阶段断开")
        buf += chunk
        if len(buf) > 8192:
            sock.close()
            raise StreamError("代理 CONNECT 响应异常")
    status = buf.split(b"\r\n", 1)[0].decode("latin-1")
    if " 200 " not in status:
        sock.close()
        raise StreamError(f"代理拒绝 CONNECT: {status[:60]}")
    return sock, (t1 - t0) * 1000, (perf_counter() - t1) * 1000


# ----------------------------------------------------------------- key
def key_from_opencode(integration: str) -> tuple[str, str]:
    """跑 `opencode auth export <id>` 拿 key。返回 (key, 来源描述)。

    不能直接用 subprocess 调 powershell 脚本本身（Windows 上 npm 落地的是
    .ps1，subprocess 不认这个扩展名），所以统一过一层 PowerShell。
    """
    cmd = (["powershell", "-NoProfile", "-NonInteractive", "-Command",
            f"opencode auth export {integration}"] if os.name == "nt"
           else ["opencode", "auth", "export", integration])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=40, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise SystemExit("[X] 找不到 opencode CLI；请用 --api-key 或环境变量传入 key。")
    if proc.returncode != 0:
        raise SystemExit(f"[X] opencode auth export 失败（退出码 {proc.returncode}）："
                         f"{(proc.stderr or proc.stdout).strip()[:200]}")

    text = proc.stdout
    start = text.find("[")
    if start < 0:
        raise SystemExit("[X] opencode auth export 没有返回 JSON。")
    try:
        entries = json.loads(text[start:])
    except json.JSONDecodeError:
        raise SystemExit("[X] 解析 opencode auth export 的 JSON 失败。")

    for e in entries:
        if e.get("integrationID") == integration or e.get("label") == integration:
            value = e.get("value") or {}
            key = value.get("key")
            if key:
                return key, f"opencode auth（集成 {integration}）"
    raise SystemExit(f"[X] opencode 里没有 {integration} 的可用凭据，"
                     f"先执行 opencode auth login {integration}。")


def load_key(args) -> tuple[str, str]:
    if args.api_key:
        return args.api_key, "--api-key"
    if os.environ.get(DEFAULT_ENV):
        return os.environ[DEFAULT_ENV], f"环境变量 {DEFAULT_ENV}"
    return key_from_opencode(DEFAULT_INTEGRATION)


def build_prompt(base: str, chars: int) -> str:
    """把 prompt 撑到约 chars 个字符，模拟真实请求里的 Skill / Design System 上下文。

    首 token 延迟里有相当一部分是 prefill：prompt 越长，模型开始出字越晚。
    用一句话的 prompt 测出来的 TTFT 只代表「空上下文」，不能当日常体感。
    """
    if chars <= 0 or len(base) >= chars:
        return base
    filler = "这是一段用于测试预填充延迟的填充文本，不代表任何真实内容。"
    need = chars - len(base) - 1
    repeat = need // len(filler) + 1
    return base + "\n" + (filler * repeat)[:need]


# ----------------------------------------------------------------- 统计
def percentile(vals: list[float], q: float) -> float:
    """线性插值百分位（与 numpy 默认口径一致）。输入必须已排序。"""
    if not vals:
        return 0.0
    if len(vals) == 1:
        return vals[0]
    pos = (len(vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)


# ----------------------------------------------------------------- HTTP
class _Reader:
    """在 TLS socket 上做最小可行的 HTTP/1.1 读取，并记录首字节时刻。"""

    def __init__(self, sock, timeout):
        self.sock = sock
        self.timeout = timeout
        self.buf = b""
        self.t_first_byte = None

    def _fill(self):
        data = self.sock.recv(65536)
        if not data:
            return False
        if self.t_first_byte is None:
            self.t_first_byte = perf_counter()
        self.buf += data
        return True

    def read_line(self) -> bytes:
        while b"\n" not in self.buf:
            if not self._fill():
                raise _Closed("响应提前结束")
        line, self.buf = self.buf.split(b"\n", 1)
        return line.rstrip(b"\r")

    def read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            if not self._fill():
                raise _Closed("响应提前结束")
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read_headers(self) -> tuple[int, dict[str, str]]:
        status_line = self.read_line().decode("latin-1")
        parts = status_line.split(" ", 2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/"):
            raise StreamError(f"非 HTTP 响应: {status_line[:60]}")
        status = int(parts[1])
        headers: dict[str, str] = {}
        while True:
            line = self.read_line()
            if not line:
                break
            name, _, value = line.decode("latin-1").partition(":")
            headers[name.strip().lower()] = value.strip()
        return status, headers

    def iter_body(self, headers: dict[str, str]):
        if headers.get("transfer-encoding", "").lower() == "chunked":
            while True:
                size_line = self.read_line()
                if not size_line:
                    continue
                size = int(size_line.split(b";")[0], 16)
                if size == 0:
                    while True:                     # 吃掉 trailer，直到空行
                        if not self.read_line():
                            return
                    return
                yield self.read_exact(size)
                self.read_line()
            return

        length = headers.get("content-length")
        if length is not None:
            remaining = int(length)
            while remaining > 0:
                if not self.buf and not self._fill():
                    return
                take = self.buf if remaining is None else self.buf[:remaining]
                self.buf = self.buf[len(take):]
                remaining -= len(take)
                yield take
            return

        while True:                                 # 既没有 chunked 也没有长度：读到 EOF
            if not self.buf and not self._fill():
                return
            out, self.buf = self.buf, b""
            yield out


def _parse_sse(event: bytes) -> tuple[bool, str, str, dict]:
    """返回 (是否结束, 正文增量, 思考增量, 路由信息)。"""
    text = event.decode("utf-8", "replace")
    done = False
    content = []
    reasoning = []
    route: dict = {}
    for line in text.split("\n"):
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if raw == "[DONE]":
            done = True
            continue
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        for choice in obj.get("choices") or []:
            delta = choice.get("delta") or choice.get("message") or {}
            if isinstance(delta.get("content"), str):
                content.append(delta["content"])
            if isinstance(delta.get("reasoning_content"), str):
                reasoning.append(delta["reasoning_content"])
            elif isinstance(delta.get("reasoning"), str):
                reasoning.append(delta["reasoning"])
        extra = obj.get("extra_fields") or {}
        routing = extra.get("routing_info") or {}
        if routing.get("provider") or extra.get("resolved_model_used"):
            route = {"provider": routing.get("provider") or extra.get("provider"),
                     "key": routing.get("key"),
                     "resolved_model": extra.get("resolved_model_used")}
    return done, "".join(content), "".join(reasoning), route


def run_once(host: str, ip: str, path: str, headers: list[tuple[str, str]],
             body: bytes, timeout: float,
             proxy: tuple[str, int] | None = None) -> dict:
    rec = {
        "connect_ms": None, "tls_ms": None, "tunnel_ms": None,
        "first_byte_ms": None, "first_token_ms": None,
        "first_reasoning_ms": None, "first_content_ms": None,
        "total_ms": None, "chunks": 0, "chars": 0, "reasoning_chars": 0,
        "status": None, "route": None, "error": None,
    }
    sock = None
    t_start = perf_counter()
    try:
        target = host if proxy else ip
        raw, conn_ms, tunnel_ms = _dial(target, 443, min(timeout, 20.0), proxy)
        rec["connect_ms"] = round(conn_ms, 1)
        rec["tunnel_ms"] = round(tunnel_ms, 1)

        ctx = ssl.create_default_context()
        t_before_tls = perf_counter()
        sock = ctx.wrap_socket(raw, server_hostname=host)
        rec["tls_ms"] = round((perf_counter() - t_before_tls) * 1000, 1)
        sock.settimeout(timeout)

        head = [f"{'POST'} {path} HTTP/1.1", f"Host: {host}"]
        head += [f"{k}: {v}" for k, v in headers]
        head.append(f"Content-Length: {len(body)}")
        head += ["Accept-Encoding: identity", "Connection: close", "", ""]
        t_send = perf_counter()
        sock.sendall("\r\n".join(head).encode("latin-1") + body)

        rd = _Reader(sock, timeout)
        status, resp_headers = rd.read_headers()
        rec["status"] = status
        if rd.t_first_byte is None:
            raise StreamError("没有收到任何响应字节")
        rec["first_byte_ms"] = round((rd.t_first_byte - t_send) * 1000, 1)

        if status != 200:
            snippet = b""
            try:
                for piece in rd.iter_body(resp_headers):
                    snippet += piece
                    if len(snippet) > 300:
                        break
            except StreamError:
                pass
            raise StreamError(f"HTTP {status}: {snippet.decode('utf-8', 'replace')[:200]}")

        buf = b""
        done = False
        for piece in rd.iter_body(resp_headers):
            buf += piece
            while True:
                idx = buf.find(b"\n\n")
                if idx < 0:
                    # 兼容 CRLF 分隔的事件
                    idx = buf.find(b"\r\n\r\n")
                    if idx < 0:
                        break
                    event, buf = buf[:idx], buf[idx + 4:]
                else:
                    event, buf = buf[:idx], buf[idx + 2:]
                event = event.replace(b"\r\n", b"\n")
                if not event.strip():
                    continue
                finished, content, reasoning, route = _parse_sse(event)
                if route and not rec.get("route"):
                    rec["route"] = route
                now = perf_counter()
                if reasoning:
                    if rec["first_reasoning_ms"] is None:
                        rec["first_reasoning_ms"] = round((now - t_send) * 1000, 1)
                    rec["reasoning_chars"] += len(reasoning)
                if content:
                    if rec["first_content_ms"] is None:
                        rec["first_content_ms"] = round((now - t_send) * 1000, 1)
                    if rec["first_token_ms"] is None:
                        rec["first_token_ms"] = round((now - t_send) * 1000, 1)
                    rec["chunks"] += 1
                    rec["chars"] += len(content)
                if finished:
                    done = True
                    break
            if done:
                break

        rec["total_ms"] = round((perf_counter() - t_start) * 1000, 1)
        # 推理模型可能把 max_tokens 全用在思考上、正文一个字都没出。
        # 这时「第一个 token」就是思考增量，不能当成失败——用户已经在屏幕上
        # 看到字了，只是还没看到答案。
        if rec["first_token_ms"] is None and rec["first_reasoning_ms"] is not None:
            rec["first_token_ms"] = rec["first_reasoning_ms"]
        if rec["first_token_ms"] is None:
            raise StreamError("流结束了但没收到任何增量（检查 model/max_tokens）")
    except Exception as exc:                        # noqa: BLE001
        rec["error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        rec["total_ms"] = rec["total_ms"] or round((perf_counter() - t_start) * 1000, 1)
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
    return rec


# ----------------------------------------------------------------- 环境探测
def resolve_host(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return []
    return sorted({ai[4][0] for ai in infos})


def _median(vals: list[float]) -> float:
    vals = sorted(vals)
    n = len(vals)
    if not n:
        return 0.0
    mid = n // 2
    return vals[mid] if n % 2 else (vals[mid - 1] + vals[mid]) / 2


def probe_colo(host: str, ip: str, samples: int = 3,
               timeout: float = 8.0,
               proxy: tuple[str, int] | None = None) -> dict:
    """走 /cdn-cgi/trace 拿真实落地机房，同时量链路三段耗时。

    这个请求不碰模型，所以它的首字节纯粹是链路 + 边缘的开销。
    拿它当基准，聊天请求的首字节里多出来的部分才是模型在等。

    取多次的中位数：单次 trace 的首字节实测能从 300ms 跳到 1.3s，
    用一次样本会把「链路基准」估得偏高，进而把模型等待算少。
    """
    ctx = ssl.create_default_context()
    conns, tlss, edges = [], [], []
    info: dict = {}
    for _ in range(max(1, samples)):
        t0 = perf_counter()
        try:
            target = host if proxy else ip
            raw, conn_ms, _ = _dial(target, 443, timeout, proxy)
            conns.append(conn_ms)
            t_tls = perf_counter()
            with ctx.wrap_socket(raw, server_hostname=host) as s:
                tlss.append((perf_counter() - t_tls) * 1000)
                s.settimeout(timeout)
                t_send = perf_counter()
                s.sendall((f"GET /cdn-cgi/trace HTTP/1.1\r\nHost: {host}\r\n"
                           "User-Agent: od-ttft\r\nConnection: close\r\n\r\n").encode())
                data = b""
                first = None
                while len(data) < 4096:
                    piece = s.recv(1024)
                    if not piece:
                        break
                    if first is None:
                        first = (perf_counter() - t_send) * 1000
                    data += piece
                if first is not None:
                    edges.append(first)
        except Exception:                           # noqa: BLE001
            continue
        for line in data.decode("utf-8", "replace").splitlines():
            if "=" not in line or line.startswith("HTTP"):
                continue
            name, _, value = line.partition("=")
            if name.isidentifier():
                info.setdefault(name, value.strip())
    if conns:
        info["conn_ms"] = round(_median(conns), 1)
    if tlss:
        info["tls_ms"] = round(_median(tlss), 1)
    if edges:
        info["edge_ms"] = round(_median(edges), 1)
    return info




# ----------------------------------------------------------------- 展示
def fmt(v) -> str:
    return "—" if v is None else f"{v:.0f}"


def _disp_len(text: str) -> int:
    """终端显示宽度：CJK 算 2 格，其余 1 格。"""
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in text)


def _cell(text: str, width: int, left: bool = False) -> str:
    pad = " " * max(0, width - _disp_len(text))
    return text + pad if left else pad + text


def print_table(runs: list[dict]) -> None:
    widths = (3, 7, 7, 9, 11, 11, 11, 10, 7)
    head = ["#", "连接", "TLS", "首字节", "首token", "正文首字",
            "首包→首字", "总耗时", "字数"]
    print("\n  " + " ".join(_cell(h, w) for h, w in zip(head, widths)) + "  状态")
    print("  " + "-" * 100)
    for i, r in enumerate(runs, 1):
        if r["error"]:
            cells = [_cell(str(i), widths[0])] + [""] * 6
            cells.append(_cell(fmt(r["total_ms"]), widths[7]))
            cells.append(_cell("", widths[8]))
            print("  " + " ".join(cells) + f"  ✗ {r['error'][:40]}")
            continue
        upstream = None
        if r["first_token_ms"] is not None and r["first_byte_ms"] is not None:
            upstream = r["first_token_ms"] - r["first_byte_ms"]
        note = f" (思考 {r['reasoning_chars']} 字)" if r["reasoning_chars"] else ""
        cells = [_cell(str(i), widths[0]),
                 _cell(fmt(r["connect_ms"]), widths[1]),
                 _cell(fmt(r["tls_ms"]), widths[2]),
                 _cell(fmt(r["first_byte_ms"]), widths[3]),
                 _cell(fmt(r["first_token_ms"]), widths[4]),
                 _cell(fmt(r["first_content_ms"]), widths[5]),
                 _cell(fmt(upstream), widths[6]),
                 _cell(fmt(r["total_ms"]), widths[7]),
                 _cell(str(r["chars"]), widths[8])]
        print("  " + " ".join(cells) + f"  ok{note}")


def summarize(runs: list[dict]) -> dict:
    ok = [r for r in runs if not r["error"]]
    summary = {
        "runs": len(runs),
        "ok": len(ok),
        "failed": len(runs) - len(ok),
        "success_rate": round(100.0 * len(ok) / len(runs), 1) if runs else 0.0,
        "errors": [r["error"] for r in runs if r["error"]][:5],
        "p50": {}, "p90": {}, "p95": {}, "max": {},
    }
    for field in ("connect_ms", "tls_ms", "first_byte_ms", "first_token_ms",
                  "first_content_ms", "total_ms"):
        vals = sorted(r[field] for r in ok if r[field] is not None)
        if vals:
            summary["p50"][field] = round(percentile(vals, 0.50), 1)
            summary["p90"][field] = round(percentile(vals, 0.90), 1)
            summary["p95"][field] = round(percentile(vals, 0.95), 1)
            summary["max"][field] = round(vals[-1], 1)

    waits = sorted(r["first_token_ms"] - r["first_byte_ms"] for r in ok
                   if r["first_token_ms"] is not None and r["first_byte_ms"] is not None)
    if waits:
        summary["p50"]["upstream_wait_ms"] = round(percentile(waits, 0.50), 1)
        summary["p95"]["upstream_wait_ms"] = round(percentile(waits, 0.95), 1)
    return summary


def print_summary(summary: dict, edge_ms: float | None = None) -> None:
    print("\n" + "=" * 70)
    print("  汇总")
    print("=" * 70)
    print(f"  成功 {summary['ok']}/{summary['runs']}"
          f"（{summary['success_rate']}%），失败 {summary['failed']}")
    if summary["errors"]:
        for err in summary["errors"]:
            print(f"    ✗ {err}")

    rows = [("连接", "connect_ms"), ("TLS", "tls_ms"),
            ("首字节", "first_byte_ms"), ("首token", "first_token_ms"),
            ("正文首字", "first_content_ms"),
            ("首包→首字", "upstream_wait_ms"), ("总耗时", "total_ms")]
    print(f"\n  {'指标':<8}  {'p50':>9}{'p90':>9}{'p95':>9}{'max':>9}")
    print("  " + "-" * 46)
    for label, field in rows:
        p50 = summary["p50"].get(field)
        if p50 is None:
            continue
        p90 = summary["p90"].get(field) or p50
        p95 = summary["p95"].get(field) or p50
        mx = summary["max"].get(field) or p95
        print(f"  {_cell(label, 8, left=True)}  {p50:>7.0f}ms{p90:>7.0f}ms"
              f"{p95:>7.0f}ms{mx:>7.0f}ms")

    ttft = summary["p50"].get("first_token_ms")
    if ttft and edge_ms is None:
        print(f"\n  首 token p50 {ttft:.0f}ms（未测链路基准，无法拆分链路/模型）。")
    elif ttft:
        conn = summary["p50"].get("connect_ms") or 0.0
        tls = summary["p50"].get("tls_ms") or 0.0
        first_byte = summary["p50"].get("first_byte_ms") or 0.0
        delta = summary["p50"].get("upstream_wait_ms") or 0.0
        link = conn + tls + edge_ms
        model = max(0.0, first_byte - edge_ms)
        print(f"\n  首 token 的构成（p50，合计约 {ttft:.0f}ms）：")
        print(f"    连接 {conn:.0f} + TLS {tls:.0f} + 边缘首字节 "
              f"{edge_ms:.0f} + 模型等待(估) {model:.0f} + 首包→首字 {delta:.0f}")
        if link + model > 0:
            print(f"    链路 {link:.0f}ms 占 {100.0 * link / ttft:.0f}%"
                  f"，模型 {model:.0f}ms 占 {100.0 * model / ttft:.0f}%")
        print("  链路占比高 -> 换机房/优选 IP 能救；模型占比高 -> 只能换模型或降负载。")



# ----------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="测 Open Design API 的首字节 / 首 token 延迟",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("-n", "--runs", type=int, default=10, help="请求次数")
    ap.add_argument("-c", "--concurrency", type=int, default=1, help="并发数")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--prompt-chars", type=int, default=0,
                    help="把 prompt 填充到约 N 个字符，模拟真实的长上下文（Skill/Design System）")
    ap.add_argument("--max-tokens", type=int, default=256)
    ap.add_argument("--temperature", type=float, default=None)
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                    help="单次请求的读超时（秒）")
    ap.add_argument("--interval", type=float, default=0.3,
                    help="两次请求之间的间隔（秒），并发时忽略")
    ap.add_argument("--baseline", type=int, default=3,
                    help="链路基准（/cdn-cgi/trace）采样次数，0 表示不测")
    ap.add_argument("--warmup", type=int, default=1, help="预热次数（不计入统计）")
    ap.add_argument("--header", action="append", default=[], metavar="NAME:VALUE",
                    help="额外请求头，可重复")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL,
                    help=f"API 根地址（默认 {DEFAULT_BASE_URL}）")
    ap.add_argument("--api-key", default=None, help="直接给 key，跳过 opencode")
    ap.add_argument("--ip", default=None,
                    help="强制连接某个 IP（仍用原域名做 SNI/Host），"
                         "用来对比优选 IP 的效果，跳过 DNS 结果")
    ap.add_argument("--proxy", default=None,
                    help="走 HTTP 代理（如 http://127.0.0.1:7897），"
                         "用 CONNECT 隧道测「经代理节点」这条链路")
    ap.add_argument("--json", dest="json_path", default=None,
                    help="把逐次结果与汇总写到 JSON")
    args = ap.parse_args(argv)

    if args.runs < 1:
        ap.error("--runs 至少为 1")

    base_url = args.base_url.rstrip("/")
    host = base_url.split("://", 1)[-1].split("/", 1)[0]
    path = "/" + base_url.split("://", 1)[-1].split("/", 1)[1] + "/chat/completions"
    key, key_source = load_key(args)

    ips = resolve_host(host)
    if not ips:
        print(f"[X] DNS 解析失败：{host}")
        return 2
    target_ip = args.ip or ips[0]
    proxy = parse_proxy(args.proxy)
    if proxy and args.ip:
        print("[!] --proxy 与 --ip 同时给出时，--ip 不生效（隧道由代理侧解析域名）。")

    colo = probe_colo(host, target_ip, samples=max(0, args.baseline),
                      proxy=proxy) if args.baseline else {}
    print("=" * 70)
    print("  首 token 延迟测试")
    print("=" * 70)
    print(f"  端点    {base_url}")
    print(f"  模型    {args.model}")
    print(f"  解析    {host} -> {', '.join(ips)}")
    if proxy:
        print(f"  连接    经代理 {proxy[0]}:{proxy[1]}（CONNECT 隧道）")
    else:
        print(f"  连接    {target_ip}"
              f"{'（--ip 强制）' if args.ip else '（DNS 首选）'}")
    if colo:
        print(f"  机房    {colo.get('colo', '?')}（{colo.get('loc', '?')}）"
              f"，TLS {colo.get('tls', '?')}")
        if colo.get("edge_ms") is not None:
            print(f"  链路    连接 {colo.get('conn_ms', 0):.0f}ms · "
                  f"TLS {colo.get('tls_ms', 0):.0f}ms · "
                  f"边缘首字节 {colo['edge_ms']:.0f}ms（/cdn-cgi/trace，不碰模型）")
    print(f"  Key     {key_source}（{key[:6]}…{len(key)} 字符）")
    print(f"  次数    {args.runs} 次，并发 {args.concurrency}，"
          f"预热 {args.warmup} 次，超时 {args.timeout:g}s，"
          f"链路基准 {args.baseline} 次")

    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": build_prompt(args.prompt, args.prompt_chars)}],
        "stream": True,
        "max_tokens": args.max_tokens,
    }
    if args.temperature is not None:
        payload["temperature"] = args.temperature
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = [("Authorization", f"Bearer {key}"),
               ("Content-Type", "application/json"),
               ("Accept", "text/event-stream")]
    for item in args.header:
        name, _, value = item.partition(":")
        if name.strip():
            headers.append((name.strip(), value.strip()))

    def once() -> dict:
        return run_once(host, target_ip, path, headers, body, args.timeout,
                        proxy=proxy)

    warm_route = None
    for _ in range(max(0, args.warmup)):
        warm = once()
        warm_route = warm_route or warm.get("route")
        if warm["error"]:
            print(f"  [预热失败] {warm['error']}")
            break
    if warm_route:
        print(f"  路由    {warm_route.get('provider') or '?'}"
              f" · {warm_route.get('resolved_model') or args.model}")

    t0 = perf_counter()
    if args.concurrency > 1:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            runs = list(pool.map(lambda _: once(), range(args.runs)))
    else:
        runs = []
        for i in range(args.runs):
            if i:
                time.sleep(args.interval)
            runs.append(once())
    elapsed = perf_counter() - t0

    print_table(runs)
    summary = summarize(runs)
    print_summary(summary, colo.get("edge_ms"))
    print(f"\n  墙钟耗时 {elapsed:.1f}s")

    if args.json_path:
        out = {"meta": {"base_url": base_url, "host": host, "ips": ips,
                        "ip": target_ip,
                        "proxy": f"{proxy[0]}:{proxy[1]}" if proxy else None,
                        "integration": DEFAULT_INTEGRATION, "model": args.model,
                        "prompt": args.prompt, "max_tokens": args.max_tokens,
                        "runs": args.runs, "concurrency": args.concurrency,
                        "colo": colo.get("colo"), "key_source": key_source,
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z")},
               "runs": runs, "summary": summary}
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
        print(f"  结果已写入 {args.json_path}")

    if summary["ok"] == 0:
        return 2
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
