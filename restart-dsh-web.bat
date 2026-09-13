@echo off
rem ============================================================
rem  Restart dsh web  --  double-click this file.
rem
rem  ASCII only, on purpose:
rem    cmd.exe reads this file in the console codepage, so non-ASCII
rem    text would be mangled here, and a UTF-8 BOM makes the very
rem    first line fail with "is not recognized as a command".
rem    All real logic lives in restart-dsh-web.ps1: PowerShell reads
rem    that file itself, so its Chinese output is safe there.
rem ============================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-dsh-web.ps1"
