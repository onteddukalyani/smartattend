Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "..\android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png"
$destPath = Join-Path $PSScriptRoot "..\ios\App\App\Assets.xcassets\AppIcon.appiconset\AppIcon-512@2x.png"

$srcImg = [System.Drawing.Image]::FromFile($srcPath)
$destBmp = New-Object System.Drawing.Bitmap 1024, 1024, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($destBmp)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

$graphics.DrawImage($srcImg, 0, 0, 1024, 1024)
$srcImg.Dispose()
$graphics.Dispose()

if (Test-Path $destPath) {
    Remove-Item -Force $destPath
}

$destBmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
$destBmp.Dispose()

Write-Host "✅ Generated 1024x1024 AppIcon-512@2x.png successfully"
