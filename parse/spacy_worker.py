# -*- coding: utf-8 -*-
"""把 spaCy 解析放入独立工作进程，并提供超时降级。

默认关闭；`python server.py` 启动时调用 enable_isolation() 打开（可用环境变量
PARSE_SPEC_PARSE_TIMEOUT 调整超时秒数）。开启后 /api/analyze 的解析在持久
子进程中执行：单个超长句不再占用 Flask 工作线程，超时或工作进程异常时自动
降级到规则引擎，并在 warnings 中向用户说明原因。

协议：父进程发送句子文本；子进程回复 ("ok", ParsedSentence) 或
("error", 说明)。子进程内的解析异常不结束子进程，真正的崩溃（管道断开）
由父进程重建工作进程。
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import threading

LOGGER = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 10.0
_TIMEOUT_ENV = "PARSE_SPEC_PARSE_TIMEOUT"

_enabled = False
_timeout_seconds = DEFAULT_TIMEOUT_SECONDS
_process = None
_connection = None
_lock = threading.Lock()


def _configured_timeout() -> float:
    raw = os.environ.get(_TIMEOUT_ENV, "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def enable_isolation(timeout_seconds: float | None = None) -> None:
    """开启隔离解析；仅在 `python server.py` 直接运行时由服务端调用。"""
    global _enabled, _timeout_seconds
    _timeout_seconds = float(timeout_seconds) if timeout_seconds else _configured_timeout()
    _enabled = True


def disable_isolation() -> None:
    """关闭隔离解析并回收工作进程（测试与显式关闭使用）。"""
    global _enabled
    _enabled = False
    with _lock:
        _kill_worker()


def isolation_enabled() -> bool:
    return _enabled


def _worker_main(connection) -> None:
    """工作进程主循环：顺序处理解析请求，直到管道关闭。"""
    while True:
        try:
            text = connection.recv()
        except (EOFError, OSError):
            return
        if text is None:
            return
        try:
            from .clauser import parse_sentence

            connection.send(("ok", parse_sentence(str(text))))
        except Exception as exc:  # 解析异常由父进程降级；子进程必须继续存活
            connection.send(("error", f"{type(exc).__name__}: {exc}"))


def _ensure_worker() -> None:
    global _process, _connection
    if _process is not None and _process.is_alive() and _connection is not None:
        return
    if _process is not None or _connection is not None:
        _kill_worker()
    context = multiprocessing.get_context("spawn")
    parent_connection, child_connection = context.Pipe()
    _process = context.Process(target=_worker_main, args=(child_connection,), daemon=True)
    _process.start()
    _connection = parent_connection
    child_connection.close()  # 子进程端由子进程持有，父进程及时释放


def _kill_worker() -> None:
    global _process, _connection
    process, connection = _process, _connection
    _process = None
    _connection = None
    if connection is not None:
        try:
            connection.close()
        except OSError:
            pass
    if process is not None:
        try:
            if process.is_alive():
                process.terminate()
            process.join(timeout=2)
            process.close()
        except (OSError, ValueError):
            pass


def _parse_locked(text: str):
    try:
        _ensure_worker()
        _connection.send(text)
    except (OSError, ValueError):
        _kill_worker()
        return None
    if not _connection.poll(_timeout_seconds):
        LOGGER.warning("隔离解析超时（%.1f 秒），已终止工作进程并降级", _timeout_seconds)
        _kill_worker()
        return None
    try:
        kind, payload = _connection.recv()
    except (EOFError, OSError):
        _kill_worker()
        return None
    if kind == "ok":
        return payload
    LOGGER.warning("隔离解析失败：%s", payload)
    return None


def parse_isolated(text: str):
    """在隔离工作进程中解析；超时或异常返回 None，由调用方降级。"""
    with _lock:
        return _parse_locked(text)


def parse_isolated_or_direct(text: str):
    """隔离开启时走工作进程（超时降级到规则引擎），否则直接同步解析。"""
    from .clauser import fallback_parse, parse_sentence

    if not _enabled:
        return parse_sentence(text)
    result = parse_isolated(text)
    if result is not None:
        return result
    return fallback_parse(text, "隔离解析超时或工作进程不可用，已使用规则降级解析")
