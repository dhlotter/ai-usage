mod providers;

use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

#[tauri::command]
fn update_tray(app: tauri::AppHandle, text: String, tooltip: String) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_title(Some(&text));
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn resize_window(app: tauri::AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let clamped = (height as u32).clamp(140, 800);
        let _ = window.set_size(tauri::LogicalSize::new(360u32, clamped));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            providers::get_providers,
            update_tray,
            quit_app,
            resize_window
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Start fetching immediately rather than waiting for the webview.
            providers::warm_cache();

            // Apply macOS vibrancy to the main window — Popover material matches system menu dropdowns
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use tauri::utils::{WindowEffect, WindowEffectState};
                use tauri::utils::config::WindowEffectsConfig;
                let _ = window.set_effects(WindowEffectsConfig {
                    effects: vec![WindowEffect::Popover],
                    state: Some(WindowEffectState::Active),
                    radius: Some(12.0),
                    color: None,
                });
            }

            let quit_item = MenuItem::with_id(app, "quit", "Quit AI Usage", true, Some("Cmd+Q"))?;
            let sep = PredefinedMenuItem::separator(app)?;
            let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let tray_menu = MenuBuilder::new(app).items(&[&open_item, &sep, &quit_item]).build()?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)
                .tooltip("AI Usage")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "quit" => app.exit(0),
                        "open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        toggle_window(app, Some(rect));
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(false) = event {
                window.hide().unwrap();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn toggle_window(app: &tauri::AppHandle, tray_rect: Option<tauri::Rect>) {
    let window: WebviewWindow = app.get_webview_window("main").unwrap();
    if window.is_visible().unwrap_or(false) {
        window.hide().unwrap();
        return;
    }

    // Position the window centered horizontally under the tray icon
    if let (Some(rect), Ok(Some(monitor))) = (tray_rect, window.primary_monitor()) {
        let scale = monitor.scale_factor();
        let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(360, 480));
        let pos = match rect.position {
            tauri::Position::Physical(p) => p,
            tauri::Position::Logical(l) => l.to_physical(scale),
        };
        let sz = match rect.size {
            tauri::Size::Physical(s) => s,
            tauri::Size::Logical(l) => l.to_physical(scale),
        };
        let icon_center_x = pos.x + (sz.width as i32) / 2;
        let icon_bottom_y = pos.y + (sz.height as i32);
        let x = icon_center_x - (win_size.width as i32 / 2);
        let y = icon_bottom_y + 6;

        let screen = monitor.size();
        let x = x.max(8).min(screen.width as i32 - win_size.width as i32 - 8);
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }

    window.show().unwrap();
    window.set_focus().unwrap();
}
