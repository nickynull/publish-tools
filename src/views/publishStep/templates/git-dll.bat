@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM 可配置变量统一放在最前面，按需修改
REM ============================================================

REM 代码根目录，如：D:\Codes\SMOM\SMOM.XXX\SMOM.V10.3
set projectPath="{{PROJECT_PATH}}"
REM 代码根目录下的解决方案文件，如：SMOM.build.sln
set projectSolution="{{PROJECT_SOLUTION}}"

REM 生成模式可选项：Debug / Release
set "buildConfiguration=Release"

REM 平台可选项：Any CPU / x86 / x64
set "buildPlatform=Any CPU"

REM ============================================================
REM 第一步：自动探测 Visual Studio 安装路径并初始化开发环境
REM ============================================================
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"

if not exist "%VSWHERE%" (
    echo 啊哦，找不到 vswhere.exe，请确认已安装 Visual Studio 2017 或更高版本。
    pause
    exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -property installationPath`) do (
    set "VS_PATH=%%i"
)

if not defined VS_PATH (
    echo 啊哦，未能探测到 Visual Studio 安装路径。
    pause
    exit /b 1
)

echo 探测到 Visual Studio 路径：!VS_PATH!
call "!VS_PATH!\Common7\Tools\VsDevCmd.bat"

if not defined VSCMD_VER (
    echo 啊哦，初始化 VS 开发环境失败。
    pause
    exit /b 1
)
echo VS 开发环境初始化完成（VSCMD_VER=!VSCMD_VER!）。
echo.

REM ============================================================
REM 第二步：执行 Git 获取 + 生成 dll 流程
REM ============================================================

:: 切换到代码路径
echo ----------------------------------------------------
set step01time=%time%
echo %step01time%： 1、切换到代码路径

cd /d %projectPath%
if %errorlevel% neq 0 (
	echo 啊哦，出错了
	pause 
	exit 
)

echo %projectPath%
echo ----------------------------------------------------
echo.

:: 获取Git上最新的代码
echo ----------------------------------------------------
set step02time=%time%
echo %step02time%： 2、开始获取Git上最新的代码
echo ----------------------------------------------------
echo.

git pull 
if %errorlevel% neq 0 (
	echo 啊哦，出错了
	pause 
	exit 
)

echo ----------------------------------------------------
set step03time=%time%
echo %step03time%： 3、结束获取Git上最新的代码
echo ----------------------------------------------------
echo.

:: 生成dll
echo ----------------------------------------------------
set step04time=%time%
echo %step04time%： 4、开始生成解决方案 %projectSolution% 的dll
echo ----------------------------------------------------
echo.
set step05time=%time%
echo %step05time%： 5、生成模式 !buildConfiguration!，平台 !buildPlatform!，只显示错误信息，多核编译
set step06time=%time%
echo %step06time%： 6、正在生成解决方案 %projectSolution% 的dll，请耐心等待......
echo.

msbuild %projectSolution% /p:Configuration=!buildConfiguration! /p:Platform="!buildPlatform!" /consoleloggerparameters:ErrorsOnly /m
if %errorlevel% neq 0 (
	echo 啊哦，出错了
	pause 
	exit 
)

echo ----------------------------------------------------
set step07time=%time%
echo %step07time%： 7、结束生成解决方案 %projectSolution% 的dll
echo ----------------------------------------------------
echo.

echo ----------------------脚本回顾----------------------
echo 从 %step01time% 到 %step02time%： 切换到代码路径 %projectPath%
echo 从 %step02time% 到 %step03time%： 获取Git上最新的代码
echo 从 %step04time% 到 %step07time%： 生成解决方案 %projectSolution% 的dll（!buildConfiguration! / !buildPlatform!）
echo ----------------------------------------------------

pause