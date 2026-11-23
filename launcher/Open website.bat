@echo off
rem SiteClone — opens this website copy through a small local server (needs Node.js or Python 3).
cd /d "%~dp0"
title Website copy - keep this window open

node --version >nul 2>nul
if %errorlevel%==0 (
    node "_siteclone\serve.mjs"
    goto end
)
python -c "import sys; assert sys.version_info[0] == 3" >nul 2>nul
if %errorlevel%==0 (
    python "_siteclone\serve.py"
    goto end
)
py -3 -c "import sys" >nul 2>nul
if %errorlevel%==0 (
    py -3 "_siteclone\serve.py"
    goto end
)

echo.
echo   To run animations, 3D and other interactive parts, this copy needs Node.js or Python.
echo   Install one of them, then double-click this file again:
echo     Node.js : https://nodejs.org
echo     Python  : https://www.python.org/downloads/  (tick "Add python.exe to PATH")
echo.
echo   Only want to look at the pages? Open index.html instead - nothing to install.
echo.
:end
pause
