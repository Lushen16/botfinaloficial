$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class BW {
 public delegate bool E(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$log = "C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\ban-watch.jsonl"
function Title {
  $script:t = ''
  $cb = [BW+E]{ param($h,$l)
    $pr = 0; [void][BW]::GetWindowThreadProcessId($h,[ref]$pr)
    $p = Get-Process -Id $pr
    if ($p.ProcessName -like 'PokeAlliance*' -and $p.ProcessName -notlike '*Launcher*') {
      $sb = New-Object System.Text.StringBuilder 256; [void][BW]::GetWindowText($h,$sb,256)
      $script:t = $sb.ToString(); return $false
    }
    return $true }
  [void][BW]::EnumWindows($cb,[IntPtr]::Zero)
  return $script:t
}
function Shot($file) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
  $bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}
function Ocr($file) {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $f = $m.MakeGenericMethod([Windows.Storage.StorageFile]).Invoke($null, @([Windows.Storage.StorageFile]::GetFileFromPathAsync($file))); $f.Wait(-1) | Out-Null
    $sf = $f.Result
    $s = $m.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStream]).Invoke($null, @($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read))); $s.Wait(-1) | Out-Null
    $d = $m.MakeGenericMethod([Windows.Graphics.Imaging.BitmapDecoder]).Invoke($null, @([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s.Result))); $d.Wait(-1) | Out-Null
    $b = $m.MakeGenericMethod([Windows.Graphics.Imaging.SoftwareBitmap]).Invoke($null, @($d.Result.GetSoftwareBitmapAsync())); $b.Wait(-1) | Out-Null
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    $r = $m.MakeGenericMethod([Windows.Media.Ocr.OcrResult]).Invoke($null, @($eng.RecognizeAsync($b.Result))); $r.Wait(-1) | Out-Null
    return ($r.Result.Text -replace '\s+', ' ')
  } catch { return '' }
}
$first = Title
$start = Get-Date
Add-Content $log (ConvertTo-Json -Compress @{ at = $start.ToString('o'); event = 'start'; title = $first })
$last = $first
while (((Get-Date) - $start).TotalMinutes -lt 90) {
  Start-Sleep -Seconds 20
  $now = Title
  if ($now -ne $last) {
    $isBan = $now -notmatch '^PokeAlliance - '
    Add-Content $log (ConvertTo-Json -Compress @{ at = (Get-Date).ToString('o'); event = if ($isBan) { 'suspect' } else { 'title' }; title = $now })
    if ($isBan) {
      $png = "C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\ban-watch-" + (Get-Date -Format 'HHmmss') + ".png"
      Shot $png
      $text = Ocr $png
      Add-Content $log (ConvertTo-Json -Compress @{ at = (Get-Date).ToString('o'); event = 'ocr'; text = $text; file = $png })
    }
    $last = $now
  }
}
Add-Content $log (ConvertTo-Json -Compress @{ at = (Get-Date).ToString('o'); event = 'end' })
