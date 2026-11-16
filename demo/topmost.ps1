# Pins (on) or unpins (off) the demo Chromium window above all other windows,
# so the screen recording cannot capture something else that is in front of it.
param([string]$mode = 'on')
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Win { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); }
"@
$after = if ($mode -eq 'on') { [IntPtr](-1) } else { [IntPtr](-2) }
$found = 0
Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
  [void][Win]::SetWindowPos($_.MainWindowHandle, $after, 0, 0, 0, 0, 0x43); $found++
}
Write-Output "topmost ${mode}: $found window(s)"
