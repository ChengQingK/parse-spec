@echo off
rem Parse-Spec one-click launcher: uses the project .venv to run server.py.
rem The server opens the default browser once it is ready. Keep this window
rem open while reading; press Ctrl+C to stop the server.
rem NOTE: keep this file ASCII-only and CRLF - cmd.exe mis-parses UTF-8 batch files.
setlocal
cd /d "%~dp0"

set "PYTHON=%CD%\.venv\Scripts\python.exe"

if exist "%PYTHON%" goto :run

echo [parse-spec] .venv not found. Trying to create it with uv...
where uv >nul 2>nul
if errorlevel 1 goto :no-uv
uv venv --python 3.11 .venv
if errorlevel 1 goto :failed
uv pip install --python "%PYTHON%" -r requirements.txt .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl
if errorlevel 1 goto :failed

:run
echo [parse-spec] Starting server... your browser will open automatically.
echo [parse-spec] Press Ctrl+C in this window to stop the server.
set "PARSE_SPEC_OPEN_BROWSER=1"
"%PYTHON%" server.py
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [parse-spec] Server exited with code %EXITCODE%. Check the log above.
  pause
)
endlocal & exit /b %EXITCODE%

:no-uv
echo [parse-spec] uv was not found. Initialize the environment manually:
echo   uv venv --python 3.11 .venv
echo   uv pip install --python .venv\Scripts\python.exe -r requirements.txt .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl
pause
exit /b 1

:failed
echo [parse-spec] Environment setup failed. Check the log above.
pause
exit /b 1
