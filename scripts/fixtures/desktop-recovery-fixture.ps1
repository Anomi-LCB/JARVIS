param([string]$Title,[string]$OutputPath,[string]$ReadyPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$script:saveFails=$true
$form=New-Object System.Windows.Forms.Form
$form.Text=$Title;$form.Width=620;$form.Height=410
$form.Tag=@{output=$OutputPath;title=$Title}
$form.StartPosition='CenterScreen'
$input=New-Object System.Windows.Forms.TextBox
$input.Name='Input';$input.SetBounds(20,20,550,30)
$status=New-Object System.Windows.Forms.TextBox
$status.Name='Status';$status.Text='WAITING';$status.SetBounds(20,60,550,30)
$form.Controls.Add($input);$form.Controls.Add($status)
function Button([string]$Name,[string]$Text,[int]$X,[int]$Y){
 $b=New-Object System.Windows.Forms.Button;$b.Name=$Name;$b.Text=$Text;$b.SetBounds($X,$Y,170,36);$form.Controls.Add($b);return $b
}
$save=Button 'Save' 'Save' 20 110
$save.Add_Click({
 if($script:saveFails){$status.Text='SAVE_FAILED';return}
 $owner=$this.FindForm();[System.IO.File]::WriteAllText($owner.Tag.output,$owner.Controls['Input'].Text);$status.Text='SAVED'
})
$enable=Button 'EnableSave' 'Enable save' 210 110
$enable.Add_Click({$script:saveFails=$false;$status.Text='READY'})
$mutate=Button 'MoveSave' 'Change save button' 400 110
$mutate.Add_Click({$save.Name='SaveV2';$save.Left=210;$save.Top=290;$status.Text='UI_CHANGED'})
$popup=Button 'OpenPopup' 'Confirmation popup' 20 160
$script:dialog=New-Object System.Windows.Forms.Form;$script:dialog.Text="$Title Popup";$script:dialog.Width=350;$script:dialog.Height=170
$confirm=New-Object System.Windows.Forms.Button;$confirm.Name='Confirm';$confirm.Text='Confirm';$confirm.SetBounds(50,40,180,36)
$confirm.Add_Click({$this.FindForm().Hide()})
$script:dialog.Controls.Add($confirm)
$popup.Add_Click({
 $script:dialog.ShowDialog($this.FindForm())|Out-Null;$status.Text='CONFIRMED'
})
$second=Button 'OpenSecond' 'Second window' 210 160
$script:extra=New-Object System.Windows.Forms.Form;$script:extra.Text="$Title Second";$script:extra.Width=350;$script:extra.Height=170
$close=New-Object System.Windows.Forms.Button;$close.Name='CloseSecond';$close.Text='Close';$close.SetBounds(50,40,180,36)
$close.Add_Click({$this.FindForm().Hide()});$script:extra.Controls.Add($close)
$second.Add_Click({
 $script:extra.Show($this.FindForm())
})
$a=Button 'Duplicate' 'Duplicate' 20 210
$b=Button 'Duplicate' 'Duplicate' 210 210
$a.Add_Click({$status.Text='FIRST_SELECTED'})
$b.Add_Click({$status.Text='SECOND_SELECTED'})
$form.Add_Shown({[System.IO.File]::WriteAllText($ReadyPath,'READY')})
[System.Windows.Forms.Application]::Run($form)
