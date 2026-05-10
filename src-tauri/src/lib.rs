use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    ActivationPolicy, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Size, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, Wry,
};
use tauri_plugin_autostart::ManagerExt;

static WINDOW_ANIMATION_GENERATION: AtomicU64 = AtomicU64::new(0);
static AUTOSIZE_MENU_ENABLED: AtomicBool = AtomicBool::new(true);
static STARTUP_MENU_ENABLED: AtomicBool = AtomicBool::new(false);

struct StartupMenuItem(CheckMenuItem<Wry>);
struct AutosizeMenuItem(CheckMenuItem<Wry>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            app.set_dock_visibility(false);

            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                struct AppShortcut {
                    shortcut: Shortcut,
                    action: &'static str,
                }

                let shortcuts = vec![
                    AppShortcut {
                        shortcut: Shortcut::new(Some(Modifiers::ALT), Code::KeyK),
                        action: "toggle_main_window",
                    },
                    AppShortcut {
                        shortcut: Shortcut::new(
                            Some(Modifiers::SUPER | Modifiers::SHIFT),
                            Code::KeyK,
                        ),
                        action: "toggle_main_window",
                    },
                ];
                let registered_shortcuts: Vec<Shortcut> =
                    shortcuts.iter().map(|item| item.shortcut.clone()).collect();

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }

                            let Some(action) = shortcuts
                                .iter()
                                .find(|item| &item.shortcut == shortcut)
                                .map(|item| item.action)
                            else {
                                return;
                            };

                            if action == "toggle_main_window" {
                                if let Some(window) = app.get_webview_window("main") {
                                    toggle_centered_window(&window);
                                }
                            }
                        })
                        .build(),
                )?;

                for shortcut in registered_shortcuts {
                    app.global_shortcut().register(shortcut)?;
                }
            }

            // Build tray menu
            let show_hide =
                MenuItem::with_id(app, "show_hide", "Show / Hide Board", true, None::<&str>)?;
            let startup_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let toggle_startup = CheckMenuItem::with_id(
                app,
                "toggle_startup",
                "Launch at Login",
                true,
                startup_enabled,
                None::<&str>,
            )?;
            let toggle_autosize = CheckMenuItem::with_id(
                app,
                "toggle_autosize",
                "Autosize Window",
                true,
                true,
                None::<&str>,
            )?;
            STARTUP_MENU_ENABLED.store(startup_enabled, Ordering::SeqCst);
            let settings = MenuItem::with_id(app, "settings", "Settings...", true, Some("Cmd+,"))?;
            let check_updates = MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates...",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit KanTrack", true, Some("Cmd+Q"))?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_hide,
                    &toggle_startup,
                    &toggle_autosize,
                    &settings,
                    &check_updates,
                    &separator,
                    &quit,
                ],
            )?;
            let toggle_startup_item = toggle_startup.clone();
            let toggle_autosize_item = toggle_autosize.clone();
            app.manage(StartupMenuItem(toggle_startup.clone()));
            app.manage(AutosizeMenuItem(toggle_autosize.clone()));

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tauri::include_image!("icons/tray-icon.png"))
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show_hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_centered_window(&window);
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    "toggle_startup" => {
                        let autostart = app.autolaunch();
                        let enabled = !autostart.is_enabled().unwrap_or(false);
                        if enabled {
                            let _ = autostart.enable();
                        } else {
                            let _ = autostart.disable();
                        }
                        STARTUP_MENU_ENABLED.store(enabled, Ordering::SeqCst);
                        let _ = toggle_startup_item.set_checked(enabled);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window
                                .eval(&format!("window.kantrackSetLaunchAtLogin?.({enabled})"));
                        }
                    }
                    "toggle_autosize" => {
                        let enabled = !AUTOSIZE_MENU_ENABLED.load(Ordering::SeqCst);
                        AUTOSIZE_MENU_ENABLED.store(enabled, Ordering::SeqCst);
                        let _ = toggle_autosize_item.set_checked(enabled);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ =
                                window.eval(&format!("window.kantrackSetAutosize?.({enabled})"));
                        }
                    }
                    "settings" => {
                        open_settings_window(app, false);
                    }
                    "check_updates" => {
                        open_settings_window(app, true);
                    }
                    _ => {}
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
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = rect;
                            toggle_centered_window(&window);
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(false)) {
                let _ = window.hide();
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                center_window_horizontally(window);
            }
            if window.label() == "settings" && matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = window
                    .app_handle()
                    .set_activation_policy(ActivationPolicy::Accessory);
                let _ = window.app_handle().set_dock_visibility(false);
            }
        })
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            update_main_window_layout,
            sync_startup_menu,
            sync_autosize_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowLayout {
    height: Option<f64>,
    min_width: f64,
    width: Option<f64>,
    animate: Option<bool>,
}

