# Egret UI Editor Build Script
# Workaround for Chinese username issues

#region Auto-Elevate
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Build script requires Administrator privileges for file unlocking. Elevating..." -ForegroundColor Yellow
    try {
        Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
        exit 0
    } catch {
        Write-Error "Failed to elevate privileges: $_"
        Write-Host "`nPress any key to exit..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit 1
    }
}
#endregion

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Egret UI Editor Build Script" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Create temp build directory
$buildTempDir = "C:\egret-build-temp"
Write-Host "Creating temp build directory: $buildTempDir" -ForegroundColor Yellow

if (-not (Test-Path $buildTempDir)) {
    New-Item -ItemType Directory -Path $buildTempDir -Force | Out-Null
    Write-Host "[OK] Temp directory created" -ForegroundColor Green
} else {
    Write-Host "[OK] Temp directory exists" -ForegroundColor Green
}

Write-Host ""

# Set environment variables (current session only)
Write-Host "Setting temporary environment variables..." -ForegroundColor Yellow
$env:TEMP = $buildTempDir
$env:TMP = $buildTempDir
$env:npm_config_cache = "$buildTempDir\npm-cache"
$env:npm_config_tmp = "$buildTempDir\npm-tmp"
$env:ELECTRON_BUILDER_CACHE = "$buildTempDir\electron-builder-cache"
$env:ELECTRON_CACHE = "$buildTempDir\electron-cache"

Write-Host "[OK] TEMP = $env:TEMP" -ForegroundColor Green
Write-Host "[OK] TMP = $env:TMP" -ForegroundColor Green
Write-Host "[OK] npm_config_cache = $env:npm_config_cache" -ForegroundColor Green
Write-Host "[OK] npm_config_tmp = $env:npm_config_tmp" -ForegroundColor Green
Write-Host "[OK] ELECTRON_BUILDER_CACHE = $env:ELECTRON_BUILDER_CACHE" -ForegroundColor Green
Write-Host "[OK] ELECTRON_CACHE = $env:ELECTRON_CACHE" -ForegroundColor Green
Write-Host ""

# Change to script directory (project root)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
Write-Host "Working directory: $scriptDir" -ForegroundColor Cyan
Write-Host ""

#region Clean locked files
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Checking for locked files" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

function Test-FileLocked {
    param([string]$filePath)
    
    if (-not (Test-Path $filePath)) {
        return $false
    }
    
    try {
        $file = [System.IO.File]::Open($filePath, 'Open', 'ReadWrite', 'None')
        $file.Close()
        $file.Dispose()
        return $false
    } catch {
        return $true
    }
}

function Get-RmLockingProcesses {
    param([string]$filePath)
    
    if (-not (Test-Path $filePath)) {
        return @()
    }

    $csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
}

[StructLayout(LayoutKind.Sequential)]
public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)]
    public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)]
    public string strServiceShortName;
    public uint ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)]
    public bool bRestartable;
}

public class RestartManagerWrapper {
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle,
        uint nFiles, string[] rgsFilenames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications,
        uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmGetList(uint dwSessionHandle,
        out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps,
        out uint lpdwRebootReasons);

    public static object[] GetProcessesUsingFile(string path) {
        uint handle;
        string sessionKey = Guid.NewGuid().ToString();
        int res = RmStartSession(out handle, 0, sessionKey);
        if (res != 0) return new object[0];

        try {
            string[] resources = new string[1] { path };
            res = RmRegisterResources(handle, 1, resources, 0, null, 0, null);
            if (res != 0) return new object[0];

            uint pnProcInfoNeeded = 0, pnProcInfo = 0, lpdwRebootReasons = 0;
            res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, null, out lpdwRebootReasons);
            if (res == 234) {
                pnProcInfo = pnProcInfoNeeded;
                RM_PROCESS_INFO[] processInfo = new RM_PROCESS_INFO[pnProcInfo];
                res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, processInfo, out lpdwRebootReasons);
                if (res == 0) {
                    var list = new List<object>();
                    for (int i = 0; i < pnProcInfo; i++) {
                        list.Add(new { ProcessId = processInfo[i].Process.dwProcessId, AppName = processInfo[i].strAppName });
                    }
                    return list.ToArray();
                }
            }
        } finally {
            RmEndSession(handle);
        }
        return new object[0];
    }
}
'@

    if (-not ([System.Management.Automation.PSTypeName]'RestartManagerWrapper').Type) {
        Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop | Out-Null
    }

    try {
        $res = [RestartManagerWrapper]::GetProcessesUsingFile($filePath)
        $out = @()
        foreach ($r in $res) {
            $processId = $r.ProcessId
            $proc = $null
            try { $proc = Get-Process -Id $processId -ErrorAction Stop } catch { }
            $pname = if ($proc) { $proc.ProcessName } else { $r.AppName }
            $out += [pscustomobject]@{ PID = $processId; ProcessName = $pname }
        }
        return $out
    } catch {
        return @()
    }
}

