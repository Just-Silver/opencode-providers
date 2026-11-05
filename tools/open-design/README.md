<!-- 职责：说明本目录两个工具（od_ttft.py 测延迟、probe_upstream.py 探上游）的用法、指标口径与判读方法；不写 Open Design 客户端用法，不写 Clash / 代理配置。 -->

# Open Design：延迟测量与上游探测

`registry/providers/open-design` 这个供应商的运维工具：测它的延迟，并确认它背后真实的上游。
两个独立脚本，只依赖 Python 3.9+ 标准库，不属于 npm 包发布内容（`package.json` 的 `files` 白名单不含 `tools/`）。

| 文件 | 作用 |
| --- | --- |
| `od_ttft.py` | 测 Open Design API 的首字节 / 首 token 延迟，并拆成「链路」和「模型」两段 |
| `probe_upstream.py` | 判断 API 背后真实在给谁干活（流元数据 + 错误码 + 响应头） |

两个脚本都从仓库根目录运行：`python tools/open-design/od_ttft.py`。

## Key 从哪来

两个脚本共用同一套顺序：

1. `--api-key`
2. 环境变量 `OPEN_DESIGN_API_KEY`
3. `opencode auth export open-design`

也就是说，只要 OpenCode 里登录过 Open Design，就不用手动粘贴。key 只在内存里用，输出只显示前 6 位和长度。

## od_ttft.py：首 token 延迟

```bash
python od_ttft.py                          # 默认 10 次，deepseek-v4.1-flash
python od_ttft.py -n 20                    # 20 次
python od_ttft.py -c 4                     # 4 并发（看排队/限流）
python od_ttft.py --prompt-chars 12000     # 模拟长上下文（约 6k token）
python od_ttft.py --proxy http://127.0.0.1:7897   # 走代理节点（CONNECT 隧道）
python od_ttft.py --ip 162.159.129.1       # 强制连某个 IP，仍用原域名做 SNI
python od_ttft.py --json out.json          # 逐次结果 + 汇总落盘
```

`--ip` 和 `--proxy` 互斥：走代理时由代理侧解析域名，`--ip` 不生效。

### 指标口径

| 指标 | 起点 | 含义 |
| --- | --- | --- |
| 连接 | 发起连接 | TCP 握手（走代理时是「连上代理 + CONNECT 完成」） |
| TLS | 开始握手 | TLS 握手 |
| 首字节 | 请求发出 | 响应头第一个字节到达 |
| 首 token | 请求发出 | 第一个非空增量（推理模型的思考也算） |
| 正文首字 | 请求发出 | 第一个正文增量 |
| 首包→首字 | 首字节 | 响应头到首批正文的间隔（多为代理/网关缓冲） |
| 总耗时 | 发起连接 | 到流结束 |

**链路基准**：另用 `/cdn-cgi/trace` 打 3 次取中位数，这个请求不碰模型，它的首字节就是纯链路 + 边缘开销。聊天请求的首字节减掉它，剩下的估算为「模型等待」。

失败样本不计入百分位，但会单独报失败数和错误原因——成功率本身就是结论。

### 读数时注意

- **prompt 长度影响很大**：一句话的 prompt 测得首 token ~2.4s，12k 字符能到 ~3.2s，40k 字符 ~6.2s。日常体感要按问题 `--prompt-chars` 才准。
- **推理模型先流思考**：首 token 往往是思考的第一句，和「正文首字」不是一回事。
- **单次样本会骗人**：模型等待波动可达 ±1s，比较两条路线要交替发起（同一时间窗），不要前后脚各跑 10 次。

## probe_upstream.py：真实上游是谁

```bash
python probe_upstream.py                  # 跑全部探测
python probe_upstream.py --only baseline  # 只看流元数据
```

会依次发一次正常请求和 8 种异常请求：不支持的参数（`n`、`top_logprobs`）、超限 token、错误模型名、越界 temperature、图片发给纯文本模型、空 messages、非法 tool schema。每次打印状态码、关键响应头、正文片段，最后汇总命中的线索。

### 判读方法（按可靠度排序）

| 线索 | 怎么看 |
| --- | --- |
| 流元数据 | 每个 chunk 的 `extra_fields.routing_info`：`provider` / `key` / `resolved_model_used`，网关自己写的 |
| 错误消息 | 上游报错若被原样透传，会带供应商特有的措辞和字段 |
| 请求 id 格式 | 报错里的 `Request id:`、响应 `id` 前缀能区分厂商 |
| 响应头 | `x-tt-*` 之类的厂商头（很多网关会剥掉） |
| usage 结构 | 例如 `completion_tokens_details.reasoning_tokens` |

注意：网关自己返回的 `invalid_request_error` **不能**当上游证据，它也会这么回。

### 2026-11-05 实测结论

当前上游是**火山方舟海外版（BytePlus Ark）**，不是 DeepSeek 官方：

| 线索 | 证据 |
| --- | --- |
| 流元数据 | `provider=custom_provider_byteplus`、`key=byteplus` |
| 错误明文 | `top_logprobs is unsupported on Ark Responses` |
| 错误透传 | `[code=upstream_error] ... Request id: 0217938676516305...` |
| 响应 id | `resp_02...`（Ark 风格，不是 `chatcmpl-`） |
| 模型名 | `deepseek-v4-1-flash-261017`，`-261017` 是 Ark 的版本/部署号 |

以后判断有没有换供应商，盯 `routing_info.provider` 和响应 `id` 前缀即可。

## 本机基线（2026-11-05）

- `amr-link.open-design.ai` 直连落 Cloudflare **AMS**（阿姆斯特丹），连接 ~260ms
- 短 prompt 首 token p50 ~2.2~3.1s（随模型侧波动），其中链路约 1.2s
- 12k 字符上下文首 token p50 ~3.2s（走香港）/~4.4s（直连）
- 链路与模型各占一半左右：换路线能省 1s 量级，剩下的是上游出首 token 的时间
