# -*- coding: utf-8 -*-
"""内置技术词典与用户词典覆盖。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
import re


LOGGER = logging.getLogger(__name__)


# 每行：英文词条<TAB>词性<TAB>中文释义<TAB>说明。
_DATA = """
latency\tn.\t延迟\t从请求发出到响应完成的时延
throughput\tn.\t吞吐量\t单位时间内处理的数据量
bandwidth\tn.\t带宽\t单位时间内可传输的数据量
register\tn.\t寄存器\tCPU/控制器内的存储单元
buffer\tn./v.\t缓冲区；缓冲\t暂存数据的存储区域
flush\tv.\t冲刷/清空\t把缓冲区数据写走并清空
arbiter\tn.\t仲裁器\t决定总线/资源访问优先权的部件
arbitration\tn.\t仲裁\t解决多个请求者对共享资源的竞争
interrupt\tn./v.\t中断\t打断CPU当前执行以处理更高优先级事件
interrupting\tadj.\t中断(的)\t打断当前执行的
speculative\tadj.\t推测性的\t在未确认前预执行，结果可能被回滚
speculation\tn.\t推测\t预执行并可能丢弃结果
pipeline\tn.\t流水线\t将指令处理分阶段流水执行
dma\tn.\t直接存储器访问\tDMA，不经CPU直接搬运数据
controller\tn.\t控制器\t控制总线、外设或存储的部件
peripheral\tn.\t外设\tCPU外的输入输出或存储设备
fifo\tn.\t先进先出队列\tFirst-In First-Out 队列
synchronous\tadj.\t同步的\t由同一时钟或时序触发
asynchronous\tadj.\t异步的\t不与统一时钟同步，各自独立时序
aggregate\tv./n.\t聚合；汇总\t把多路数据合并为单一流或结果
arbitrate\tv.\t仲裁\t裁定访问优先权
collapse\tv.\t合并/塌缩\t多个事件合并为一个
stall\tv./n.\t停顿\t流水线暂停以等待数据或资源
bubble\tn.\t(流水线)气泡\t流水线中的空档或停顿周期
fetch\tv.\t取(指令/数据)\t从内存读取到CPU
decode\tv.\t译码/解码\t把指令或编码转成可执行形式
execute\tv.\t执行\t运行指令
writeback\tn.\t写回\t把执行结果写回寄存器或内存
hazard\tn.\t冒险/冲突\t流水线中因依赖导致的危险情形
dependency\tn.\t依赖\t两个指令或操作之间的数据或控制依赖
priority\tn.\t优先级\t更高优先级的请求先被服务
preempt\tv.\t抢占\t暂停低优先级任务以服务高优先级任务
transaction\tn.\t事务/传输\t一次完整的总线读写操作
invalidate\tv.\t使失效\t标记缓存行或数据为无效
evict\tv.\t驱逐/替换\t从缓存中移除旧行以腾出空间
coherence\tn.\t一致性\t多副本缓存保持数据一致
snapshot\tn.\t快照\t某一时刻状态的副本
protocol\tn.\t协议\t部件间通信遵循的约定
silicon\tn.\t硅/芯片\t集成电路载体，常代指芯片
fabric\tn.\t互连结构\t芯片或系统中的互连网络
die\tn.\t裸片\t单个芯片晶粒
clock\tn.\t时钟\t驱动同步电路时序的周期信号
edge\tn.\t边沿\t时钟信号的上升沿或下降沿
assert\tv.\t置为有效/断言\t把信号设为有效电平
deassert\tv.\t置为无效\t把信号恢复为无效电平
trigger\tv./n.\t触发；触发器\t使事件或信号激活
sample\tv./n.\t采样；样本\t在特定时刻读取信号值
propagate\tv.\t传播\t信号或值沿电路或总线传递
drive\tv.\t驱动\t向总线或引脚输出信号
latch\tv./n.\t锁存；锁存器\t把输入值固定并保持
register_file\tn.\t寄存器堆\t一组通用寄存器
mutually\tadv.\t相互地\t彼此之间
exclusively\tadv.\t排他地/仅\t只用或仅限，互斥
simultaneous\tadj.\t同时的\t在同一时刻发生
sustained\tadj.\t持续的\t持续保持某一水平
peak\tn./adj.\t峰值\t最大值
increment\tv./n.\t递增\t每次增加一个增量
decrement\tv./n.\t递减\t每次减少一个量
enumerate\tv.\t枚举\t逐个列出
initial\tadj.\t初始的\t开始的，最初的
consecutive\tadj.\t连续的\t依次相连，不间断
subsequent\tadj.\t随后的\t在其之后的后续
trailing\tadj.\t尾随的/拖尾的\t出现在尾部或后沿
pending\tadj.\t挂起的/待处理\t已请求但尚未完成
outstanding\tadj.\t未完成的\t已发出但尚未返回或处理完
utilization\tn.\t利用率\t资源被使用的比例
granularity\tn.\t粒度\t操作或传输的最小单位大小
alignment\tn.\t对齐\t地址按边界对齐
override\tv./n.\t覆盖/否决\t用更高优先级设置取代默认值
compliance\tn.\t符合性/合规\t遵守规范或标准
conformance\tn.\t一致性/符合\t与规范一致的程度
assume\tv.\t假定/假设\t在没有证明时当作成立
guarantee\tv./n.\t保证\t承诺必然发生或提供
constrain\tv.\t约束/限制\t施加限制条件
prohibit\tv.\t禁止\t不允许
mandatory\tadj.\t强制性的\t必须遵守，不可省略
optional\tadj.\t可选的\t可有可无
reserved\tadj.\t保留的\t预留给规范或厂商扩展
terminate\tv.\t终止/终结\t结束
initiate\tv.\t发起/启动\t开始进行
transmit\tv.\t发送/传输\t向目标传出数据
receive\tv.\t接收\t得到传入数据
suspend\tv.\t挂起/暂停\t临时停止，可恢复
resume\tv.\t恢复\t继续之前暂停的工作
probe\tv./n.\t探测\t查询或监听信号或状态
evaluate\tv.\t求值/评估\t计算或判断
correspond\tv.\t对应\t与某对象相匹配
denote\tv.\t表示/指代\t用符号或词代表
comprise\tv.\t包含/由...组成\t整体包含若干部分
consist\tv.\t由...组成\t通常与 of 连用
pertain\tv.\t关于/属于\t与某对象相关
regarding\tprep.\t关于\t就某事项而言
whereas\tconj.\t而/鉴于\t对比两个情况，也见于法律或规范
notwithstanding\tprep./adv.\t尽管/即便如此\t表示让步，不受前述影响
instead\tadv.\t相反/作为替代\t而不是前述方案
otherwise\tadv.\t否则/在其他情况下\t若不如此
i.e.\tabbr.\t即\t拉丁 id est 缩写，等于 that is，引出解释或等价说法
e.g.\tabbr.\t例如\t拉丁 exempli gratia 缩写，等于 for example，用于举例
etc\tabbr.\t等等\t拉丁 et cetera 缩写，表示列举未尽
phase\tn.\t相位\t一个时钟周期内的数据节拍，DFI 每个 phase 传输一次
bus\tn.\t总线\t多根信号线组成的共享传输通道
width\tn.\t宽度\t总线或字段的位宽
""".strip()


def _load_builtin() -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for line in _DATA.splitlines():
        word, pos, zh, note = line.split("\t", 3)
        result[word] = {"pos": pos, "zh": zh, "note": note}
    return result


BUILTIN = _load_builtin()


class Glossary:
    """合并内置词典和用户词典；用户词条具有更高优先级。"""

    def __init__(self, user_file: str | None = None):
        self.data = {word: dict(value) for word, value in BUILTIN.items()}
        if not user_file:
            return
        path = Path(user_file)
        if not path.exists():
            return
        try:
            user_data = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(user_data, dict):
                raise ValueError("词典根节点必须是 JSON 对象")
            for word, value in user_data.items():
                if not isinstance(value, dict) or not value.get("zh"):
                    continue
                self.data[word.lower()] = {
                    "pos": str(value.get("pos", "")),
                    "zh": str(value["zh"]),
                    "note": str(value.get("note", "")),
                }
        except (OSError, ValueError) as exc:
            LOGGER.warning("用户词典加载失败: %s", exc)

    def lookup(self, word: str) -> dict[str, str | bool] | None:
        """查词并做轻量词形还原；未命中返回 ``None``。"""
        original = word.strip()
        key = original.lower()
        candidates = [key]
        if key.endswith("ies") and len(key) > 4:
            candidates.append(key[:-3] + "y")
        if key.endswith("ied") and len(key) > 4:
            candidates.append(key[:-3] + "y")
        for suffix in ("ing", "ed", "es", "s"):
            if key.endswith(suffix) and len(key) > len(suffix) + 2:
                stem = key[: -len(suffix)]
                candidates.extend([stem, stem + "e"])
                if len(stem) > 2 and stem[-1] == stem[-2]:
                    candidates.append(stem[:-1])

        for index, candidate in enumerate(dict.fromkeys(candidates)):
            entry = self.data.get(candidate)
            if entry is None:
                continue
            result: dict[str, str | bool] = {"word": original, **entry}
            if index:
                result["variant"] = True
            return result
        return None


def _self_test() -> None:
    glossary = Glossary()
    assert glossary.lookup("latency")
    assert glossary.lookup("flushed")
    assert glossary.lookup("unknown") is None
    print("glossary: ok")


if __name__ == "__main__":
    _self_test()