# Check and clean locked files in dist directory
$filesToCheck = @(
    ".\dist\win-unpacked\resources\app.asar",
    ".\dist\win-unpacked\Egret UI Editor.exe"
)

$lockedFiles = @()
foreach ($file in $filesToCheck) {
    if (Test-Path $file) {
        $fullPath = (Resolve-Path $file).Path
        $isLocked = Test-FileLocked -filePath $fullPath
        
        if ($isLocked) {
            Write-Host "File is locked: $file" -ForegroundColor Yellow
            
            # Try to get process info via Restart Manager
            $locks = Get-RmLockingProcesses -filePath $fullPath
            
            if (-not $locks -or $locks.Count -eq 0) {
                Write-Host "  Restart Manager didn't find locking processes. Trying alternative method..." -ForegroundColor Yellow
                
                # Alternative: use handle.exe if available, or search for likely processes
                $likelyProcesses = Get-Process | Where-Object { 
                    $_.ProcessName -match "Egret|electron" -or 
                    $_.MainWindowTitle -match "Egret UI Editor"
                }
                
                if ($likelyProcesses) {
                    Write-Host "  Found potential locking processes:" -ForegroundColor Yellow
                    $likelyProcesses | Format-Table Id, ProcessName, MainWindowTitle -AutoSize
                    
                    $locks = $likelyProcesses | ForEach-Object {
                        [pscustomobject]@{ PID = $_.Id; ProcessName = $_.ProcessName }
                    }
                } else {
                    Write-Warning "  Could not identify locking process automatically."
                    Write-Host "  Will attempt to delete the file forcefully..." -ForegroundColor Yellow
                }
            } else {
                Write-Host "  Found $($locks.Count) process(es) via Restart Manager:" -ForegroundColor Yellow
                $locks | Format-Table -AutoSize
            }
            
            $lockedFiles += @{ File = $file; FullPath = $fullPath; Locks = $locks }
        }
    }
}

