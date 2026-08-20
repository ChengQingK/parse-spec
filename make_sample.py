# -*- coding: utf-8 -*-
"""生成一篇示例 SPEC PDF，用于演示悬浮解析。"""
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas


def main(path="docs/sample_spec.pdf"):
    c = canvas.Canvas(path, pagesize=letter)
    w, h = letter
    c.setFont("Times-Roman", 12)
    c.drawString(1 * inch, h - 1 * inch, "Sample Bus Specification (excerpt for demo)")
    c.setFont("Times-Roman", 10.5)

    paras = [
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

    y = h - 1.3 * inch
    for p in paras:
        # 简单折行
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
            c.showPage()
            c.setFont("Times-Roman", 10.5)
            y = h - 1 * inch

    c.save()
    print("已生成:", path)


if __name__ == "__main__":
    main()
