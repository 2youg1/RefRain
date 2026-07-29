use serde::{Deserialize, Serialize};
use specta::Type;

const FALLBACK_REFRESH_HZ: f64 = 60.0;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DisplayProfile {
    pub monitor: Option<String>,
    pub physical_width: u32,
    pub physical_height: u32,
    pub scale_factor: f64,
    pub refresh_hz: f64,
    pub refresh_measured: bool,
    pub frame_budget_ms: f64,
    pub hairline_css_px: f64,
}

impl DisplayProfile {
    fn from_measurement(
        monitor: Option<String>,
        physical_size: (u32, u32),
        scale_factor: f64,
        measured_refresh_hz: Option<f64>,
    ) -> Self {
        let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
            scale_factor
        } else {
            1.0
        };
        let refresh = measured_refresh_hz.filter(|value| value.is_finite() && *value > 1.0);
        let refresh_hz = refresh.unwrap_or(FALLBACK_REFRESH_HZ);
        Self {
            monitor,
            physical_width: physical_size.0,
            physical_height: physical_size.1,
            scale_factor,
            refresh_hz,
            refresh_measured: refresh.is_some(),
            frame_budget_ms: 1000.0 / refresh_hz,
            hairline_css_px: 1.0 / scale_factor,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn display_profile(window: tauri::WebviewWindow) -> DisplayProfile {
    let monitor = window.current_monitor().ok().flatten();
    let scale_factor = monitor.as_ref().map_or_else(
        || window.scale_factor().unwrap_or(1.0),
        |value| value.scale_factor(),
    );
    let physical_size = monitor
        .as_ref()
        .map_or((0, 0), |value| (value.size().width, value.size().height));
    let name = monitor.and_then(|value| value.name().cloned());
    DisplayProfile::from_measurement(
        name,
        physical_size,
        scale_factor,
        windows_refresh_hz(&window),
    )
}

#[cfg(target_os = "windows")]
fn windows_refresh_hz(window: &tauri::WebviewWindow) -> Option<f64> {
    use std::mem::size_of;
    use windows::Win32::Graphics::Gdi::{
        DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW, GetMonitorInfoW,
        MONITOR_DEFAULTTONEAREST, MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
    };
    use windows::core::PCWSTR;

    let hwnd = window.hwnd().ok()?;
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let mut mode = DEVMODEW {
        dmSize: size_of::<DEVMODEW>() as u16,
        ..DEVMODEW::default()
    };

    // Win32 requires initialized size fields before it writes either structure.
    let found = unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        GetMonitorInfoW(
            monitor,
            std::ptr::from_mut(&mut info.monitorInfo).cast::<MONITORINFO>(),
        )
        .as_bool()
            && EnumDisplaySettingsW(
                PCWSTR(info.szDevice.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &raw mut mode,
            )
            .as_bool()
    };
    (found && mode.dmDisplayFrequency > 1).then_some(f64::from(mode.dmDisplayFrequency))
}

#[cfg(not(target_os = "windows"))]
fn windows_refresh_hz(_window: &tauri::WebviewWindow) -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::DisplayProfile;

    #[test]
    fn unknown_refresh_is_explicit_and_uses_the_sixty_hertz_fallback() {
        let profile = DisplayProfile::from_measurement(None, (0, 0), 0.0, None);
        assert_eq!(profile.refresh_hz, 60.0);
        assert!(!profile.refresh_measured);
        assert_eq!(profile.scale_factor, 1.0);
        assert_eq!(profile.hairline_css_px, 1.0);
    }

    #[test]
    fn measured_refresh_and_scale_define_the_frame_budget_and_hairline() {
        let profile = DisplayProfile::from_measurement(
            Some("display".to_string()),
            (3840, 2160),
            2.0,
            Some(144.0),
        );
        assert!(profile.refresh_measured);
        assert_eq!(profile.refresh_hz, 144.0);
        assert!(profile.frame_budget_ms < 10.0);
        assert_eq!(profile.hairline_css_px, 0.5);
    }
}
