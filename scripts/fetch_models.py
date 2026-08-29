# -*- coding: utf-8 -*-
"""下载更强的离线解析模型 en_core_web_trf 的官方 wheel 并校验哈希。

官方 wheel 托管在 GitHub releases，境内网络不可达时自动改用 HuggingFace
镜像 hf-mirror.com。下载完成后按 requirements.txt 头部说明安装。

运行：python scripts/fetch_models.py
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
import urllib.error
import urllib.request

# en_core_web_trf 3.7.3（spaCy 官方发布，MIT 许可）。
# HF 仓库内的 wheel 内部版本号是 3.7.3，与官方 GitHub release 同一构建。
WHEEL_NAME = "en_core_web_trf-3.7.3-py3-none-any.whl"
EXPECTED_SHA256 = "f72abb34bdf174876bd4267b29b2501677e605e0a251fdc56c163003182ed68b"
EXPECTED_SIZE = 457_413_490

# 仅允许下载官方模型 wheel 的固定主机，且必须为 https。
ALLOWED_HOSTS = frozenset({"hf-mirror.com", "github.com", "objects.githubusercontent.com"})

SOURCES = (
    "https://hf-mirror.com/spacy/en_core_web_trf/resolve/main/en_core_web_trf-any-py3-none-any.whl",
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_trf-3.7.3/" + WHEEL_NAME,
)

CHUNK = 1024 * 1024


def _is_expected_url(url: str) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in ALLOWED_HOSTS


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """重定向目标必须是白名单内的 https 地址，阻断任何跳转劫持。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _is_expected_url(newurl):
            raise urllib.error.HTTPError(newurl, code, "重定向目标不在模型下载白名单内", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download(url: str, dest: Path) -> bool:
    if not _is_expected_url(url):
        print(f"  跳过非白名单地址：{url}")
        return False
    print(f"* 尝试 {url}")
    try:
        opener = urllib.request.build_opener(_SafeRedirectHandler)
        request = urllib.request.Request(url, headers={"User-Agent": "parse-spec-fetch/1.0"})
        with opener.open(request, timeout=60) as response, dest.open("wb") as output:
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                output.write(block)
    except OSError as exc:
        print(f"  失败：{type(exc).__name__}: {exc}")
        dest.unlink(missing_ok=True)
        return False
    return _verify(dest)


def _verify(dest: Path) -> bool:
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    size = dest.stat().st_size
    if digest != EXPECTED_SHA256 or size != EXPECTED_SIZE:
        print(f"  哈希/大小校验失败：sha256={digest[:16]}… size={size}")
        dest.unlink(missing_ok=True)
        return False
    print(f"  校验通过：sha256={digest[:16]}… size={size}")
    return True


def main() -> int:
    vendor = Path(__file__).resolve().parent.parent / "vendor"
    vendor.mkdir(exist_ok=True)
    dest = vendor / WHEEL_NAME
    if dest.exists() and _verify(dest):
        print("* 已存在且校验通过，跳过下载")
    else:
        for url in SOURCES:
            if _download(url, dest):
                break
        else:
            print("所有下载源均失败；可手动下载后放入 vendor/ 目录")
            return 1
    python = Path(sys.executable).name
    print("\n下载完成。接下来安装（torch 必须先于 spacy-transformers 安装，"
          "否则 PyPI 默认拉取数 GB 的 CUDA 版 torch）：\n"
          f"  uv pip install --python .venv\\Scripts\\{python} --index-url https://download.pytorch.org/whl/cpu torch --no-deps\n"
          f"  uv pip install --python .venv\\Scripts\\{python} spacy-transformers\n"
          f"  uv pip install --python .venv\\Scripts\\{python} vendor/{WHEEL_NAME}\n"
          "安装后重启 python server.py 即自动启用（日志会打印当前解析模型）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
