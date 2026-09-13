<#
  dsh web 重启脚本

  用途：让 DSH 重新组合 Web 启动图，从而加载 / 更新客户端插件
        （例如 dsh-plugin-live-diff）。

  注意：重启会断开当前正在使用的 DSH 页面。
        对话历史保存在 $env:DSH_HOME\sessions\ 下，不会丢失。
#>

$ErrorActionPreference = 'Stop'

function Write-Head($text) { Write-Host $text }
function Write-Step($text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host $text -ForegroundColor Green }
function Write-Warn2($text) { Write-Host $text -ForegroundColor Yellow }

Write-Host "============================================================"
Write-Host "  dsh web 重启脚本"
Write-Host "============================================================"
Write-Host ""
Write-Host "  重启会断开当前 DSH 页面；对话历史保存在："
Write-Host "    $env:DSH_HOME\sessions\"
Write-Host ""

# ---------------------------------------------------------------
# 定位 dsh web 服务进程
#
# 必须排除 runner.js：DSH 的工具子进程命令行里会内嵌整段命令文本，
# 只匹配 bin.js 会把脚本自己拉起的子进程也算进去，进而误杀。
# 同时匹配 "bin.js" 与 "web"，以排除 dsh plugin / --dump-config。
# ---------------------------------------------------------------
Write-Step "[1/3] 正在查找 dsh web 服务进程 ..."

$candidates = @()
try {
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    $candidates = @($nodeProcs | Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*bin.js*' -and
            $_.CommandLine -notlike '*runner.js*' -and
            $_.CommandLine -match 'bin\.js.*\bweb\b'
        })
}
catch {
    Write-Warn2 "      无法枚举进程：$($_.Exception.Message)"
    Write-Warn2 "      请尝试以管理员身份运行。"
}

if ($candidates.Count -eq 0) {
    Write-Host "      未找到运行中的 dsh web 进程，直接启动。"
}
else {
    foreach ($proc in $candidates) {
        Write-Host "      找到 PID $($proc.ProcessId)"
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Ok  "      已停止 PID $($proc.ProcessId)"
        }
        catch {
            Write-Warn2 "      停止 PID $($proc.ProcessId) 失败：$($_.Exception.Message)"
            Write-Warn2 "      请以管理员身份重试。"
        }
    }
    # 给端口释放一点时间
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------
# 确认 3080 端口已释放
# ---------------------------------------------------------------
Write-Step "[2/3] 检查端口 3080 ..."

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    Write-Warn2 "      端口 3080 仍被 PID $($listeners[0].OwningProcess) 占用。"
    Write-Warn2 "      可能还有另一个 dsh 实例；若启动失败请检查该进程。"
}
else {
    Write-Ok "      端口 3080 已释放。"
}

# ---------------------------------------------------------------
# 启动服务（独立窗口，便于日后再次重启）
# ---------------------------------------------------------------
Write-Step "[3/3] 正在启动 dsh web ..."

try {
    # 把诊断日志固定到本机项目目录。
    #
    # 插件默认写到系统临时目录（因为仓库要发布到任何机器），但这个脚本是本机
    # 专用的，开发时直接读项目下的 diag.log 更方便。
    #
    # 用 `$env:` 而不是 `Start-Process -Environment`：后者要 PowerShell 7.4+，
    # 而本机是 5.1。好在 `$env:` 设置的进程级变量会被 Start-Process 的子进程
    # 继承，效果一样。
    $logPath = Join-Path $PSScriptRoot 'diag.log'
    $env:DSH_LIVE_DIFF_LOG = $logPath

    # cmd /k 让窗口保留，便于查看日志与下次手动 Ctrl+C
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'dsh web' -WorkingDirectory $env:USERPROFILE
    Write-Ok "      已在新窗口启动。"
    Write-Host "      诊断日志：$logPath"
}
catch {
    Write-Warn2 "      启动失败：$($_.Exception.Message)"
    Write-Warn2 "      请手动在新窗口执行：dsh web"
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  完成。请在浏览器打开："
Write-Host ""
Write-Host "      http://127.0.0.1:3080" -ForegroundColor Green
Write-Host ""
Write-Host "  若 3080 被占用，DSH 可能自动改用 3081，"
Write-Host "  请以新打开的 dsh web 窗口里打印出的地址为准。"
Write-Host ""
Write-Host "  本窗口可关闭；服务运行在新窗口中。"
Write-Host "============================================================"
Write-Host ""
Read-Host "按回车键退出"
