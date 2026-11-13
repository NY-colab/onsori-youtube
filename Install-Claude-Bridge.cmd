@echo off
rem Connects 온소리 자막 in YouTube to the Claude Code CLI signed in on this PC.
rem Usage: Install-Claude-Bridge.cmd [extension id ...]   (Install-Claude-Bridge.cmd --uninstall)
chcp 65001 >nul
where node >nul 2>nul || (echo Node.js가 필요합니다. https://nodejs.org 에서 설치해 주세요. & pause & exit /b 1)
set ARGS=%*
if "%ARGS%"=="" set /p ARGS=AI 보정 설정 화면에 보이는 확장 ID를 붙여 넣고 Enter(없으면 그냥 Enter):
node "%~dp0native-host\install.mjs" %ARGS%
pause
