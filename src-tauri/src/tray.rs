use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/**
 * 显示并激活主窗口（最小化时先恢复）
 * @param app Tauri 应用句柄
 */
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // 如果窗口最小化了，先恢复
        let _ = window.unminimize();
        // 显示window窗口
        let _ = window.show();
        // 然后将窗口激活、置顶
        let _ = window.set_focus();
    }
}

/**
 * 系统托盘
 * @param app Tauri 应用句柄
 */
pub fn smom_menu(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, "show", "SMOM", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出平台", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        // 左键菜单关闭：左键点击显示窗口，右键弹出菜单
        .show_menu_on_left_click(false)
        // 左键单击托盘图标 → 显示并激活主窗口
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                std::process::exit(0);
            }
            "show" => {
                show_main_window(app);
            }
            _ => {
                println!("菜单项 {:?} 未处理", event.id);
            }
        })
        .build(app)?;
    Ok(tray)
}
