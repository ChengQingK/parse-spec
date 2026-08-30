"""临时 CORS 静态文件服务：供浏览器页面直接拉取本地 PDF（开发诊断用，用完即停）。

用途：viewer 主服务（server.py）不允许跨域，直接用 file:// 或其它端口打开
本地 PDF 会因 CORS 拿不到文本层。需要诊断"某个真实 SPEC 在前端解析/渲染"
时，用本脚本把任意目录以只读方式临时暴露给 127.0.0.1，例如：

    python scripts/diag_file_server.py "C:/some/spec/dir" 5700

默认目录/端口为开发机 LPDDR 规格目录与 5700。仅绑定回环地址，路径做了
目录逃逸防护，诊断结束后 Ctrl+C 停止即可。
"""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DEFAULT_DOC_DIR = r"C:\myWork\LPDDR_PHY\01_shared_resources\doc\SPEC"
DEFAULT_PORT = 5700

DOC_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DOC_DIR).resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PORT


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.lstrip("/")
        path = (DOC_DIR / name).resolve()
        if not str(path).startswith(str(DOC_DIR)) or not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"* 诊断文件服务 {DOC_DIR} → http://127.0.0.1:{PORT}（Ctrl+C 停止）")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
