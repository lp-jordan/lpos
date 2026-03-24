@echo off
setlocal

set "ROOT=%~dp0.."
set "BRIDGE_SRC=%ROOT%\native\sony-camera-bridge"
set "BRIDGE_BUILD=%BRIDGE_SRC%\build"
set "VC_VARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if exist "%VC_VARS%" goto vcvars_ok
echo Visual Studio Build Tools not found at:
echo   %VC_VARS%
exit /b 1

:vcvars_ok

call "%VC_VARS%"
if errorlevel 1 exit /b 1

if exist "%BRIDGE_BUILD%" rmdir /s /q "%BRIDGE_BUILD%"
mkdir "%BRIDGE_BUILD%"
if errorlevel 1 exit /b 1

cd /d "%BRIDGE_BUILD%"
if errorlevel 1 exit /b 1

cmake -G "Visual Studio 17 2022" -A x64 ..
if errorlevel 1 exit /b 1
"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\amd64\MSBuild.exe" sony_camera_bridge.sln /p:Configuration=Release /p:Platform=x64 /m
if errorlevel 1 exit /b 1

echo.
echo Built:
echo   %ROOT%\vendor\sony-camera-bridge\win-x64\sony-camera-bridge.exe
