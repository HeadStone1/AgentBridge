@echo off
setlocal
set "AGENTBRIDGE_INSTALL_ROOT=%~dp0.."
set /p AGENTBRIDGE_VERSION=<"%AGENTBRIDGE_INSTALL_ROOT%\current"
set "AGENTBRIDGE_LAUNCHER=%~f0"
set "AGENTBRIDGE_RUNTIME=%AGENTBRIDGE_INSTALL_ROOT%\versions\%AGENTBRIDGE_VERSION%\runtime\node.exe"
set "AGENTBRIDGE_APP=%AGENTBRIDGE_INSTALL_ROOT%\versions\%AGENTBRIDGE_VERSION%\app"

if not exist "%AGENTBRIDGE_RUNTIME%" (
  echo AgentBridge runtime was not found for version %AGENTBRIDGE_VERSION%. 1>&2
  exit /b 1
)

if /i "%~1"=="mcp" (
  set "AGENTBRIDGE_VERSION=%AGENTBRIDGE_VERSION%"
  "%AGENTBRIDGE_RUNTIME%" "%AGENTBRIDGE_APP%\agentbridge-mcp.mjs"
) else (
  "%AGENTBRIDGE_RUNTIME%" "%AGENTBRIDGE_APP%\agentbridge-cli.mjs" %*
)
exit /b %ERRORLEVEL%
