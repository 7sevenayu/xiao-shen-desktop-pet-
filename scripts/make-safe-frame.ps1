
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Drawing.Common -ErrorAction Stop } catch { Add-Type -AssemblyName System.Drawing -ErrorAction Stop }
$srcPath = 'E:\node\desktop-pet\assets\pet.jpg'
$outPath = 'E:\node\desktop-pet\assets\pet-safe.png'
$src = [System.Drawing.Image]::FromFile($srcPath)
Write-Output ("orig: {0}x{1}" -f $src.Width, $src.Height)
$cropL = [int]($src.Width * 0.20)
$cropW = $src.Width - $cropL
$cropH = $src.Height
$canvas = 2048
$charH = 0.60 * $cropH
$targetCharH = 0.56 * $canvas
$scaleH = $targetCharH / $charH
$scaleW = (0.92 * $canvas) / $cropW
$scale = [math]::Min($scaleH, $scaleW)
$newW = [int]($cropW * $scale)
$newH = [int]($cropH * $scale)
$offX = [int](($canvas - $newW) / 2)
$headTopDst = [int](0.22 * $canvas)
$offY = $headTopDst - [int](0.20 * $cropH * $scale)
$bmp = New-Object System.Drawing.Bitmap($canvas, $canvas)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$destRect = New-Object System.Drawing.Rectangle($offX, $offY, $newW, $newH)
$srcRect = New-Object System.Drawing.Rectangle($cropL, 0, $cropW, $cropH)
$g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
Write-Output ("safe: {0}x{0}, scale={1}, offset=({2},{3}), crop={4}x{5} left={6}" -f $canvas, $scale, $offX, $offY, $cropW, $cropH, $cropL)
