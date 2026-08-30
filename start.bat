@echo off
rem Parse-Spec 一键启动：双击运行即可。使用项目 .venv 中的解释器启动本地服务，
rem 服务就绪后自动打开默认浏览器；终端保持前台可看日志，Ctrl+C 停止。
setlocal
cd /d "%~dp0"

set "PYTHON=%CD%\.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
  echo [parse-spec] 未找到 .venv 虚拟环境，尝试用 uv 创建...
  where uv >nul 2>nul
  if errorlevel 1 (
    echo [parse-spec] 缺少 uv。请先执行以下命令初始化环境后重试：
    echo   uv venv --python 3.11 .venv
    echo   uv pip install --python .venv\Scripts\python.exe -r requirements.txt .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl
    pause
    exit /b 1
  )
  uv venv --python 3.11 .venv || (pause & exit /b 1)
  uv pip install --python "%PYTHON%" -r requirements.txt .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl || (pause & exit /b 1)
)

echo [parse-spec] 启动服务中，浏览器将自动打开；停止服务请按 Ctrl+C。
set "PARSE_SPEC_OPEN_BROWSER=1"
"%PYTHON%" server.py
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [parse-spec] 服务异常退出（代码 %EXITCODE%），请查看上方日志。
  pause
)
endlocal
exit /b %EXITCODE%
