@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
where node.exe >nul 2>&1
if errorlevel 1 goto :node_required
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto :node_required
node portrait.mjs serve --open
set "app_exit=%errorlevel%"
if not "%app_exit%"=="0" pause
popd
exit /b %app_exit%

:node_required
echo Node.js 22 or newer is required. Install it from https://nodejs.org/ and try again.
pause
popd
exit /b 1
