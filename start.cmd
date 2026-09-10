@echo off
setlocal
cd /d "%~dp0"
set "TRACKER_CONDA=%CONDA_EXE%"
if defined TRACKER_CONDA if exist "%TRACKER_CONDA%" goto launch
set "TRACKER_CONDA="
for /f "delims=" %%C in ('where conda.exe conda.bat 2^>nul') do if not defined TRACKER_CONDA set "TRACKER_CONDA=%%C"
if defined TRACKER_CONDA goto launch
for %%C in ("%USERPROFILE%\miniconda3\Scripts\conda.exe" "%USERPROFILE%\anaconda3\Scripts\conda.exe" "%LOCALAPPDATA%\miniconda3\Scripts\conda.exe" "%ProgramData%\miniconda3\Scripts\conda.exe") do if exist "%%~C" set "TRACKER_CONDA=%%~C"
if not defined TRACKER_CONDA (
    echo Conda was not found. Run this script from Anaconda Prompt.
    pause
    exit /b 1
)
:launch
call "%TRACKER_CONDA%" run --no-capture-output -n virtual-window-tracker python "%~dp0scripts\run_local.py" %*
set "TRACKER_EXIT=%ERRORLEVEL%"
if not "%TRACKER_EXIT%"=="0" pause
exit /b %TRACKER_EXIT%
