Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "..\android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png"
$iconDir = Join-Path $PSScriptRoot "..\ios\App\App\Assets.xcassets\AppIcon.appiconset"

if (-not (Test-Path $iconDir)) {
    New-Item -ItemType Directory -Force -Path $iconDir
}

$srcImg = [System.Drawing.Image]::FromFile($srcPath)

function Generate-Icon($name, $pixelSize) {
    $destPath = Join-Path $iconDir $name
    $destBmp = New-Object System.Drawing.Bitmap $pixelSize, $pixelSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($destBmp)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $graphics.DrawImage($srcImg, 0, 0, $pixelSize, $pixelSize)
    $graphics.Dispose()

    if (Test-Path $destPath) {
        Remove-Item -Force $destPath
    }
    $destBmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $destBmp.Dispose()
    Write-Host "Generated $name ($pixelSize x $pixelSize)"
}

Generate-Icon "AppIcon-512@2x.png" 1024
Generate-Icon "AppIcon-20x20@2x.png" 40
Generate-Icon "AppIcon-20x20@3x.png" 60
Generate-Icon "AppIcon-29x29@1x.png" 29
Generate-Icon "AppIcon-29x29@2x.png" 58
Generate-Icon "AppIcon-29x29@3x.png" 87
Generate-Icon "AppIcon-40x40@1x.png" 40
Generate-Icon "AppIcon-40x40@2x.png" 80
Generate-Icon "AppIcon-40x40@3x.png" 120
Generate-Icon "AppIcon-60x60@2x.png" 120
Generate-Icon "AppIcon-60x60@3x.png" 180
Generate-Icon "AppIcon-76x76@1x.png" 76
Generate-Icon "AppIcon-76x76@2x.png" 152
Generate-Icon "AppIcon-83.5x83.5@2x.png" 167

$srcImg.Dispose()

$contentsJson = @"
{
  "images" : [
    {
      "size" : "20x20",
      "idiom" : "iphone",
      "filename" : "AppIcon-20x20@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "20x20",
      "idiom" : "iphone",
      "filename" : "AppIcon-20x20@3x.png",
      "scale" : "3x"
    },
    {
      "size" : "29x29",
      "idiom" : "iphone",
      "filename" : "AppIcon-29x29@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "29x29",
      "idiom" : "iphone",
      "filename" : "AppIcon-29x29@3x.png",
      "scale" : "3x"
    },
    {
      "size" : "40x40",
      "idiom" : "iphone",
      "filename" : "AppIcon-40x40@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "40x40",
      "idiom" : "iphone",
      "filename" : "AppIcon-40x40@3x.png",
      "scale" : "3x"
    },
    {
      "size" : "60x60",
      "idiom" : "iphone",
      "filename" : "AppIcon-60x60@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "60x60",
      "idiom" : "iphone",
      "filename" : "AppIcon-60x60@3x.png",
      "scale" : "3x"
    },
    {
      "size" : "20x20",
      "idiom" : "ipad",
      "filename" : "AppIcon-20x20@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "29x29",
      "idiom" : "ipad",
      "filename" : "AppIcon-29x29@1x.png",
      "scale" : "1x"
    },
    {
      "size" : "29x29",
      "idiom" : "ipad",
      "filename" : "AppIcon-29x29@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "40x40",
      "idiom" : "ipad",
      "filename" : "AppIcon-40x40@1x.png",
      "scale" : "1x"
    },
    {
      "size" : "40x40",
      "idiom" : "ipad",
      "filename" : "AppIcon-40x40@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "76x76",
      "idiom" : "ipad",
      "filename" : "AppIcon-76x76@1x.png",
      "scale" : "1x"
    },
    {
      "size" : "76x76",
      "idiom" : "ipad",
      "filename" : "AppIcon-76x76@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "83.5x83.5",
      "idiom" : "ipad",
      "filename" : "AppIcon-83.5x83.5@2x.png",
      "scale" : "2x"
    },
    {
      "size" : "1024x1024",
      "idiom" : "ios-marketing",
      "filename" : "AppIcon-512@2x.png",
      "scale" : "1x"
    },
    {
      "size" : "1024x1024",
      "idiom" : "universal",
      "platform" : "ios",
      "filename" : "AppIcon-512@2x.png"
    }
  ],
  "info" : {
    "version" : 1,
    "author" : "xcode"
  }
}
"@

$contentsPath = Join-Path $iconDir "Contents.json"
Set-Content -Path $contentsPath -Value $contentsJson -Encoding utf8
Write-Host "✅ Generated all iOS AppIcon variants and updated Contents.json successfully"
