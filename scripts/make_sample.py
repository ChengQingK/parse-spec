# -*- coding: utf-8 -*-
"""生成一篇示例 SPEC PDF（4 页 + 目录书签），用于演示与端到端回归。

用法：python scripts/make_sample.py（在任意工作目录下运行都会写到仓库 docs/）。
"""
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas


DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "docs" / "sample_spec.pdf"

SECTIONS = [
    ("sec-overview", "Overview and Scope"),
    ("sec-command", "Command Interface Signals"),
    ("sec-write", "Write Data and Read Data Signals"),
    ("sec-lowpower", "Low Power Control and Status"),
]

PARAS = [
    "The write data, which is driven by the controller, is latched into the "
    "destination register at the rising edge of the clock.",
    "Although the transfer is initiated at the falling edge, the data is not "
    "sampled by the slave until the arbiter grants ownership of the bus to the requester.",
    "Each buffer that stores incoming data is flushed when the engine completes "
    "an operation, thereby reducing the overall latency of the pipeline.",
    "The address decoding logic, implemented within the arbiter, determines "
    "which slave owns the bus when multiple masters present conflicting requests simultaneously.",
    "Because the register file is accessed through a single read port, the "
    "controller must stall the pipeline whenever two concurrent reads target the same word.",
    "A speculative fetch improves the throughput of the processor, but the "
    "speculative results are discarded if a branch prediction is subsequently found to be incorrect.",
    "Notwithstanding the reserved field, the protocol mandates that every "
    "pending transaction be completed before the bridge is allowed to enter the low-power state.",
    "The data, whose upper and lower halves are aggregated into a single "
    "continuous burst, is transmitted across the asynchronous boundary without any additional buffering.",
]


def draw_body(c, w, h, first_page=False):
    c.setFont("Times-Roman", 10.5)
    y = h - 1.3 * inch if first_page else h - 1.9 * inch
    for p in PARAS:
        words = p.split()
        line = ""
        for wd in words:
            test = (line + " " + wd).strip()
            if c.stringWidth(test, "Times-Roman", 10.5) < (w - 2 * inch):
                line = test
            else:
                c.drawString(inch, y, line)
                y -= 0.22 * inch
                line = wd
        if line:
            c.drawString(inch, y, line)
            y -= 0.22 * inch
        y -= 0.28 * inch  # 段间距
        if y < inch:
            break


def main(path=None):
    target = Path(path) if path else DEFAULT_OUTPUT
    target.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(target), pagesize=letter)
    w, h = letter
    for index, (key, title) in enumerate(SECTIONS):
        if index == 0:
            c.setFont("Times-Roman", 12)
            c.drawString(1 * inch, h - 1 * inch, "Sample Bus Specification (excerpt for demo)")
        else:
            c.setFont("Times-Roman", 14)
            c.drawString(1 * inch, h - 1 * inch, title)
        # 目录目的地：绑定当前页（Fit 整页视图），供导航栏与 Link 注解跳转
        c.bookmarkPage(key)
        c.addOutlineEntry(title, key, level=0)
        draw_body(c, w, h, first_page=(index == 0))
        c.showPage()
    c.save()
    print("已生成:", target)


if __name__ == "__main__":
    main()
