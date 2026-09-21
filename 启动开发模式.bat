@echo off
setlocal EnableDelayedExpansion
rem ===================================================================
rem  bili-audio (Tauri) - Dev Mode Launcher
rem  Builds with the `dev-server` feature, runs the app and opens the
rem  UI in your browser at http://127.0.0.1:37210
rem
rem  NOTE: the packaged (release) build does NOT listen on any TCP port.
rem  The port is available ONLY in this dev/debug mode.
rem ===================================================================

rem ---- 1. Rust toolchain (installed on drive E:) ----
set "RUSTUP_HOME=E:\tauri-env\rustup"
set "CARGO_HOME=E:\tauri-env\cargo"
set "PATH=E:\tauri-env\cargo\bin;%PATH%"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found. Check E:\tauri-env\cargo\bin
  pause
  exit /b 1
)

rem ---- 2. MSVC Build Tools + Windows SDK ----
set "MSVC_BASE=E:\VSBT\VC\Tools\MSVC"
set "SDK_BASE=C:\Program Files (x86)\Windows Kits\10"

if not defined MSVC_VERSION (
  for /f "delims=" %%i in ('dir /b /ad /o-n "!MSVC_BASE!" 2^>nul') do (
    set "MSVC_VERSION=%%i"
    goto :msvc_done
  )
)
:msvc_done
if not defined SDK_VERSION (
  for /f "delims=" %%i in ('dir /b /ad /o-n "!SDK_BASE!\Include" 2^>nul') do (
    set "SDK_VERSION=%%i"
    goto :sdk_done
  )
)
:sdk_done

if defined MSVC_VERSION (
  set "PATH=!MSVC_BASE!\!MSVC_VERSION!\bin\Hostx64\x64;!SDK_BASE!\bin\!SDK_VERSION!\x64;%PATH%"
  set "LIB=!MSVC_BASE!\!MSVC_VERSION!\lib\x64;!SDK_BASE!\Lib\!SDK_VERSION!\ucrt\x64;!SDK_BASE!\Lib\!SDK_VERSION!\um\x64"
  set "LIBPATH=!MSVC_BASE!\!MSVC_VERSION!\lib\x64;!SDK_BASE!\Lib\!SDK_VERSION!\ucrt\x64;!SDK_BASE!\Lib\!SDK_VERSION!\um\x64"
  set "INCLUDE=!MSVC_BASE!\!MSVC_VERSION!\include;!SDK_BASE!\Include\!SDK_VERSION!\ucrt;!SDK_BASE!\Include\!SDK_VERSION!\um;!SDK_BASE!\Include\!SDK_VERSION!\shared"
)

rem ---- 3. Build (dev-server feature => TCP port for browser debugging) ----
pushd "%~dp0src-tauri"

echo [1/3] cargo build --features dev-server ...
cargo build --features dev-server
if errorlevel 1 (
  echo [ERROR] build failed.
  popd
  pause
  exit /b 1
)

rem ---- 4. Run the app ----
echo [2/3] starting bili-audio (dev) ...
start "" "target\debug\bili-audio.exe"

rem ---- 5. Open browser UI ----
echo [3/3] opening http://127.0.0.1:37210
timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:37210

popd
endlocal
