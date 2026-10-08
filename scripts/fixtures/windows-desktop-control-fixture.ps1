param(
  [string]$Title = 'JARVIS Desktop Control Fixture',
  [string]$TemplatePath = '',
  [switch]$DuplicateIcon,
  [switch]$EnableDuplicateAfterClick
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Name = 'JarvisDesktopControlFixture'
$form.Tag = $Title
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520, 390)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false

$input = New-Object System.Windows.Forms.TextBox
$input.Name = 'CommandInput'
$input.AccessibleName = 'Command Input'
$input.Location = New-Object System.Drawing.Point(24, 28)
$input.Size = New-Object System.Drawing.Size(456, 28)

$apply = New-Object System.Windows.Forms.Button
$apply.Name = 'ApplyButton'
$apply.AccessibleName = 'Apply Command'
$apply.Text = 'Apply'
$apply.Location = New-Object System.Drawing.Point(24, 76)
$apply.Size = New-Object System.Drawing.Size(120, 36)

$status = New-Object System.Windows.Forms.TextBox
$status.Name = 'StatusLabel'
$status.AccessibleName = 'Status Output'
$status.Text = 'WAITING'
$status.ReadOnly = $false
$status.TabStop = $false
$status.Location = New-Object System.Drawing.Point(168, 84)
$status.Size = New-Object System.Drawing.Size(312, 28)

$apply.Add_Click({
  $owner = $this.FindForm()
  $inputControl = $owner.Controls['CommandInput']
  $statusControl = $owner.Controls['StatusLabel']
  $statusControl.Text = $inputControl.Text
  $statusControl.AccessibleName = $inputControl.Text
  $statusControl.Refresh()
  $owner.Text = "$($owner.Tag) | $($inputControl.Text)"
})

# UI Automation 이름을 노출하지 않는 캔버스형 표면이다. OCR 폐루프 검증용으로만 쓴다.
$visualSurface = New-Object System.Windows.Forms.Panel
$visualSurface.Name = 'VisualCanvas'
$visualSurface.Location = New-Object System.Drawing.Point(24, 136)
$visualSurface.Size = New-Object System.Drawing.Size(456, 64)
$visualSurface.BackColor = [System.Drawing.Color]::FromArgb(19, 31, 43)
$visualSurface.Cursor = [System.Windows.Forms.Cursors]::Hand
$visualFont = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$visualSurface.Add_Paint({
  param($sender, $eventArgs)
  $eventArgs.Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $eventArgs.Graphics.DrawString('VISUAL APPLY', $visualFont, [System.Drawing.Brushes]::White, 118, 12)
})
$visualSurface.Add_MouseClick({
  $owner = $this.FindForm()
  $inputControl = $owner.Controls['CommandInput']
  $statusControl = $owner.Controls['StatusLabel']
  $statusControl.Text = 'VISUAL_DONE'
  $statusControl.AccessibleName = 'VISUAL_DONE'
  $statusControl.Refresh()
  $owner.Text = "$($owner.Tag) | $($inputControl.Text) | VISUAL_DONE"
})

# 글자와 UI Automation 이름이 없는 로컬 템플릿 매칭 검증용 표면이다.
$iconTemplate = New-Object System.Drawing.Bitmap(48, 48, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$iconGraphics = [System.Drawing.Graphics]::FromImage($iconTemplate)
$iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$iconGraphics.Clear([System.Drawing.Color]::FromArgb(19, 31, 43))
$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 232, 196), 5)
$markPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(232, 244, 241), 5)
$ringPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$ringPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$iconGraphics.DrawArc($ringPen, 6, 6, 36, 36, 35, 285)
$iconGraphics.DrawLine($markPen, 15, 25, 22, 32)
$iconGraphics.DrawLine($markPen, 22, 32, 35, 17)
$iconGraphics.Dispose()
$ringPen.Dispose()
$markPen.Dispose()
if (![string]::IsNullOrWhiteSpace($TemplatePath)) {
  $templateDirectory = Split-Path -Parent $TemplatePath
  if ($templateDirectory) { [System.IO.Directory]::CreateDirectory($templateDirectory) | Out-Null }
  $iconTemplate.Save($TemplatePath, [System.Drawing.Imaging.ImageFormat]::Png)
}

$iconSurface = New-Object System.Windows.Forms.Panel
$iconSurface.Name = 'IconCanvas'
$iconSurface.Location = New-Object System.Drawing.Point(24, 216)
$iconSurface.Size = New-Object System.Drawing.Size(456, 80)
$iconSurface.BackColor = [System.Drawing.Color]::FromArgb(19, 31, 43)
$iconSurface.Cursor = [System.Windows.Forms.Cursors]::Hand
$script:RenderDuplicateIcon = [bool]$DuplicateIcon
$iconSurface.Add_Paint({
  param($sender, $eventArgs)
  if ($script:RenderDuplicateIcon) {
    $eventArgs.Graphics.DrawImageUnscaled($iconTemplate, 84, 16)
    $eventArgs.Graphics.DrawImageUnscaled($iconTemplate, 324, 16)
  } else {
    $eventArgs.Graphics.DrawImageUnscaled($iconTemplate, 204, 16)
  }
})
$iconSurface.Add_MouseClick({
  $owner = $this.FindForm()
  $inputControl = $owner.Controls['CommandInput']
  $statusControl = $owner.Controls['StatusLabel']
  $statusControl.Text = 'ICON_DONE'
  $statusControl.AccessibleName = 'ICON_DONE'
  $statusControl.Refresh()
  $owner.Text = "$($owner.Tag) | $($inputControl.Text) | VISUAL_DONE | ICON_DONE"
  if ($EnableDuplicateAfterClick) {
    $script:RenderDuplicateIcon = $true
    $this.Invalidate()
    $this.Update()
  }
})
$form.Add_FormClosed({
  $iconTemplate.Dispose()
  $visualFont.Dispose()
})

$form.Controls.Add($input)
$form.Controls.Add($apply)
$form.Controls.Add($status)
$form.Controls.Add($visualSurface)
$form.Controls.Add($iconSurface)
[System.Windows.Forms.Application]::Run($form)
