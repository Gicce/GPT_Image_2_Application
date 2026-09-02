# -*- coding: utf-8 -*-
"""V4.2.11 鸭梨山大 E2E：Image2 /v1/images/edits 传输助手（仅 E2E 测试调用）。

为什么需要它：packyapi 边缘按 TLS 指纹过滤——Node undici 的握手直接被挂起
（UND_ERR_CONNECT_TIMEOUT），生产链路用的是 Rust reqwest（Windows SChannel）
不受影响；vitest 侧改用 Python urllib 承担这一跳。协议 1:1 镜像
src-tauri/src/task_runner.rs 的 edits 请求：
  - 文本字段：model=gpt-image-2 / prompt / n=1 / size
  - 参考图部件名：image[]
  - 响应取 data[0].b64_json

凭据安全：base_url 与 token 只经环境变量（V4211_IMAGE_BASE / V4211_IMAGE_TOKEN）
传入，任务参数走 stdin；任何令牌不落盘、不打印。stdout 只输出
{"ok": true, "b64": ...} 或 {"ok": false, "error": ...}。
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BROWSER_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'
)


def candidate_routes():
    """出网路由候选（按优先级）：
    1. V4211_IMAGE_PROXY 显式指定（http://127.0.0.1:PORT）
    2. 系统/注册表代理（urllib getproxies；本机 packyapi 仅代理可达）
    3. 常见本地代理端口（Clash 7890 / 7897）
    4. 直连（多数情况下不可达，兜底）
    """
    routes = []
    explicit = os.environ.get('V4211_IMAGE_PROXY')
    if explicit:
        routes.append(explicit)
    system = urllib.request.getproxies()
    for scheme in ('https', 'http'):
        proxy = system.get(scheme)
        if proxy and proxy not in routes:
            routes.append(proxy)
    for fallback in ('http://127.0.0.1:7897', 'http://127.0.0.1:7890'):
        if fallback not in routes:
            routes.append(fallback)
    routes.append('')  # 直连
    return routes


def post_edits(base, token, body, boundary, timeout_sec):
    """逐路由尝试 edits POST。只有「连接层失败」才换路由（请求未到达服务端，
    重试不会重复生图）；服务端已应答的错误原样返回。"""
    errors = []
    for route in candidate_routes():
        handler = urllib.request.ProxyHandler({'http': route, 'https': route} if route else {})
        opener = urllib.request.build_opener(handler)
        request = urllib.request.Request(
            base + '/v1/images/edits',
            data=body,
            headers={
                'Authorization': 'Bearer ' + token,
                'User-Agent': BROWSER_UA,
                'Content-Type': 'multipart/form-data; boundary=' + boundary,
            },
            method='POST',
        )
        label = route or 'direct'
        try:
            with opener.open(request, timeout=timeout_sec) as response:
                return label, json.loads(response.read().decode('utf-8')), None
        except urllib.error.HTTPError as error:  # 服务端已应答 → 不换路由重发
            return label, None, f'HTTP {error.code}: {error.read().decode("utf-8", "ignore")[:400]}'
        except Exception as error:  # noqa: BLE001 - 连接层失败 → 换下一条路由
            errors.append(f'{label}: {type(error).__name__} {str(error)[:120]}')
    return None, None, ' | '.join(errors)


def main():
    job = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    base = (os.environ.get('V4211_IMAGE_BASE') or '').rstrip('/')
    token = os.environ.get('V4211_IMAGE_TOKEN') or ''
    if not base or not token:
        print(json.dumps({'ok': False, 'error': 'missing V4211_IMAGE_BASE / V4211_IMAGE_TOKEN'}))
        return

    boundary = uuid.uuid4().hex
    parts = []
    for key, value in (
        ('model', job.get('model') or 'gpt-image-2'),
        ('prompt', job.get('prompt') or ''),
        ('n', '1'),
        ('size', job.get('size') or '1024x1024'),
    ):
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode('utf-8')
        )
    for path in job.get('refs') or []:
        with open(path, 'rb') as handle:
            payload = handle.read()
        parts.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; '
                f'filename="{os.path.basename(path)}"\r\nContent-Type: image/png\r\n\r\n'
            ).encode('utf-8')
            + payload
            + b'\r\n'
        )
    parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
    body = b''.join(parts)

    route, result, error = post_edits(base, token, body, boundary, int(job.get('timeout_sec') or 240))
    if error:
        print(json.dumps({'ok': False, 'error': error, 'route': route}))
        return
    b64 = (result.get('data') or [{}])[0].get('b64_json')
    if not b64:
        print(json.dumps({'ok': False, 'error': '响应缺少 b64_json', 'route': route}))
        return
    print(json.dumps({'ok': True, 'b64': b64, 'route': route}))


if __name__ == '__main__':
    main()
