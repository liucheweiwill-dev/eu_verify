@echo off
rem ---------------------------------------------------------------------
rem  eu_verify - run.cmd
rem
rem  Double-click        : read URLs from the clipboard
rem  Drag .html files on : read URLs from saved Google result pages
rem
rem  KEEP THIS FILE PURE ASCII.
rem  cmd.exe mis-parses a batch file when "chcp" changes the codepage and
rem  the file itself contains multi-byte characters - the parser's byte
rem  offset shifts and it starts executing fragments of lines. All Chinese
rem  messages are printed by the node scripts instead, which is why the
rem  chcp below is safe.
rem
rem  Do NOT name variables TMP, TEMP, PATH, CD ... they are real Windows
rem  environment variables and shadowing them is how deleting a "TMP"
rem  variable once expanded to the real Windows temp directory.
rem ---------------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   eu_verify
echo   ---------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] node not found. Install Node.js 18 or newer.
  goto end
)

if exist ".euv_urls.tmp" del /f /q ".euv_urls.tmp"
if exist ".euv_clip.tmp" del /f /q ".euv_clip.tmp"

if "%~1"=="" goto clipboard

rem ---- files dragged onto this script ---------------------------------
echo   source: dropped files
echo.
node extract.js %* > ".euv_urls.tmp"
if errorlevel 1 goto nothing
goto verify

rem ---- no arguments: read the clipboard -------------------------------
:clipboard
echo   source: clipboard
echo.
powershell -NoProfile -Command "Get-Clipboard -Raw" > ".euv_clip.tmp" 2>nul
if not exist ".euv_clip.tmp" goto nothing
node extract.js --text ".euv_clip.tmp" > ".euv_urls.tmp"
if errorlevel 1 goto nothing
goto verify

rem ---- nothing found: stop, leave the previous list alone -------------
:nothing
echo.
echo   [STOP] No target URLs found. Nothing was run.
echo   This does NOT mean "no news today" - it means no URLs were read.
echo   Fallback: press Ctrl+S on each Google result tab, then drag the
echo             saved .html files onto this run.cmd.
echo.
if exist ".euv_urls.tmp" del /f /q ".euv_urls.tmp"
if exist ".euv_clip.tmp" del /f /q ".euv_clip.tmp"
goto end

rem ---- verify and open the report -------------------------------------
:verify
if exist ".euv_clip.tmp" del /f /q ".euv_clip.tmp"
move /y ".euv_urls.tmp" "urls.today.txt" >nul
echo.
node verify.js "urls.today.txt" -o "search_result.html"
if errorlevel 1 (
  echo.
  echo   [ERROR] verify.js failed. The report was not updated.
  goto end
)
if not exist "search_result.html" (
  echo.
  echo   [ERROR] search_result.html was not produced.
  goto end
)
echo.
echo   opening report...
start "" "search_result.html"

:end
echo.
pause
endlocal
