import { desktopFeatures } from './desktop-features.js';

function renderFeaturePage() {
  return `<Grid x:Name="FeaturesPage" Visibility="Collapsed"><StackPanel>
    <Border Style="{StaticResource PanelStyle}" Margin="0,0,0,12"><StackPanel>
      <TextBlock Text="기능과 연결 관리" Style="{StaticResource SectionHeadingStyle}" />
      <TextBlock Text="기능을 선택하면 이 앱 안에서 실제 설정 화면이 열립니다. 계정·기기 연결과 검증 여부는 각 화면에서 별도로 확인하세요." TextWrapping="Wrap" Style="{StaticResource CaptionStyle}" Margin="0,8,0,12" />
      <TextBlock x:Name="FeatureConnectionText" Text="제어센터 연결 확인 중" Margin="0,0,0,12" />
      <Label Target="{Binding ElementName=FeatureSearchInput}" Content="기능 검색" />
      <TextBox x:Name="FeatureSearchInput" MinHeight="36" Padding="8" AutomationProperties.Name="기능 검색" />
      <Button x:Name="FeatureRefreshButton" Content="연결 상태 다시 확인" Style="{StaticResource SecondaryButtonStyle}" HorizontalAlignment="Left" Margin="0,12,0,0" />
    </StackPanel></Border>
    ${desktopFeatures.map(f => `<Border x:Name="FeatureCard_${f.id}" Style="{StaticResource PanelStyle}" Margin="0,0,0,10" Padding="20,16"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="48"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <TextBlock Text="&#x${f.glyph};" FontFamily="Segoe MDL2 Assets" FontSize="22" Foreground="{StaticResource AccentBrush}" VerticalAlignment="Center" />
      <StackPanel Grid.Column="1" Margin="0,0,12,0"><TextBlock Text="${f.title}" Style="{StaticResource SectionHeadingStyle}"/><TextBlock Text="${f.detail}" Style="{StaticResource CaptionStyle}" TextWrapping="Wrap" Margin="0,6,0,0"/></StackPanel>
      <Button x:Name="FeatureOpen_${f.id}" Grid.Column="2" Content="열기·조절" AutomationProperties.Name="${f.title} 열기·조절" Style="{StaticResource SecondaryButtonStyle}" VerticalAlignment="Center"/>
    </Grid></Border>`).join('\n')}
    <TextBlock x:Name="FeatureNoResultsText" Text="일치하는 기능이 없습니다." Visibility="Collapsed" Margin="12"/>
  </StackPanel></Grid>`;
}