#[tauri::command]
fn update_main_window_layout(app: tauri::AppHandle, layout: MainWindowLayout) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let monitor = match window.current_monitor().ok().flatten() {
        Some(monitor) => monitor,
        None => return,
    };
    let scale = monitor.scale_factor();
    let current_size = window.outer_size().unwrap_or(PhysicalSize::new(560, 430));
    let current_width = current_size.width as f64 / scale;
    let current_height = current_size.height as f64 / scale;
    let max_width = (monitor.size().width as f64 / scale - 32.0).max(360.0);
    let min_width = layout
        .min_width
        .min(max_width)
        .max(560.0_f64.min(max_width));
    let target_width = layout
        .width
        .unwrap_or(current_width)
        .max(min_width)
        .min(max_width);
    let max_height = (monitor.size().height as f64 / scale - 64.0).max(360.0);
    let min_height = 200.0;

    let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(min_width, min_height))));

    let target_height = layout
        .height
        .map(|height| height.clamp(min_height, max_height))
        .unwrap_or(current_height);

    if (target_width - current_width).abs() > 1.0 || (target_height - current_height).abs() > 1.0 {
        if layout.animate.unwrap_or(true) {
            animate_main_window_size(window, target_width, target_height);
        } else {
            let _ = window.set_size(Size::Logical(LogicalSize::new(target_width, target_height)));
            position_window_top_center(&window);
        }
    }
}

#[tauri::command]
fn sync_autosize_menu(enabled: bool, item: State<'_, AutosizeMenuItem>) {
    AUTOSIZE_MENU_ENABLED.store(enabled, Ordering::SeqCst);
    let _ = item.0.set_checked(enabled);
}

#[tauri::command]
fn sync_startup_menu(enabled: bool, item: State<'_, StartupMenuItem>) {
    STARTUP_MENU_ENABLED.store(enabled, Ordering::SeqCst);
    let _ = item.0.set_checked(enabled);
}

fn animate_main_window_size(window: WebviewWindow, target_width: f64, target_height: f64) {
    let generation = WINDOW_ANIMATION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let monitor = match window.current_monitor().ok().flatten() {
        Some(monitor) => monitor,
        None => return,
    };
    let scale = monitor.scale_factor();
    let current_size = window.outer_size().unwrap_or(PhysicalSize::new(560, 430));
    let start_width = current_size.width as f64 / scale;
    let start_height = current_size.height as f64 / scale;
    let width_delta = target_width - start_width;
    let height_delta = target_height - start_height;

    if width_delta.abs().max(height_delta.abs()) < 12.0 {
        let _ = window.set_size(Size::Logical(LogicalSize::new(target_width, target_height)));
        position_window_top_center(&window);
        return;
    }

    std::thread::spawn(move || {
        let steps = 9;
        for step in 1..=steps {
            if WINDOW_ANIMATION_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let t = step as f64 / steps as f64;
            let eased = 1.0 - (1.0 - t).powi(3);
            let width = start_width + width_delta * eased;
            let height = start_height + height_delta * eased;
            let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
            position_window_top_center(&window);
            std::thread::sleep(Duration::from_millis(14));
        }
    });
}

fn open_settings_window(app: &tauri::AppHandle, check_updates: bool) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let _ = app.set_dock_visibility(true);

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        if check_updates {
            let _ = window.eval("window.dispatchEvent(new CustomEvent('kantrack-check-updates'))");
        }
        return;
    }

    let settings_url = if check_updates {
        WebviewUrl::App("settings.html?checkUpdates=1".into())
    } else {
        WebviewUrl::App("settings.html".into())
    };

    if let Ok(window) = WebviewWindowBuilder::new(app, "settings", settings_url)
        .title("KanTrack Settings")
        .inner_size(560.0, 620.0)
        .min_inner_size(520.0, 560.0)
        .resizable(false)
        .decorations(true)
        .skip_taskbar(false)
        .focused(true)
        .build()
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_centered_window(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let _ = window.eval("window.kantrackPrepareForShow?.()");
    std::thread::sleep(Duration::from_millis(90));
    position_window_top_center(window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.eval("window.kantrackRestoreSelection?.()");
}

fn position_window_top_center(window: &WebviewWindow) {
    let window_size = window.outer_size().unwrap_or(PhysicalSize::new(560, 430));
    let monitor = match window.current_monitor().ok().flatten() {
        Some(monitor) => monitor,
        None => return,
    };

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let target_x = monitor_pos.x + ((monitor_size.width as i32 - window_size.width as i32) / 2);
    let top_margin = (24.0 * monitor.scale_factor()).round() as i32;
    let target_y = monitor_pos.y + top_margin;

    let _ = window.set_position(PhysicalPosition::new(target_x, target_y));
}

fn center_window_horizontally(window: &Window) {
    let window_size = window.outer_size().unwrap_or(PhysicalSize::new(560, 430));
    let window_pos = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 24));
    let monitor = match window.current_monitor().ok().flatten() {
        Some(monitor) => monitor,
        None => return,
    };

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let target_x = monitor_pos.x + ((monitor_size.width as i32 - window_size.width as i32) / 2);

    if (window_pos.x - target_x).abs() > 1 {
        let _ = window.set_position(PhysicalPosition::new(target_x, window_pos.y));
    }
}