if ($lockedFiles.Count -gt 0) {
    Write-Host "Terminating locking processes..." -ForegroundColor Yellow
    
    # First, try to use handle.exe to close specific handles
    $handleExe = "$env:SystemRoot\System32\handle.exe"
    $useHandle = Test-Path $handleExe
    
    if ($useHandle) {
        Write-Host "Using handle.exe to close file handles..." -ForegroundColor Cyan
        foreach ($item in $lockedFiles) {
            try {
                $handleOutput = & $handleExe -accepteula -nobanner $item.FullPath 2>&1
                if ($handleOutput) {
                    Write-Host "  Handle.exe output for $($item.File):" -ForegroundColor Gray
                    $handleOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
                    
                    # Parse output to find handle IDs and close them
                    # Format: processname.exe pid: 1234 type: File 5C: C:\path\to\file
                    foreach ($line in $handleOutput) {
                        if ($line -match '^\s*(\S+)\s+pid:\s*(\d+)\s+.*\s+([0-9A-Fa-f]+):\s*(.*)$') {
                            $procName = $matches[1]
                            $procPid = $matches[2]
                            $handleId = $matches[3]
                            Write-Host "  Closing handle $handleId in PID $procPid ($procName)..." -ForegroundColor Yellow
                            
                            try {
                                & $handleExe -accepteula -c $handleId -p $procPid -y 2>&1 | Out-Null
                                Write-Host "  [OK] Closed handle $handleId" -ForegroundColor Green
                            } catch {
                                Write-Warning "  Failed to close handle $handleId"
                            }
                        }
                    }
                }
            } catch {
                Write-Warning "  handle.exe failed: $_"
                $useHandle = $false
            }
        }
        Write-Host ""
        Start-Sleep -Milliseconds 500
    }
    
    # Then terminate the processes
    foreach ($item in $lockedFiles) {
        if ($item.Locks -and $item.Locks.Count -gt 0) {
            foreach ($lock in $item.Locks) {
                try {
                    # Also stop all child processes
                    $childProcesses = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $lock.PID }
                    
                    if ($childProcesses) {
                        Write-Host "  Found $($childProcesses.Count) child process(es) of PID $($lock.PID)" -ForegroundColor Yellow
                        foreach ($child in $childProcesses) {
                            try {
                                Write-Host "  Stopping child PID $($child.ProcessId) ($($child.Name))..." -ForegroundColor Yellow
                                Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop
                            } catch { }
                        }
                    }
                    
                    Write-Host "  Stopping PID $($lock.PID) ($($lock.ProcessName))..." -ForegroundColor Yellow
                    Stop-Process -Id $lock.PID -Force -ErrorAction Stop
                    Write-Host "  [OK] Stopped PID $($lock.PID)" -ForegroundColor Green
                    Start-Sleep -Milliseconds 500
                } catch {
                    Write-Warning "  Failed to stop PID $($lock.PID): $_"
                }
            }
        }
    }
    Write-Host ""
    Write-Host "Waiting for files to be released..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
    
    # Verify files are unlocked
    $stillLocked = @()
    foreach ($item in $lockedFiles) {
        if (Test-FileLocked -filePath $item.FullPath) {
            $stillLocked += $item.File
        }
    }
    
    if ($stillLocked.Count -gt 0) {
        Write-Warning "Some files are still locked: $($stillLocked -join ', ')"
        Write-Host "Attempting more aggressive cleanup..." -ForegroundColor Yellow
        
        # Try one more round with all Egret/Electron/Code processes
        $allRelatedProcesses = Get-Process | Where-Object { 
            $_.ProcessName -match "egret|electron|code|Code" -and $_.Id -ne $PID
        }
        
        if ($allRelatedProcesses) {
            Write-Host "  Found $($allRelatedProcesses.Count) potentially related process(es):" -ForegroundColor Yellow
            $allRelatedProcesses | Format-Table Id, ProcessName, MainWindowTitle -AutoSize
            
            $response = Read-Host "  Terminate ALL these processes? (Y/N)"
            if ($response -match '^[Yy]') {
                foreach ($proc in $allRelatedProcesses) {
                    try {
                        Write-Host "  Stopping PID $($proc.Id) ($($proc.ProcessName))..." -ForegroundColor Yellow
                        Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                    } catch { }
                }
                Start-Sleep -Seconds 2
            }
        }
        
        # Final attempt: forceful removal
        foreach ($item in $lockedFiles) {
            if (Test-FileLocked -filePath $item.FullPath) {
                Write-Host "  Attempting forceful removal of: $($item.File)" -ForegroundColor Yellow
                
                # Try using cmd /c del which sometimes works when PowerShell Remove-Item fails
                try {
                    cmd /c "del /F /Q `"$($item.FullPath)`"" 2>&1 | Out-Null
                    if (-not (Test-Path $item.FullPath)) {
                        Write-Host "  [OK] Successfully removed: $($item.File)" -ForegroundColor Green
                    } else {
                        Write-Warning "  Still cannot remove: $($item.File)"
                        Write-Host "  You may need to manually close the locking application and run the script again." -ForegroundColor Red
                    }
                } catch {
                    Write-Warning "  Failed to remove: $($item.File) - $_"
                }
            }
        }
    } else {
        Write-Host "[OK] File locks cleared" -ForegroundColor Green
    }
} else {
    Write-Host "[OK] No locked files found" -ForegroundColor Green
}

Write-Host ""
#endregion

# Compile source code
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Step 1: Compiling source code" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

npm run release

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host "  Compilation Failed!" -ForegroundColor Red
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Exit Code: $LASTEXITCODE" -ForegroundColor Red
    Write-Host ""
    Write-Host "Press any key to exit..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "[OK] Source code compiled successfully" -ForegroundColor Green
Write-Host ""

# Execute build
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Step 2: Packaging application" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

npm run dist

# Check build result
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host "  Build Success!" -ForegroundColor Green
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Installer location: .\dist\" -ForegroundColor Cyan
    Get-ChildItem ".\dist\*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  - $($_.Name) ($([math]::Round($_.Length/1MB, 2)) MB)" -ForegroundColor Cyan
    }
    Write-Host ""
    Write-Host "Press any key to exit..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
} else {
    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host "  Packaging Failed!" -ForegroundColor Red
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Exit Code: $LASTEXITCODE" -ForegroundColor Red
    Write-Host ""
    Write-Host "Press any key to exit..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit $LASTEXITCODE
}