export function renderTrayAgentXaml() {
  return String.raw`<Window
  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  x:Name="RootWindow"
  Title="JARVIS PC 에이전트"
  Width="1240"
  Height="820"
  MinWidth="1040"
  MinHeight="720"
  WindowStartupLocation="CenterScreen"
  Background="#F2F5F9"
  Foreground="#172235"
  FontFamily="Segoe UI Variable Text, Malgun Gothic"
  TextOptions.TextFormattingMode="Display"
  UseLayoutRounding="True"
  SnapsToDevicePixels="True">
  <Window.Resources>
    <LinearGradientBrush x:Key="CanvasBrush" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Color="#F7FAFD" Offset="0" />
      <GradientStop Color="#F2F7F7" Offset="0.46" />
      <GradientStop Color="#F7F4FB" Offset="1" />
    </LinearGradientBrush>
    <SolidColorBrush x:Key="SidebarBrush" Color="#E8FFFFFF" />
    <SolidColorBrush x:Key="SurfaceBrush" Color="#DFFFFFFF" />
    <SolidColorBrush x:Key="RaisedBrush" Color="#B8FFFFFF" />
    <SolidColorBrush x:Key="HoverBrush" Color="#DDF4F8F8" />
    <SolidColorBrush x:Key="PressedBrush" Color="#CFE8F1F0" />
    <SolidColorBrush x:Key="LineBrush" Color="#A8D7DFE7" />
    <SolidColorBrush x:Key="LineStrongBrush" Color="#B7C6D1DC" />
    <SolidColorBrush x:Key="PrimaryTextBrush" Color="#172235" />
    <SolidColorBrush x:Key="SecondaryTextBrush" Color="#52657C" />
    <SolidColorBrush x:Key="MutedTextBrush" Color="#8493A5" />
    <SolidColorBrush x:Key="AccentBrush" Color="#128D7B" />
    <SolidColorBrush x:Key="AccentHoverBrush" Color="#087968" />
    <SolidColorBrush x:Key="AccentPressedBrush" Color="#076356" />
    <SolidColorBrush x:Key="AccentSoftBrush" Color="#DDF5EF" />
    <SolidColorBrush x:Key="NavActiveBrush" Color="#E5F3EF" />
    <SolidColorBrush x:Key="WarningBrush" Color="#D18A31" />
    <SolidColorBrush x:Key="WarningSoftBrush" Color="#FDF0DB" />
    <SolidColorBrush x:Key="DangerBrush" Color="#C86478" />
    <SolidColorBrush x:Key="DangerSoftBrush" Color="#F9E6EC" />
    <SolidColorBrush x:Key="InfoBrush" Color="#557DB5" />
    <SolidColorBrush x:Key="InfoSoftBrush" Color="#E7F0FA" />
    <SolidColorBrush x:Key="LavenderSoftBrush" Color="#EDE9F8" />
    <SolidColorBrush x:Key="SkySoftBrush" Color="#E6F2F8" />
    <SolidColorBrush x:Key="RoseSoftBrush" Color="#F8E9EE" />
    <SolidColorBrush x:Key="MintSoftBrush" Color="#E1F4ED" />
    <SolidColorBrush x:Key="WhiteBrush" Color="#FFFFFF" />
    <LinearGradientBrush x:Key="HeroBrush" StartPoint="0,0" EndPoint="1,0">
      <GradientStop Color="#CFEFE9" Offset="0" />
      <GradientStop Color="#EAF5F7" Offset="0.48" />
      <GradientStop Color="#EEEAF8" Offset="1" />
    </LinearGradientBrush>
    <LinearGradientBrush x:Key="PrimaryActionBrush" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Color="#11957F" Offset="0" />
      <GradientStop Color="#138C88" Offset="0.58" />
      <GradientStop Color="#397FA2" Offset="1" />
    </LinearGradientBrush>
    <DropShadowEffect x:Key="GlassShadow" Color="#35566F" BlurRadius="22" ShadowDepth="4" Opacity="0.08" />

    <Style x:Key="PageHeadingStyle" TargetType="{x:Type TextBlock}">
      <Setter Property="FontSize" Value="18" />
      <Setter Property="FontWeight" Value="SemiBold" />
      <Setter Property="Foreground" Value="{StaticResource PrimaryTextBrush}" />
    </Style>

    <Style x:Key="SectionHeadingStyle" TargetType="{x:Type TextBlock}">
      <Setter Property="FontSize" Value="14.5" />
      <Setter Property="FontWeight" Value="SemiBold" />
      <Setter Property="Foreground" Value="{StaticResource PrimaryTextBrush}" />
    </Style>

    <Style x:Key="CaptionStyle" TargetType="{x:Type TextBlock}">
      <Setter Property="FontSize" Value="10.5" />
      <Setter Property="Foreground" Value="{StaticResource SecondaryTextBrush}" />
    </Style>

    <Style x:Key="PanelStyle" TargetType="{x:Type Border}">
      <Setter Property="Background" Value="{StaticResource SurfaceBrush}" />
      <Setter Property="BorderBrush" Value="{StaticResource LineBrush}" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="CornerRadius" Value="8" />
      <Setter Property="Padding" Value="22" />
      <Setter Property="Effect" Value="{StaticResource GlassShadow}" />
    </Style>

    <Style x:Key="MetricStyle" TargetType="{x:Type Border}">
      <Setter Property="Background" Value="Transparent" />
      <Setter Property="BorderBrush" Value="Transparent" />
      <Setter Property="BorderThickness" Value="0" />
      <Setter Property="CornerRadius" Value="8" />
      <Setter Property="Padding" Value="18,15" />
    </Style>

    <Style x:Key="SecondaryButtonStyle" TargetType="{x:Type Button}">
      <Setter Property="MinHeight" Value="46" />
      <Setter Property="MinWidth" Value="104" />
      <Setter Property="Padding" Value="15,0" />
      <Setter Property="Margin" Value="0" />
      <Setter Property="Foreground" Value="{StaticResource PrimaryTextBrush}" />
      <Setter Property="Background" Value="#AFFFFFFF" />
      <Setter Property="BorderBrush" Value="{StaticResource LineStrongBrush}" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="FontSize" Value="12" />
      <Setter Property="FontWeight" Value="SemiBold" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="HorizontalContentAlignment" Value="Center" />
      <Setter Property="VerticalContentAlignment" Value="Center" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type Button}">
            <Border x:Name="Chrome" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8" SnapsToDevicePixels="True">
              <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="{TemplateBinding VerticalContentAlignment}" Margin="{TemplateBinding Padding}" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="{StaticResource HoverBrush}" />
                <Setter TargetName="Chrome" Property="BorderBrush" Value="{StaticResource AccentBrush}" />
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="{StaticResource PressedBrush}" />
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.42" />
                <Setter Property="Cursor" Value="Arrow" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="PrimaryButtonStyle" TargetType="{x:Type Button}" BasedOn="{StaticResource SecondaryButtonStyle}">
      <Setter Property="Foreground" Value="#FFFFFF" />
      <Setter Property="Background" Value="{StaticResource PrimaryActionBrush}" />
      <Setter Property="BorderBrush" Value="{StaticResource AccentBrush}" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type Button}">
            <Border x:Name="Chrome" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8" SnapsToDevicePixels="True">
              <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="{TemplateBinding VerticalContentAlignment}" Margin="{TemplateBinding Padding}" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="{StaticResource AccentHoverBrush}" />
                <Setter TargetName="Chrome" Property="BorderBrush" Value="{StaticResource AccentHoverBrush}" />
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="{StaticResource AccentPressedBrush}" />
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.42" />
                <Setter Property="Cursor" Value="Arrow" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="NavButtonStyle" TargetType="{x:Type Button}">
      <Setter Property="Height" Value="50" />
      <Setter Property="Margin" Value="0,3" />
      <Setter Property="Padding" Value="16,0" />
      <Setter Property="Foreground" Value="{StaticResource SecondaryTextBrush}" />
      <Setter Property="Background" Value="Transparent" />
      <Setter Property="BorderThickness" Value="0" />
      <Setter Property="FontSize" Value="12.5" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="HorizontalContentAlignment" Value="Left" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type Button}">
            <Grid>
              <Border x:Name="Chrome" Background="{TemplateBinding Background}" CornerRadius="8">
                <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center" Margin="{TemplateBinding Padding}" />
              </Border>
              <Border x:Name="ActiveRail" Width="3" Height="28" Background="{StaticResource AccentBrush}" CornerRadius="0,3,3,0" HorizontalAlignment="Left" Opacity="0" />
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="{StaticResource HoverBrush}" />
                <Setter Property="Foreground" Value="{StaticResource PrimaryTextBrush}" />
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="{StaticResource PressedBrush}" />
              </Trigger>
              <Trigger Property="Tag" Value="active">
                <Setter TargetName="ActiveRail" Property="Opacity" Value="1" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="IconButtonStyle" TargetType="{x:Type Button}" BasedOn="{StaticResource SecondaryButtonStyle}">
      <Setter Property="MinHeight" Value="0" />
      <Setter Property="Width" Value="38" />
      <Setter Property="Height" Value="38" />
      <Setter Property="MinWidth" Value="38" />
      <Setter Property="Padding" Value="0" />
      <Setter Property="FontFamily" Value="Segoe MDL2 Assets" />
      <Setter Property="FontSize" Value="15" />
    </Style>

    <Style x:Key="ToggleStyle" TargetType="{x:Type CheckBox}">
      <Setter Property="Width" Value="46" />
      <Setter Property="Height" Value="26" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type CheckBox}">
            <Grid Width="46" Height="26">
              <Border x:Name="Track" Background="{StaticResource LineStrongBrush}" CornerRadius="13" />
              <Border x:Name="Thumb" Width="20" Height="20" Background="#F7FFFFFF" BorderBrush="#90B8C4CE" BorderThickness="1" CornerRadius="10" HorizontalAlignment="Left" Margin="3" />
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Track" Property="Background" Value="{StaticResource AccentBrush}" />
                <Setter TargetName="Thumb" Property="HorizontalAlignment" Value="Right" />
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Track" Property="Opacity" Value="0.86" />
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.42" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="ActivityItemStyle" TargetType="{x:Type ListBoxItem}">
      <Setter Property="Foreground" Value="{StaticResource SecondaryTextBrush}" />
      <Setter Property="FontFamily" Value="Segoe UI Variable Text, Malgun Gothic" />
      <Setter Property="FontSize" Value="10.5" />
      <Setter Property="Padding" Value="10,8" />
      <Setter Property="BorderBrush" Value="{StaticResource LineBrush}" />
      <Setter Property="BorderThickness" Value="0,0,0,1" />
      <Setter Property="HorizontalContentAlignment" Value="Stretch" />
      <Setter Property="IsHitTestVisible" Value="False" />
      <Setter Property="Focusable" Value="False" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type ListBoxItem}">
            <Border x:Name="Row" Background="#70FFFFFF" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" Padding="{TemplateBinding Padding}" CornerRadius="6">
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition Width="18" /><ColumnDefinition Width="*" /><ColumnDefinition Width="20" /></Grid.ColumnDefinitions>
                <Ellipse Width="11" Height="11" Fill="{StaticResource AccentBrush}" HorizontalAlignment="Left" VerticalAlignment="Center" />
                <TextBlock Grid.Column="0" Text="&#xE73E;" FontFamily="Segoe MDL2 Assets" FontSize="7" Foreground="#FFFFFF" HorizontalAlignment="Center" VerticalAlignment="Center" />
                <ContentPresenter Grid.Column="1" VerticalAlignment="Center" Margin="4,0,0,0" />
                <TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" Foreground="{StaticResource MutedTextBrush}" HorizontalAlignment="Right" VerticalAlignment="Center" />
              </Grid>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="CompactMetricStyle" TargetType="{x:Type Border}" BasedOn="{StaticResource MetricStyle}">
      <Setter Property="Padding" Value="16,14" />
      <Setter Property="Effect" Value="{x:Null}" />
    </Style>

    <Style x:Key="StatusChipStyle" TargetType="{x:Type Border}">
      <Setter Property="Background" Value="#AFFFFFFF" />
      <Setter Property="BorderBrush" Value="{StaticResource LineBrush}" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="CornerRadius" Value="8" />
      <Setter Property="Padding" Value="11,8" />
    </Style>

    <Style x:Key="SettingsRowStyle" TargetType="{x:Type Border}">
      <Setter Property="BorderBrush" Value="{StaticResource LineBrush}" />
      <Setter Property="BorderThickness" Value="0,0,0,1" />
      <Setter Property="Padding" Value="0,14" />
    </Style>

    <Style x:Key="ComboBoxStyle" TargetType="{x:Type ComboBox}">
      <Setter Property="Height" Value="38" />
      <Setter Property="MinWidth" Value="112" />
      <Setter Property="Padding" Value="12,0" />
      <Setter Property="Background" Value="#C9FFFFFF" />
      <Setter Property="Foreground" Value="{StaticResource PrimaryTextBrush}" />
      <Setter Property="BorderBrush" Value="{StaticResource LineStrongBrush}" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="FontSize" Value="12" />
      <Setter Property="ItemContainerStyle">
        <Setter.Value>
          <Style TargetType="{x:Type ComboBoxItem}">
            <Setter Property="Padding" Value="11,8" />
            <Setter Property="Foreground" Value="{StaticResource PrimaryTextBrush}" />
            <Setter Property="Background" Value="Transparent" />
            <Setter Property="HorizontalContentAlignment" Value="Stretch" />
            <Setter Property="Template">
              <Setter.Value>
                <ControlTemplate TargetType="{x:Type ComboBoxItem}">
                  <Border x:Name="ItemChrome" Background="{TemplateBinding Background}" CornerRadius="6" Padding="{TemplateBinding Padding}">
                    <ContentPresenter />
                  </Border>
                  <ControlTemplate.Triggers>
                    <Trigger Property="IsHighlighted" Value="True"><Setter TargetName="ItemChrome" Property="Background" Value="{StaticResource HoverBrush}" /></Trigger>
                    <Trigger Property="IsSelected" Value="True"><Setter TargetName="ItemChrome" Property="Background" Value="{StaticResource AccentSoftBrush}" /><Setter Property="Foreground" Value="{StaticResource AccentBrush}" /></Trigger>
                  </ControlTemplate.Triggers>
                </ControlTemplate>
              </Setter.Value>
            </Setter>
          </Style>
        </Setter.Value>
      </Setter>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type ComboBox}">
            <Grid>
              <ToggleButton x:Name="DropDownToggle" Focusable="False" ClickMode="Press" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}">
                <ToggleButton.Template>
                  <ControlTemplate TargetType="{x:Type ToggleButton}">
                    <Border x:Name="ComboChrome" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8">
                      <Grid>
                        <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="34" /></Grid.ColumnDefinitions>
                        <ContentPresenter Margin="12,0,0,0" VerticalAlignment="Center" HorizontalAlignment="Left" Content="{Binding SelectionBoxItem, RelativeSource={RelativeSource AncestorType={x:Type ComboBox}}}" />
                        <TextBlock Grid.Column="1" Text="&#xE70D;" FontFamily="Segoe MDL2 Assets" FontSize="9" Foreground="{StaticResource SecondaryTextBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" />
                      </Grid>
                    </Border>
                    <ControlTemplate.Triggers>
                      <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ComboChrome" Property="BorderBrush" Value="{StaticResource AccentBrush}" /><Setter TargetName="ComboChrome" Property="Background" Value="{StaticResource HoverBrush}" /></Trigger>
                      <Trigger Property="IsChecked" Value="True"><Setter TargetName="ComboChrome" Property="BorderBrush" Value="{StaticResource AccentBrush}" /></Trigger>
                    </ControlTemplate.Triggers>
                  </ControlTemplate>
                </ToggleButton.Template>
              </ToggleButton>
              <Popup x:Name="PART_Popup" Placement="Bottom" VerticalOffset="4" AllowsTransparency="True" Focusable="False" PopupAnimation="Fade" IsOpen="{TemplateBinding IsDropDownOpen}">
                <Border MinWidth="{Binding ActualWidth, RelativeSource={RelativeSource TemplatedParent}}" MaxHeight="220" Padding="4" Background="#F7FFFFFF" BorderBrush="{StaticResource LineStrongBrush}" BorderThickness="1" CornerRadius="8" Effect="{StaticResource GlassShadow}">
                  <ScrollViewer VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" CanContentScroll="True"><ItemsPresenter /></ScrollViewer>
                </Border>
              </Popup>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="ActionRowButtonStyle" TargetType="{x:Type Button}" BasedOn="{StaticResource SecondaryButtonStyle}">
      <Setter Property="MinHeight" Value="0" />
      <Setter Property="Height" Value="46" />
      <Setter Property="MinWidth" Value="0" />
      <Setter Property="Padding" Value="14,0" />
      <Setter Property="HorizontalContentAlignment" Value="Stretch" />
      <Setter Property="Background" Value="#72FFFFFF" />
      <Setter Property="FontWeight" Value="Normal" />
    </Style>

    <Style x:Key="LogTextBoxStyle" TargetType="{x:Type TextBox}">
      <Setter Property="Padding" Value="14,11" />
      <Setter Property="Background" Value="#78FFFFFF" />
      <Setter Property="Foreground" Value="{StaticResource SecondaryTextBrush}" />
      <Setter Property="BorderBrush" Value="{StaticResource LineBrush}" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="FontFamily" Value="Cascadia Mono, Consolas" />
      <Setter Property="FontSize" Value="10.5" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type TextBox}">
            <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="7" Padding="{TemplateBinding Padding}">
              <ScrollViewer x:Name="PART_ContentHost" />
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="ScrollPageButtonStyle" TargetType="{x:Type RepeatButton}">
      <Setter Property="Background" Value="Transparent" />
      <Setter Property="BorderThickness" Value="0" />
      <Setter Property="Focusable" Value="False" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type RepeatButton}">
            <Border Background="Transparent" />
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="ScrollThumbStyle" TargetType="{x:Type Thumb}">
      <Setter Property="MinHeight" Value="36" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type Thumb}">
            <Border x:Name="ThumbChrome" Background="#68859AAA" CornerRadius="3" Margin="1,0" />
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="ThumbChrome" Property="Background" Value="#A0128D7B" />
              </Trigger>
              <Trigger Property="IsDragging" Value="True">
                <Setter TargetName="ThumbChrome" Property="Background" Value="{StaticResource AccentBrush}" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="{x:Type ScrollBar}">
      <Setter Property="Width" Value="8" />
      <Setter Property="MinWidth" Value="8" />
      <Setter Property="Background" Value="Transparent" />
      <Setter Property="Opacity" Value="0.72" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type ScrollBar}">
            <Grid Background="Transparent" Margin="1,4">
              <Track x:Name="PART_Track" Orientation="{TemplateBinding Orientation}" IsDirectionReversed="True" Focusable="False">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Style="{StaticResource ScrollPageButtonStyle}" Command="{x:Static ScrollBar.PageUpCommand}" />
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb Style="{StaticResource ScrollThumbStyle}" />
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Style="{StaticResource ScrollPageButtonStyle}" Command="{x:Static ScrollBar.PageDownCommand}" />
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
      <Style.Triggers>
        <Trigger Property="Orientation" Value="Horizontal">
          <Setter Property="Width" Value="Auto" />
          <Setter Property="MinWidth" Value="0" />
          <Setter Property="Height" Value="8" />
        </Trigger>
      </Style.Triggers>
    </Style>
  </Window.Resources>

  <Grid Background="{StaticResource CanvasBrush}">
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="224" />
      <ColumnDefinition Width="*" />
    </Grid.ColumnDefinitions>

    <Border Grid.Column="0" Background="{StaticResource SidebarBrush}" BorderBrush="#80FFFFFF" BorderThickness="0,0,1,0">
      <Grid Margin="18,0">
        <Grid.RowDefinitions>
          <RowDefinition Height="118" />
          <RowDefinition Height="*" />
          <RowDefinition Height="132" />
        </Grid.RowDefinitions>

        <Grid Grid.Row="0" Margin="8,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="50" />
            <ColumnDefinition Width="*" />
          </Grid.ColumnDefinitions>
          <Border Width="42" Height="42" CornerRadius="21" Background="#AFFFFFFF" BorderBrush="{StaticResource AccentBrush}" BorderThickness="1.5" VerticalAlignment="Center">
            <TextBlock Text="J" FontFamily="Segoe UI Variable Display" FontSize="24" FontWeight="SemiBold" Foreground="{StaticResource AccentBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-2,0,0" />
          </Border>
          <StackPanel Grid.Column="1" VerticalAlignment="Center">
            <TextBlock Text="JARVIS" FontSize="17" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
            <TextBlock Text="PC 에이전트" Margin="0,3,0,0" FontSize="10.5" Foreground="{StaticResource SecondaryTextBrush}" />
          </StackPanel>
        </Grid>

        <StackPanel Grid.Row="1">
          <Button x:Name="NavOverviewButton" Style="{StaticResource NavButtonStyle}" Background="{StaticResource NavActiveBrush}" Foreground="{StaticResource AccentBrush}" AutomationProperties.Name="개요 화면">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="&#xE80F;" FontFamily="Segoe MDL2 Assets" FontSize="15" Width="28" VerticalAlignment="Center" />
              <TextBlock Text="개요" VerticalAlignment="Center" />
            </StackPanel>
          </Button>
          <Button x:Name="NavServiceButton" Style="{StaticResource NavButtonStyle}" AutomationProperties.Name="Windows 서비스 화면">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="&#xE9F3;" FontFamily="Segoe MDL2 Assets" FontSize="15" Width="28" VerticalAlignment="Center" />
              <TextBlock Text="Windows 서비스" VerticalAlignment="Center" />
            </StackPanel>
          </Button>
          <Button x:Name="NavDiagnosticsButton" Style="{StaticResource NavButtonStyle}" AutomationProperties.Name="진단 화면">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="&#xE9D9;" FontFamily="Segoe MDL2 Assets" FontSize="15" Width="28" VerticalAlignment="Center" />
              <TextBlock Text="진단" VerticalAlignment="Center" />
            </StackPanel>
          </Button>
          <Button x:Name="NavFeaturesButton" Style="{StaticResource NavButtonStyle}" AutomationProperties.Name="기능 및 연결 화면">
            <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE80F;" FontFamily="Segoe MDL2 Assets" FontSize="15" Width="28"/><TextBlock Text="기능·연결"/></StackPanel>
          </Button>
          <Button x:Name="NavSettingsButton" Style="{StaticResource NavButtonStyle}" AutomationProperties.Name="설정 화면">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="&#xE713;" FontFamily="Segoe MDL2 Assets" FontSize="15" Width="28" VerticalAlignment="Center" />
              <TextBlock Text="설정" VerticalAlignment="Center" />
            </StackPanel>
          </Button>
        </StackPanel>

        <Border Grid.Row="2" BorderBrush="{StaticResource LineBrush}" BorderThickness="0,1,0,0" Padding="9,18,9,0">
          <StackPanel>
            <TextBlock Text="로컬 운영" FontSize="9" FontWeight="SemiBold" Foreground="{StaticResource MutedTextBrush}" Margin="0,0,0,10" />
            <StackPanel Orientation="Horizontal">
              <Ellipse x:Name="SidebarStatusDot" Width="8" Height="8" Fill="{StaticResource WarningBrush}" Margin="0,0,9,0" VerticalAlignment="Center" />
              <TextBlock x:Name="SidebarStatusText" Text="상태 확인 중" FontSize="11" FontWeight="SemiBold" Foreground="{StaticResource SecondaryTextBrush}" VerticalAlignment="Center" TextTrimming="CharacterEllipsis" />
            </StackPanel>
            <TextBlock Text="이 장치 안에서만 실행" Margin="17,7,0,0" FontSize="9" Foreground="{StaticResource MutedTextBrush}" />
            <TextBlock Text="PC 기능 센터 · 설치 상태는 진단에서 확인" Margin="0,28,0,0" FontSize="9" Foreground="{StaticResource MutedTextBrush}" TextWrapping="Wrap" />
          </StackPanel>
        </Border>
      </Grid>
    </Border>

    <Grid Grid.Column="1">
      <Grid.RowDefinitions>
        <RowDefinition Height="92" />
        <RowDefinition Height="0" />
        <RowDefinition Height="*" />
        <RowDefinition Height="46" />
      </Grid.RowDefinitions>

      <Border Grid.Row="0" Background="#56FFFFFF" BorderBrush="#70FFFFFF" BorderThickness="0,0,0,1" Padding="38,0,32,0">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="Auto" />
          </Grid.ColumnDefinitions>
          <StackPanel VerticalAlignment="Center">
            <TextBlock x:Name="PageTitleText" Text="에이전트 개요" FontSize="23" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
            <TextBlock x:Name="PageSubtitleText" Text="실행 상태와 주요 작업을 한눈에 확인합니다." Margin="0,7,0,0" FontSize="10.5" Foreground="{StaticResource SecondaryTextBrush}" />
          </StackPanel>
          <Button x:Name="RefreshButton" Grid.Column="1" Style="{StaticResource IconButtonStyle}" Content="&#xE72C;" ToolTip="상태 새로고침 (F5)" AutomationProperties.Name="상태 새로고침" VerticalAlignment="Center" />
          <ProgressBar x:Name="BusyBar" Grid.ColumnSpan="2" Height="2" VerticalAlignment="Bottom" Margin="0,0,0,-1" IsIndeterminate="True" Visibility="Collapsed" Foreground="{StaticResource AccentBrush}" Background="Transparent" />
        </Grid>
      </Border>

      <Border x:Name="NoticeBorder" Grid.Row="2" Panel.ZIndex="20" Visibility="Collapsed" Width="470" Margin="0,0,28,18" Padding="15,12" HorizontalAlignment="Right" VerticalAlignment="Bottom" Background="#F2E7F6F2" BorderBrush="{StaticResource InfoBrush}" BorderThickness="1" CornerRadius="8" Effect="{StaticResource GlassShadow}">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="28" />
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="32" />
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="NoticeIconText" Text="&#xE946;" FontFamily="Segoe MDL2 Assets" FontSize="14" Foreground="{StaticResource InfoBrush}" VerticalAlignment="Top" Margin="1,2,0,0" />
          <StackPanel Grid.Column="1">
            <TextBlock x:Name="NoticeTitleText" Text="알림" FontSize="11" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
            <TextBlock x:Name="NoticeBodyText" Text="상세 내용" Margin="0,3,0,0" FontSize="10" Foreground="{StaticResource SecondaryTextBrush}" TextWrapping="Wrap" />
          </StackPanel>
          <Button x:Name="NoticeDismissButton" Grid.Column="2" Style="{StaticResource IconButtonStyle}" Width="28" Height="28" MinWidth="28" Content="&#xE711;" ToolTip="알림 닫기" AutomationProperties.Name="알림 닫기" />
        </Grid>
      </Border>

      <ScrollViewer x:Name="ContentScroll" Grid.Row="2" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto" HorizontalContentAlignment="Stretch" PanningMode="VerticalOnly" Padding="38,0,16,0">
        <Grid>
          <Grid x:Name="OverviewPage" MinHeight="618">
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="*" />
            </Grid.RowDefinitions>

            <Border Grid.Row="0" Style="{StaticResource PanelStyle}" Background="{StaticResource HeroBrush}" Padding="0" MinHeight="122" Margin="0,0,0,12">
              <Grid>
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="112" />
                  <ColumnDefinition Width="*" />
                  <ColumnDefinition Width="224" />
                </Grid.ColumnDefinitions>
                <Border Background="#4AFFFFFF" BorderBrush="#72FFFFFF" BorderThickness="0,0,1,0" CornerRadius="8,0,0,8">
                  <Border Width="64" Height="64" CornerRadius="32" Background="#8FFFFFFF" BorderBrush="{StaticResource AccentBrush}" BorderThickness="2" HorizontalAlignment="Center" VerticalAlignment="Center">
                    <TextBlock Text="&#xE73E;" FontFamily="Segoe MDL2 Assets" FontSize="28" Foreground="{StaticResource AccentBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" />
                  </Border>
                </Border>
                <StackPanel Grid.Column="1" Margin="22,0" VerticalAlignment="Center">
                  <TextBlock Text="현재 작업 환경" FontSize="9.5" FontWeight="SemiBold" Foreground="{StaticResource SecondaryTextBrush}" />
                  <TextBlock x:Name="OverviewStatusText" Text="작업 환경을 확인하고 있습니다" Margin="0,7,0,0" FontSize="22" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" TextTrimming="CharacterEllipsis" />
                  <TextBlock x:Name="OverviewStatusDetailText" Text="에이전트와 제어 센터의 준비 상태를 확인합니다." Margin="0,6,0,0" FontSize="10.5" Foreground="{StaticResource SecondaryTextBrush}" TextWrapping="Wrap" />
                  <StackPanel Orientation="Horizontal" Margin="0,9,0,0">
                    <Ellipse Width="7" Height="7" Fill="{StaticResource AccentBrush}" Margin="0,0,7,0" VerticalAlignment="Center" />
                    <TextBlock Text="로컬 런타임 연결" FontSize="9.5" FontWeight="SemiBold" Foreground="{StaticResource AccentBrush}" />
                    <TextBlock Text="·" Margin="10,0" FontSize="9.5" Foreground="{StaticResource MutedTextBrush}" />
                    <TextBlock Text="승인 기반 실행" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" />
                  </StackPanel>
                </StackPanel>
                <Button x:Name="OpenConsoleButton" Grid.Column="2" Style="{StaticResource PrimaryButtonStyle}" Height="50" Margin="0,0,20,0" MinWidth="196" VerticalAlignment="Center" AutomationProperties.Name="JARVIS 제어 센터 열기">
                  <StackPanel Orientation="Horizontal">
                    <TextBlock Text="&#xE8A7;" FontFamily="Segoe MDL2 Assets" FontSize="14" Margin="0,0,9,0" />
                    <TextBlock Text="PC 작업 시작" />
                  </StackPanel>
                </Button>
              </Grid>
            </Border>

            <Border Grid.Row="1" Style="{StaticResource PanelStyle}" Padding="8,0" MinHeight="92" Margin="0,0,0,12">
              <Grid>
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="1.05*" /><ColumnDefinition Width="1" />
                  <ColumnDefinition Width="1*" /><ColumnDefinition Width="1" />
                  <ColumnDefinition Width="1*" /><ColumnDefinition Width="1" />
                  <ColumnDefinition Width="1.25*" />
                </Grid.ColumnDefinitions>
                <Border Grid.Column="0" Style="{StaticResource CompactMetricStyle}">
                  <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>
                    <Border Width="32" Height="32" CornerRadius="8" Background="{StaticResource MintSoftBrush}" VerticalAlignment="Center"><TextBlock Text="&#xE7F8;" FontFamily="Segoe MDL2 Assets" FontSize="15" Foreground="{StaticResource AccentBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" /></Border>
                    <StackPanel Grid.Column="1" Margin="8,0,0,0" VerticalAlignment="Center"><TextBlock Text="백그라운드 서비스" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="OverviewServiceValueText" Text="확인 중" Margin="0,6,0,0" FontSize="13.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" TextTrimming="CharacterEllipsis" /></StackPanel>
                  </Grid>
                </Border>
                <Border Grid.Column="1" Width="1" Background="{StaticResource LineBrush}" Margin="0,18" />
                <Border Grid.Column="2" Style="{StaticResource CompactMetricStyle}">
                  <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>
                    <Border Width="32" Height="32" CornerRadius="8" Background="{StaticResource SkySoftBrush}" VerticalAlignment="Center"><TextBlock Text="&#xE71B;" FontFamily="Segoe MDL2 Assets" FontSize="15" Foreground="{StaticResource InfoBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" /></Border>
                    <StackPanel Grid.Column="1" Margin="8,0,0,0" VerticalAlignment="Center"><TextBlock Text="작업 연결" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="OverviewApiValueText" Text="확인 중" Margin="0,6,0,0" FontSize="13.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" /></StackPanel>
                  </Grid>
                </Border>
                <Border Grid.Column="3" Width="1" Background="{StaticResource LineBrush}" Margin="0,18" />
                <Border Grid.Column="4" Style="{StaticResource CompactMetricStyle}">
                  <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>
                    <Border Width="32" Height="32" CornerRadius="8" Background="{StaticResource LavenderSoftBrush}" VerticalAlignment="Center"><TextBlock Text="&#xE9D9;" FontFamily="Segoe MDL2 Assets" FontSize="15" Foreground="#796CAB" HorizontalAlignment="Center" VerticalAlignment="Center" /></Border>
                    <StackPanel Grid.Column="1" Margin="8,0,0,0" VerticalAlignment="Center"><TextBlock Text="상태 확인 시간" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="OverviewCheckedValueText" Text="-" Margin="0,6,0,0" FontSize="13.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" /></StackPanel>
                  </Grid>
                </Border>
                <Border Grid.Column="5" Width="1" Background="{StaticResource LineBrush}" Margin="0,18" />
                <Border Grid.Column="6" Style="{StaticResource CompactMetricStyle}">
                  <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38" /><ColumnDefinition Width="*" /><ColumnDefinition Width="30" /></Grid.ColumnDefinitions>
                    <Border Width="32" Height="32" CornerRadius="8" Background="{StaticResource RoseSoftBrush}" VerticalAlignment="Center"><TextBlock Text="&#xE7F4;" FontFamily="Segoe MDL2 Assets" FontSize="15" Foreground="{StaticResource DangerBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" /></Border>
                    <StackPanel Grid.Column="1" Margin="8,0,0,0" VerticalAlignment="Center"><TextBlock Text="로컬 접속 주소" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="OverviewEndpointValueText" Text="127.0.0.1:17776" Margin="0,6,0,0" FontSize="12" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" TextTrimming="CharacterEllipsis" /></StackPanel>
                    <Button x:Name="CopyEndpointButton" Grid.Column="2" Style="{StaticResource IconButtonStyle}" Width="28" Height="28" MinWidth="28" Content="&#xE8C8;" ToolTip="접속 주소 복사" AutomationProperties.Name="접속 주소 복사" VerticalAlignment="Center" />
                  </Grid>
                </Border>
              </Grid>
            </Border>

            <Grid Grid.Row="2" Margin="0,0,0,12">
              <Grid.ColumnDefinitions><ColumnDefinition Width="1.14*" /><ColumnDefinition Width="12" /><ColumnDefinition Width="0.86*" /></Grid.ColumnDefinitions>
              <Border Grid.Column="0" Style="{StaticResource PanelStyle}" Padding="14">
                <Grid><Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
                  <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                    <StackPanel><TextBlock Text="빠른 작업" Style="{StaticResource SectionHeadingStyle}" /><TextBlock x:Name="OverviewServiceHintText" Text="서비스 상태를 확인하고 있습니다." Margin="0,4,0,0" Style="{StaticResource CaptionStyle}" /></StackPanel>
                    <Button x:Name="OpenServicePageButton" Grid.Column="1" Style="{StaticResource IconButtonStyle}" Content="&#xE76C;" ToolTip="서비스 화면 열기" AutomationProperties.Name="서비스 화면 열기" />
                  </Grid>
                  <Button x:Name="OverviewStartButton" Grid.Row="1" Style="{StaticResource ActionRowButtonStyle}" Background="{StaticResource AccentSoftBrush}" BorderBrush="#88A8DCCF" Margin="0,12,0,7" AutomationProperties.Name="에이전트 시작 또는 서비스 설치">
                    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38" /><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                      <Border Width="30" Height="30" CornerRadius="15" Background="#8FFFFFFF"><TextBlock Text="&#xE768;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="{StaticResource AccentBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" /></Border>
                      <StackPanel Grid.Column="1" Margin="9,0,0,0" VerticalAlignment="Center"><TextBlock x:Name="OverviewStartButtonText" Text="에이전트 시작" FontWeight="SemiBold" /><TextBlock Text="PC 작업 실행 환경을 준비합니다." Margin="0,3,0,0" FontSize="9" Foreground="{StaticResource SecondaryTextBrush}" /></StackPanel>
                      <TextBlock Grid.Column="2" Text="실행  &#xE76C;" FontFamily="Segoe UI Variable Text, Segoe MDL2 Assets" FontSize="10.5" FontWeight="SemiBold" Foreground="{StaticResource AccentBrush}" VerticalAlignment="Center" />
                    </Grid>
                  </Button>
                  <Button x:Name="OverviewRestartButton" Grid.Row="2" Style="{StaticResource ActionRowButtonStyle}" AutomationProperties.Name="에이전트 다시 시작">
                    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="38" /><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                      <Border Width="30" Height="30" CornerRadius="15" Background="{StaticResource SkySoftBrush}"><TextBlock Text="&#xE72C;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="{StaticResource InfoBrush}" HorizontalAlignment="Center" VerticalAlignment="Center" /></Border>
                      <StackPanel Grid.Column="1" Margin="9,0,0,0" VerticalAlignment="Center"><TextBlock Text="에이전트 다시 시작" FontWeight="SemiBold" /><TextBlock Text="연결을 유지하며 런타임을 새로 고칩니다." Margin="0,3,0,0" FontSize="9" Foreground="{StaticResource SecondaryTextBrush}" /></StackPanel>
                      <TextBlock Grid.Column="2" Text="실행  &#xE76C;" FontFamily="Segoe UI Variable Text, Segoe MDL2 Assets" FontSize="10.5" FontWeight="SemiBold" Foreground="{StaticResource AccentBrush}" VerticalAlignment="Center" />
                    </Grid>
                  </Button>
                </Grid>
              </Border>

              <Border Grid.Column="2" Style="{StaticResource PanelStyle}" Padding="14">
                <Grid><Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
                  <StackPanel><TextBlock Text="빠른 도구" Style="{StaticResource SectionHeadingStyle}" /><TextBlock Text="일상적인 관리 작업을 바로 실행합니다." Margin="0,4,0,0" Style="{StaticResource CaptionStyle}" /></StackPanel>
                  <Button x:Name="OpenDiagnosticsPageButton" Grid.Row="1" Style="{StaticResource ActionRowButtonStyle}" Height="42" Margin="0,12,0,6" AutomationProperties.Name="전체 작업 기록 열기"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="28" /><ColumnDefinition Width="*" /><ColumnDefinition Width="16" /></Grid.ColumnDefinitions><TextBlock Text="&#xE9D9;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="{StaticResource InfoBrush}" VerticalAlignment="Center" /><TextBlock Grid.Column="1" Text="진단 센터" VerticalAlignment="Center" /><TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" VerticalAlignment="Center" /></Grid></Button>
                  <Button x:Name="OverviewVerifyButton" Grid.Row="2" Style="{StaticResource ActionRowButtonStyle}" Height="42" Margin="0,0,0,6" AutomationProperties.Name="설치 패키지 검증"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="28" /><ColumnDefinition Width="*" /><ColumnDefinition Width="16" /></Grid.ColumnDefinitions><TextBlock Text="&#xE73E;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="{StaticResource AccentBrush}" VerticalAlignment="Center" /><TextBlock Grid.Column="1" Text="패키지 무결성 검증" VerticalAlignment="Center" /><TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" VerticalAlignment="Center" /></Grid></Button>
                  <Button x:Name="OverviewCollectButton" Grid.Row="3" Style="{StaticResource ActionRowButtonStyle}" Height="42" AutomationProperties.Name="진단 기록 수집"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="28" /><ColumnDefinition Width="*" /><ColumnDefinition Width="16" /></Grid.ColumnDefinitions><TextBlock Text="&#xE896;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="#796CAB" VerticalAlignment="Center" /><TextBlock Grid.Column="1" Text="진단 기록 수집" VerticalAlignment="Center" /><TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" VerticalAlignment="Center" /></Grid></Button>
                </Grid>
              </Border>
            </Grid>

            <Border Grid.Row="3" Style="{StaticResource PanelStyle}" Padding="18,14" MinHeight="141" Margin="0,0,0,8">
              <Grid><Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="*" /></Grid.RowDefinitions>
                <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                  <StackPanel><TextBlock Text="최근 활동" Style="{StaticResource SectionHeadingStyle}" /><TextBlock Text="현재 세션에서 실행된 PC 에이전트 작업" Margin="0,4,0,0" Style="{StaticResource CaptionStyle}" /></StackPanel>
                  <Button x:Name="OverviewRecentOpenDiagnosticsButton" Grid.Column="1" Style="{StaticResource SecondaryButtonStyle}" Height="34" MinHeight="34" MinWidth="82" Padding="11,0" Content="모두 보기" AutomationProperties.Name="진단에서 전체 작업 기록 열기" />
                </Grid>
                <ListBox x:Name="OverviewRecentList" Grid.Row="1" Height="92" Margin="0,10,0,0" Background="Transparent" BorderThickness="0" ItemContainerStyle="{StaticResource ActivityItemStyle}" ScrollViewer.VerticalScrollBarVisibility="Auto" ScrollViewer.HorizontalScrollBarVisibility="Disabled" IsTabStop="False" />
              </Grid>
            </Border>
          </Grid>

          <Grid x:Name="ServicePage" Visibility="Collapsed" MinHeight="618">
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
            </Grid.RowDefinitions>
            <StackPanel Grid.Row="0" Visibility="Collapsed" />

            <Border Grid.Row="1" Style="{StaticResource PanelStyle}" Padding="10,0" MinHeight="112" Margin="0,8,0,12">
              <Grid>
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="1.15*" /><ColumnDefinition Width="1" />
                  <ColumnDefinition Width="1*" /><ColumnDefinition Width="1" />
                  <ColumnDefinition Width="1*" /><ColumnDefinition Width="1" />
                  <ColumnDefinition Width="0.85*" />
                </Grid.ColumnDefinitions>
                <StackPanel Grid.Column="0" Margin="18,0" VerticalAlignment="Center">
                  <TextBlock Text="서비스 상태" Style="{StaticResource CaptionStyle}" />
                  <TextBlock x:Name="ServiceStateLargeText" Text="확인 중" Margin="0,8,0,0" FontSize="20" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                </StackPanel>
                <Border Grid.Column="1" Width="1" Background="{StaticResource LineBrush}" Margin="0,22" />
                <StackPanel Grid.Column="2" Margin="22,0" VerticalAlignment="Center">
                  <TextBlock Text="현재 실행 형태" Style="{StaticResource CaptionStyle}" />
                  <TextBlock x:Name="ServiceRuntimeModeText" Text="확인 중" Margin="0,8,0,0" FontSize="15" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                </StackPanel>
                <Border Grid.Column="3" Width="1" Background="{StaticResource LineBrush}" Margin="0,22" />
                <StackPanel Grid.Column="4" Margin="22,0" VerticalAlignment="Center">
                  <TextBlock Text="로컬 API" Style="{StaticResource CaptionStyle}" />
                  <TextBlock x:Name="ServiceApiStateText" Text="확인 중" Margin="0,8,0,0" FontSize="15" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                </StackPanel>
                <Border Grid.Column="5" Width="1" Background="{StaticResource LineBrush}" Margin="0,22" />
                <StackPanel Grid.Column="6" Margin="22,0" VerticalAlignment="Center">
                  <TextBlock Text="응답 시간" Style="{StaticResource CaptionStyle}" />
                  <TextBlock x:Name="ServiceLatencyText" Text="-" Margin="0,8,0,0" FontSize="15" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                </StackPanel>
              </Grid>
            </Border>

            <Border x:Name="ServiceConflictBorder" Grid.Row="2" Visibility="Collapsed" Background="{StaticResource WarningSoftBrush}" BorderBrush="#B8D18A31" BorderThickness="1" CornerRadius="8" Padding="16,13" Margin="0,0,0,12">
              <StackPanel Orientation="Horizontal">
                <TextBlock Text="&#xE7BA;" FontFamily="Segoe MDL2 Assets" FontSize="14" Foreground="{StaticResource WarningBrush}" Margin="0,1,10,0" />
                <TextBlock x:Name="ServiceConflictText" Text="개발 런타임이 같은 포트를 사용하고 있습니다." FontSize="10.5" Foreground="{StaticResource PrimaryTextBrush}" TextWrapping="Wrap" />
              </StackPanel>
            </Border>

            <Border Grid.Row="3" Style="{StaticResource PanelStyle}" Margin="0,0,0,12">
              <Grid>
                <Grid.RowDefinitions>
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                </Grid.RowDefinitions>
                <TextBlock Text="서비스 수명주기" Style="{StaticResource SectionHeadingStyle}" />
                <TextBlock x:Name="ServiceControlHintText" Grid.Row="1" Text="상태를 확인하고 있습니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                <Grid Grid.Row="2" Margin="0,18,0,0">
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="10" />
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="10" />
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="10" />
                    <ColumnDefinition Width="*" />
                  </Grid.ColumnDefinitions>
                  <Button x:Name="ServiceStartButton" Grid.Column="0" Style="{StaticResource PrimaryButtonStyle}" AutomationProperties.Name="에이전트 시작 또는 서비스 설치">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE768;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock x:Name="ServiceStartButtonText" Text="에이전트 시작" />
                    </StackPanel>
                  </Button>
                  <Button x:Name="ServiceStopButton" Grid.Column="2" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="에이전트 중지">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE71A;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock Text="중지" />
                    </StackPanel>
                  </Button>
                  <Button x:Name="ServiceRestartButton" Grid.Column="4" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="에이전트 다시 시작">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE72C;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock Text="다시 시작" />
                    </StackPanel>
                  </Button>
                  <Button x:Name="ServiceUpdateButton" Grid.Column="6" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="에이전트 업데이트">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE777;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock Text="업데이트" />
                    </StackPanel>
                  </Button>
                </Grid>
              </Grid>
            </Border>

            <Grid Grid.Row="4" MinHeight="238" Margin="0,0,0,18">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="1.05*" />
                <ColumnDefinition Width="14" />
                <ColumnDefinition Width="0.95*" />
              </Grid.ColumnDefinitions>
              <Border Grid.Column="0" Style="{StaticResource PanelStyle}" VerticalAlignment="Stretch">
                <Grid>
                  <Grid.RowDefinitions>
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                  </Grid.RowDefinitions>
                  <StackPanel>
                    <TextBlock Text="실행 경계" Style="{StaticResource SectionHeadingStyle}" />
                    <TextBlock Text="실제 연결과 로컬 제한을 확인합니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                  </StackPanel>
                  <Border Grid.Row="1" Style="{StaticResource SettingsRowStyle}" Margin="0,6,0,0">
                    <Grid>
                      <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                      <TextBlock Text="API 정체성" Style="{StaticResource CaptionStyle}" VerticalAlignment="Center" />
                      <TextBlock x:Name="ServiceIdentityText" Grid.Column="1" Text="확인 중" FontSize="11" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" VerticalAlignment="Center" />
                    </Grid>
                  </Border>
                  <Border Grid.Row="2" Style="{StaticResource SettingsRowStyle}">
                    <Grid>
                      <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                      <TextBlock Text="로컬 바인딩" Style="{StaticResource CaptionStyle}" VerticalAlignment="Center" />
                      <TextBlock x:Name="ServiceEndpointText" Grid.Column="1" Text="127.0.0.1:17776" FontFamily="Consolas" FontSize="10.5" Foreground="{StaticResource PrimaryTextBrush}" VerticalAlignment="Center" />
                    </Grid>
                  </Border>
                  <Border Grid.Row="3" Padding="0,14,0,0">
                    <Grid>
                      <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                      <TextBlock Text="로그인 자동 실행" Style="{StaticResource CaptionStyle}" VerticalAlignment="Center" />
                      <TextBlock x:Name="ServiceStartupStateText" Grid.Column="1" Text="확인 중" FontSize="11" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" VerticalAlignment="Center" />
                    </Grid>
                  </Border>
                </Grid>
              </Border>

              <Border Grid.Column="2" Style="{StaticResource PanelStyle}">
                <Grid>
                  <Grid.RowDefinitions>
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                    <RowDefinition Height="Auto" />
                  </Grid.RowDefinitions>
                  <StackPanel>
                    <TextBlock Text="관리 도구" Style="{StaticResource SectionHeadingStyle}" />
                    <TextBlock Text="현재 환경을 확인하거나 파일 위치를 엽니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                  </StackPanel>
                  <Button x:Name="ServiceProbeButton" Grid.Row="1" Style="{StaticResource ActionRowButtonStyle}" Margin="0,16,0,0" AutomationProperties.Name="서비스와 로컬 API 연결 점검">
                    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="28" /><ColumnDefinition Width="*" /><ColumnDefinition Width="18" /></Grid.ColumnDefinitions><TextBlock Text="&#xE9D9;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="{StaticResource InfoBrush}" VerticalAlignment="Center" /><TextBlock Grid.Column="1" Text="연결 다시 점검" VerticalAlignment="Center" /><TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" VerticalAlignment="Center" /></Grid>
                  </Button>
                  <Button x:Name="ServiceOpenServicesButton" Grid.Row="2" Style="{StaticResource ActionRowButtonStyle}" Margin="0,8,0,0" AutomationProperties.Name="Windows 서비스 관리 열기">
                    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="28" /><ColumnDefinition Width="*" /><ColumnDefinition Width="18" /></Grid.ColumnDefinitions><TextBlock Text="&#xE90F;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="#796CAB" VerticalAlignment="Center" /><TextBlock Grid.Column="1" Text="Windows 서비스 관리" VerticalAlignment="Center" /><TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" VerticalAlignment="Center" /></Grid>
                  </Button>
                  <Button x:Name="ServiceOpenFolderButton" Grid.Row="3" Style="{StaticResource ActionRowButtonStyle}" Margin="0,8,0,0" AutomationProperties.Name="PC 에이전트 설치 폴더 열기">
                    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="28" /><ColumnDefinition Width="*" /><ColumnDefinition Width="18" /></Grid.ColumnDefinitions><TextBlock Text="&#xE8B7;" FontFamily="Segoe MDL2 Assets" FontSize="13" Foreground="{StaticResource AccentBrush}" VerticalAlignment="Center" /><TextBlock Grid.Column="1" Text="설치 파일 위치" VerticalAlignment="Center" /><TextBlock Grid.Column="2" Text="&#xE76C;" FontFamily="Segoe MDL2 Assets" FontSize="9" VerticalAlignment="Center" /></Grid>
                  </Button>
                </Grid>
              </Border>
            </Grid>
          </Grid>

          <Grid x:Name="DiagnosticsPage" Visibility="Collapsed" MinHeight="618">
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="*" />
            </Grid.RowDefinitions>
            <StackPanel Grid.Row="0" Visibility="Collapsed" />

            <Border Grid.Row="1" Style="{StaticResource PanelStyle}" Padding="22,18" Margin="0,8,0,12">
              <Grid>
                <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
                <StackPanel>
                  <TextBlock Text="상태 점검" FontSize="17" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                  <TextBlock Text="연결, 서비스, 자동 실행, 설치 무결성을 서로 독립적으로 확인합니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                </StackPanel>
                <Grid Grid.Row="1" Margin="0,18,0,0">
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*" /><ColumnDefinition Width="1" /><ColumnDefinition Width="*" /><ColumnDefinition Width="1" /><ColumnDefinition Width="*" /><ColumnDefinition Width="1" /><ColumnDefinition Width="*" />
                  </Grid.ColumnDefinitions>
                  <StackPanel Grid.Column="0" Margin="12,0"><TextBlock Text="PC 에이전트 API" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="DiagnosticsApiStateText" Text="확인 중" Margin="0,10,0,0" FontSize="17" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" /><TextBlock x:Name="DiagnosticsApiDetailText" Text="정체성 확인 대기" Margin="0,6,0,0" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" TextTrimming="CharacterEllipsis" /></StackPanel>
                  <Border Grid.Column="1" Width="1" Background="{StaticResource LineBrush}" />
                  <StackPanel Grid.Column="2" Margin="18,0"><TextBlock Text="JARVIS 제어 센터" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="DiagnosticsControlCenterStateText" Text="확인 중" Margin="0,10,0,0" FontSize="17" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" /><TextBlock x:Name="DiagnosticsControlCenterDetailText" Text="정체성 확인 대기" Margin="0,6,0,0" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" TextTrimming="CharacterEllipsis" /></StackPanel>
                  <Border Grid.Column="3" Width="1" Background="{StaticResource LineBrush}" />
                  <StackPanel Grid.Column="4" Margin="18,0"><TextBlock Text="Windows 서비스" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="DiagnosticsServiceStateText" Text="확인 중" Margin="0,10,0,0" FontSize="17" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" /><TextBlock x:Name="DiagnosticsServiceDetailText" Text="등록 상태 확인 대기" Margin="0,6,0,0" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" TextTrimming="CharacterEllipsis" /></StackPanel>
                  <Border Grid.Column="5" Width="1" Background="{StaticResource LineBrush}" />
                  <StackPanel Grid.Column="6" Margin="18,0"><TextBlock Text="로그인 자동 실행" Style="{StaticResource CaptionStyle}" /><TextBlock x:Name="DiagnosticsStartupStateText" Text="확인 중" Margin="0,10,0,0" FontSize="17" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" /><TextBlock x:Name="DiagnosticsStartupDetailText" Text="바로가기 확인 대기" Margin="0,6,0,0" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" TextTrimming="CharacterEllipsis" /></StackPanel>
                </Grid>
              </Grid>
            </Border>

            <Grid Grid.Row="2" Margin="0,0,0,12">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*" />
                <ColumnDefinition Width="14" />
                <ColumnDefinition Width="*" />
              </Grid.ColumnDefinitions>
              <Border Grid.Column="0" Style="{StaticResource PanelStyle}">
                <Grid>
                  <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
                  <TextBlock Text="진단 묶음" Style="{StaticResource SectionHeadingStyle}" />
                  <TextBlock x:Name="CollectStatusText" Grid.Row="1" Text="아직 수집된 진단 묶음이 없습니다." Margin="0,6,0,0" Style="{StaticResource CaptionStyle}" TextTrimming="CharacterEllipsis" />
                  <Grid Grid.Row="2" Margin="0,16,0,0">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="9" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>
                    <Button x:Name="OpenDiagnosticButton" Grid.Column="0" Style="{StaticResource SecondaryButtonStyle}" Content="결과 열기" IsEnabled="False" AutomationProperties.Name="최근 진단 결과 열기" />
                    <Button x:Name="CollectLogsButton" Grid.Column="2" Style="{StaticResource PrimaryButtonStyle}" AutomationProperties.Name="진단 기록 수집">
                      <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE896;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="지금 수집" /></StackPanel>
                    </Button>
                  </Grid>
                </Grid>
              </Border>

              <Border Grid.Column="2" Style="{StaticResource PanelStyle}">
                <Grid>
                  <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
                  <TextBlock Text="설치 패키지 무결성" Style="{StaticResource SectionHeadingStyle}" />
                  <TextBlock x:Name="VerifyStatusText" Grid.Row="1" Text="아직 현재 패키지를 검증하지 않았습니다." Margin="0,6,0,0" Style="{StaticResource CaptionStyle}" TextTrimming="CharacterEllipsis" />
                  <StackPanel Grid.Row="2" Margin="0,16,0,0">
                  <Button x:Name="InstallationPreflightButton" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,0,8" AutomationProperties.Name="설치 준비 점검"><TextBlock Text="설치 준비 점검" /></Button>
                  <Button x:Name="VerifyPackageButton" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="설치 패키지 검증">
                    <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE73E;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="무결성 검증" /></StackPanel>
                  </Button>
                  </StackPanel>
                </Grid>
              </Border>
            </Grid>

            <Border Grid.Row="3" Style="{StaticResource PanelStyle}" Padding="12" Margin="0,0,0,12">
              <Grid>
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="*" />
                  <ColumnDefinition Width="9" />
                  <ColumnDefinition Width="*" />
                  <ColumnDefinition Width="9" />
                  <ColumnDefinition Width="*" />
                </Grid.ColumnDefinitions>
                <Button x:Name="RunAllChecksButton" Grid.Column="0" Style="{StaticResource PrimaryButtonStyle}" AutomationProperties.Name="전체 상태 점검 실행">
                  <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE9D9;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="전체 점검" /></StackPanel>
                </Button>
                <Button x:Name="CopyDiagnosticsSummaryButton" Grid.Column="2" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="상태 점검 요약 복사">
                  <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE8C8;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="요약 복사" /></StackPanel>
                </Button>
                <Button x:Name="OpenLogsFolderButton" Grid.Column="4" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="진단 파일 폴더 열기">
                  <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE8B7;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="진단 파일 위치" /></StackPanel>
                </Button>
              </Grid>
            </Border>

            <Border Grid.Row="4" Style="{StaticResource PanelStyle}" MinHeight="188" VerticalAlignment="Stretch" Margin="0,0,0,18">
              <Grid>
                <Grid.RowDefinitions>
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="*" />
                </Grid.RowDefinitions>
                <Grid>
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="Auto" />
                  </Grid.ColumnDefinitions>
                  <TextBlock Text="작업 기록" Style="{StaticResource SectionHeadingStyle}" />
                  <Button x:Name="ClearLogButton" Grid.Column="1" Style="{StaticResource SecondaryButtonStyle}" Height="32" MinHeight="32" MinWidth="70" Padding="10,0" Content="지우기" AutomationProperties.Name="작업 기록 지우기" />
                </Grid>
                <TextBox x:Name="DiagnosticsLogText" Grid.Row="1" Height="98" Margin="0,14,0,0" Style="{StaticResource LogTextBoxStyle}" IsReadOnly="True" AcceptsReturn="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" />
              </Grid>
            </Border>
          </Grid>

          ${renderFeaturePage()}
          <Grid x:Name="WorkspacePage" Visibility="Collapsed" MinHeight="600">
            <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/></Grid.RowDefinitions>
            <WrapPanel Margin="0,0,0,12">
              <Button x:Name="WorkspaceBackButton" Content="기능 목록" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,8,0"/>
              <Button x:Name="WorkspaceReloadButton" Content="다시 불러오기" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,8,0"/>
              <Button x:Name="WorkspaceExternalButton" Content="기본 브라우저에서 열기" Style="{StaticResource SecondaryButtonStyle}"/>
            </WrapPanel>
            <Border x:Name="WorkspaceHost" Grid.Row="1" Style="{StaticResource PanelStyle}" Padding="0" MinHeight="550"/>
          </Grid>
          <Grid x:Name="SettingsPage" Visibility="Collapsed" MinHeight="618">
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="Auto" />
              <RowDefinition Height="*" />
            <RowDefinition Height="Auto" /></Grid.RowDefinitions>
            <StackPanel Grid.Row="0" Margin="0,8,0,14">
              <TextBlock Text="사용 환경" Style="{StaticResource PageHeadingStyle}" />
              <TextBlock Text="PC 에이전트의 시작 방식, 상태 갱신, 알림과 로컬 연결을 조정합니다." Margin="0,7,0,0" Style="{StaticResource CaptionStyle}" />
            </StackPanel>

            <Border Grid.Row="1" Style="{StaticResource PanelStyle}" Margin="0,0,0,12" Padding="22,18">
              <Grid>
                <Grid.RowDefinitions>
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                </Grid.RowDefinitions>
                <StackPanel>
                  <TextBlock Text="앱 동작" Style="{StaticResource SectionHeadingStyle}" />
                  <TextBlock Text="변경 내용은 현재 Windows 사용자에게만 저장됩니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                </StackPanel>
                <Border Grid.Row="1" Style="{StaticResource SettingsRowStyle}" Margin="0,8,0,0">
                  <Grid>
                    <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                    <StackPanel>
                      <TextBlock Text="Windows 로그인 시 자동 실행" FontSize="12.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                      <TextBlock x:Name="StartupStatusText" Text="시작프로그램 등록 상태를 확인하고 있습니다." Margin="0,5,20,0" Style="{StaticResource CaptionStyle}" />
                    </StackPanel>
                    <CheckBox x:Name="StartupToggle" Grid.Column="1" Style="{StaticResource ToggleStyle}" VerticalAlignment="Center" AutomationProperties.Name="Windows 로그인 시 자동 실행" />
                  </Grid>
                </Border>
                <Border Grid.Row="2" Style="{StaticResource SettingsRowStyle}">
                  <Grid>
                    <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /><ColumnDefinition Width="12" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                    <StackPanel>
                      <TextBlock Text="상태 자동 갱신" FontSize="12.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                      <TextBlock x:Name="RefreshIntervalStatusText" Text="5초마다 로컬 상태를 확인합니다." Margin="0,5,20,0" Style="{StaticResource CaptionStyle}" />
                    </StackPanel>
                    <ComboBox x:Name="RefreshIntervalCombo" Grid.Column="1" Style="{StaticResource ComboBoxStyle}" VerticalAlignment="Center" AutomationProperties.Name="상태 자동 갱신 주기">
                      <ComboBoxItem Content="5초" Tag="5" IsSelected="True" />
                      <ComboBoxItem Content="15초" Tag="15" />
                      <ComboBoxItem Content="30초" Tag="30" />
                      <ComboBoxItem Content="1분" Tag="60" />
                    </ComboBox>
                    <CheckBox x:Name="AutoRefreshToggle" Grid.Column="3" Style="{StaticResource ToggleStyle}" VerticalAlignment="Center" AutomationProperties.Name="상태 자동 갱신" />
                  </Grid>
                </Border>
                <Border Grid.Row="3" Padding="0,14,0,0">
                  <Grid>
                    <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                    <StackPanel>
                      <TextBlock Text="작업 완료 알림" FontSize="12.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                      <TextBlock x:Name="NotificationStatusText" Text="완료 또는 확인이 필요한 작업을 Windows 알림으로 표시합니다." Margin="0,5,20,0" Style="{StaticResource CaptionStyle}" />
                    </StackPanel>
                    <CheckBox x:Name="NotificationToggle" Grid.Column="1" Style="{StaticResource ToggleStyle}" VerticalAlignment="Center" AutomationProperties.Name="작업 완료 알림" />
                  </Grid>
                </Border>
                <Border Grid.Row="4" Style="{StaticResource SettingsRowStyle}">
                  <Grid>
                    <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
                    <StackPanel>
                      <TextBlock Text="트레이 아이콘 애니메이션" FontSize="12.5" FontWeight="SemiBold" Foreground="{StaticResource PrimaryTextBrush}" />
                      <TextBlock x:Name="TrayAnimationStatusText" Text="연결 및 작업 상태를 짧고 절제된 움직임으로 표시합니다." Margin="0,5,20,0" Style="{StaticResource CaptionStyle}" />
                    </StackPanel>
                    <CheckBox x:Name="TrayAnimationToggle" Grid.Column="1" Style="{StaticResource ToggleStyle}" VerticalAlignment="Center" AutomationProperties.Name="트레이 아이콘 애니메이션" />
                  </Grid>
                </Border>
              </Grid>
            </Border>

            <Border Grid.Row="2" Style="{StaticResource PanelStyle}" Margin="0,0,0,12" Padding="22,18">
              <Grid>
                <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
                <StackPanel>
                  <TextBlock Text="로컬 API 접속 주소" Style="{StaticResource SectionHeadingStyle}" />
                  <TextBlock Text="외부 네트워크가 아닌 이 PC 내부 주소만 사용합니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                </StackPanel>
                <Grid Grid.Row="1" Margin="0,16,0,0">
                  <Grid.ColumnDefinitions><ColumnDefinition Width="1.3*" /><ColumnDefinition Width="9" /><ColumnDefinition Width="*" /><ColumnDefinition Width="9" /><ColumnDefinition Width="*" /><ColumnDefinition Width="9" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>
                  <Border Grid.Column="0" Style="{StaticResource StatusChipStyle}" Padding="12,8">
                    <StackPanel>
                      <TextBlock x:Name="SettingsEndpointText" Text="http://127.0.0.1:17776" FontFamily="Consolas" FontSize="10.5" Foreground="{StaticResource PrimaryTextBrush}" TextTrimming="CharacterEllipsis" />
                      <TextBlock x:Name="SettingsConnectionStateText" Text="연결 확인 중" Margin="0,4,0,0" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" />
                    </StackPanel>
                  </Border>
                  <Button x:Name="TestConnectionButton" Grid.Column="2" Style="{StaticResource PrimaryButtonStyle}" AutomationProperties.Name="로컬 API 연결 테스트">
                    <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE9D9;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="연결 테스트" /></StackPanel>
                  </Button>
                  <Button x:Name="SettingsCopyEndpointButton" Grid.Column="4" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="로컬 API 접속 주소 복사">
                    <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE8C8;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="주소 복사" /></StackPanel>
                  </Button>
                  <Button x:Name="OpenHealthButton" Grid.Column="6" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="로컬 API 상태 응답 열기">
                    <StackPanel Orientation="Horizontal"><TextBlock Text="&#xE8A7;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" /><TextBlock Text="상태 응답" /></StackPanel>
                  </Button>
                </Grid>
              </Grid>
            </Border>

            <Border Grid.Row="3" Style="{StaticResource PanelStyle}" Padding="22,18" MinHeight="112" VerticalAlignment="Stretch" Margin="0,0,0,10">
              <Grid>
                <Grid.RowDefinitions>
                  <RowDefinition Height="Auto" />
                  <RowDefinition Height="Auto" />
                </Grid.RowDefinitions>
                <StackPanel>
                  <TextBlock Text="로컬 파일과 기록" Style="{StaticResource SectionHeadingStyle}" />
                  <TextBlock Text="설치 위치를 열거나 현재 UI 세션의 활동 목록을 비웁니다." Margin="0,5,0,0" Style="{StaticResource CaptionStyle}" />
                </StackPanel>
                <Grid Grid.Row="1" Margin="0,16,0,0">
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="9" />
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="9" />
                    <ColumnDefinition Width="*" />
                  </Grid.ColumnDefinitions>
                  <Button x:Name="OpenInstallFolderButton" Grid.Column="0" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="PC 에이전트 설치 폴더 열기">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE8B7;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock Text="설치 폴더 열기" />
                    </StackPanel>
                  </Button>
                  <Button x:Name="OpenStartupFolderButton" Grid.Column="2" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="Windows 시작프로그램 폴더 열기">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE7C3;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock Text="시작프로그램 폴더" />
                    </StackPanel>
                  </Button>
                  <Button x:Name="ClearActivityButton" Grid.Column="4" Style="{StaticResource SecondaryButtonStyle}" AutomationProperties.Name="현재 UI 활동 기록 지우기">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="&#xE74D;" FontFamily="Segoe MDL2 Assets" FontSize="13" Margin="0,0,8,0" />
                      <TextBlock Text="활동 기록 지우기" />
                    </StackPanel>
                  </Button>
                </Grid>
              </Grid>
            </Border>
            <Border Grid.Row="4" Style="{StaticResource PanelStyle}" Margin="0,0,0,12">
              <StackPanel>
                <TextBlock Text="연결과 화면 맞춤 설정" Style="{StaticResource SectionHeadingStyle}" />
                <TextBlock Text="같은 PC의 제어센터 주소를 지정합니다. PC 서비스 포트와 실행 권한은 변경하지 않습니다." TextWrapping="Wrap" Margin="0,8,0,12" Style="{StaticResource CaptionStyle}" />
                <Label Target="{Binding ElementName=ConsoleAddressInput}" Content="제어센터 주소" />
                <TextBox x:Name="ConsoleAddressInput" MinHeight="36" Padding="8" AutomationProperties.Name="제어센터 주소 입력" />
                <WrapPanel Margin="0,12,0,12">
                  <Button x:Name="SaveConsoleAddressButton" Content="주소 저장 및 점검" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,8,8" />
                  <Button x:Name="ResetConsoleAddressButton" Content="기본 주소 복원" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,8,8" />
                  <Button x:Name="GoogleConnectionsButton" Content="메일·일정 연결 설정" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,8,8" />
                  <Button x:Name="SkillCenterButton" Content="스킬·도구 관리" Style="{StaticResource SecondaryButtonStyle}" Margin="0,0,8,8" />
                </WrapPanel>
                <Label Target="{Binding ElementName=InterfaceScaleCombo}" Content="콘텐츠 표시 배율" />
                <ComboBox x:Name="InterfaceScaleCombo" Style="{StaticResource ComboBoxStyle}" HorizontalAlignment="Left" MinWidth="150" AutomationProperties.Name="콘텐츠 표시 배율">
                  <ComboBoxItem Content="90% · 촘촘하게" Tag="90"/><ComboBoxItem Content="100% · 기본" Tag="100"/><ComboBoxItem Content="110% · 크게" Tag="110"/><ComboBoxItem Content="125% · 더 크게" Tag="125"/>
                </ComboBox>
              </StackPanel>
            </Border>
          </Grid>
        </Grid>
      </ScrollViewer>

      <Border Grid.Row="3" Background="#BFFFFFFF" BorderBrush="{StaticResource LineBrush}" BorderThickness="0,1,0,0" Padding="36,0,32,0">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto" />
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="Auto" />
          </Grid.ColumnDefinitions>
          <Border Style="{StaticResource StatusChipStyle}" Padding="9,5" VerticalAlignment="Center">
            <StackPanel Orientation="Horizontal">
              <Ellipse x:Name="HeaderStatusDot" Width="7" Height="7" Fill="{StaticResource WarningBrush}" Margin="0,0,7,0" VerticalAlignment="Center" />
              <TextBlock x:Name="HeaderStatusText" Text="상태 확인 중" FontSize="10" FontWeight="SemiBold" Foreground="{StaticResource WarningBrush}" VerticalAlignment="Center" />
            </StackPanel>
          </Border>
          <TextBlock x:Name="FooterStatusText" Grid.Column="1" Text="준비됨" Margin="14,0" FontSize="9.5" Foreground="{StaticResource SecondaryTextBrush}" VerticalAlignment="Center" TextTrimming="CharacterEllipsis" />
          <TextBlock Grid.Column="2" Text="로컬 전용 · 승인 기반 실행" FontSize="9" Foreground="{StaticResource MutedTextBrush}" VerticalAlignment="Center" />
        </Grid>
      </Border>
    </Grid>
  </Grid>
</Window>`;
}
