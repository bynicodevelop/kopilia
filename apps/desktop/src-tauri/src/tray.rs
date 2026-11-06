//! L'icône de Kopilia dans la barre des menus : où il en est, même sa fenêtre
//! derrière TradingView (vert : il t'écoute ; bleu : il parle ; rond plein :
//! prêt ; rond vide : serveur arrêté), et son menu : afficher la fenêtre,
//! relancer ou arrêter le serveur, ouvrir avec le Mac.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::keys::{self, log};
use crate::server::{self, State};

struct Tray {
    icon: TrayIcon,
    status: MenuItem<Wry>,
    keys: MenuItem<Wry>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
}

static TRAY: OnceLock<Tray> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
/// La phase affichée par la page (`hearing`, `speaking`…), lue toutes les 250 ms.
static PHASE: Mutex<String> = Mutex::new(String::new());
/// Ce qui est montré, pour ne rien redessiner sans changement.
static SHOWN: Mutex<String> = Mutex::new(String::new());
/// La dernière ligne d'état écrite au journal.
static LOGGED: Mutex<&str> = Mutex::new("");

const OFF: &[u8] = include_bytes!("../icons/tray/off.png");
const READY: &[u8] = include_bytes!("../icons/tray/ready.png");
const THINKING: &[u8] = include_bytes!("../icons/tray/thinking.png");
const HEARING: &[u8] = include_bytes!("../icons/tray/hearing.png");
const SPEAKING: &[u8] = include_bytes!("../icons/tray/speaking.png");

/// L'icône (et si macOS la teinte selon le thème) et la ligne d'état, d'après le serveur et la page.
fn look(server: State, phase: &str) -> (&'static [u8], bool, &'static str) {
    match server {
        State::Down => (OFF, true, "Serveur arrêté"),
        State::Starting => (OFF, true, "Démarrage du serveur…"),
        State::Stopping => (OFF, true, "Arrêt du serveur…"),
        State::Up => match phase {
            "hearing" => (HEARING, false, "Je t'écoute… lâche pour envoyer"),
            "thinking" => (THINKING, true, "Je réfléchis…"),
            "speaking" => (SPEAKING, false, "Kopilia parle"),
            "listening" => (READY, true, "Prêt : maintiens ⌥ droite pour parler"),
            // macOS n'ouvre le micro d'une page qu'une fois sa fenêtre montrée.
            "ready" => (OFF, true, "Micro pas encore ouvert : affiche Kopilia"),
            _ => (OFF, true, "Connexion à Kopilia…"),
        },
    }
}

/// Redessine l'icône et le menu si quelque chose a changé.
pub fn refresh() {
    let Some(t) = TRAY.get() else { return };
    let server = server::state();
    let phase = PHASE.lock().map(|p| p.clone()).unwrap_or_default();
    let tap = keys::tap_on();
    let key = format!("{server:?}|{phase}|{tap}");
    {
        let Ok(mut shown) = SHOWN.lock() else { return };
        if *shown == key {
            return;
        }
        *shown = key;
    }
    let (png, template, status) = look(server, &phase);
    if LOGGED.lock().map(|mut l| std::mem::replace(&mut *l, status) != status).unwrap_or(false) {
        log(format!("barre des menus : {status}"));
    }
    if let Ok(img) = Image::from_bytes(png) {
        let _ = t.icon.set_icon(Some(img));
        let _ = t.icon.set_icon_as_template(template);
    }
    let _ = t.icon.set_tooltip(Some(format!("Kopilia — {status}")));
    let _ = t.status.set_text(status);
    let _ = t.keys.set_text(if tap { "⌥ droite marche partout" } else { "Autoriser ⌥ droite partout…" });
    let _ = t.keys.set_enabled(!tap);
    let _ = t.start.set_text(if server == State::Down { "Démarrer le serveur" } else { "Relancer le serveur" });
    let _ = t.start.set_enabled(matches!(server, State::Down | State::Up));
    let _ = t.stop.set_enabled(server == State::Up);
}

/// Montre la fenêtre de Kopilia, devant.
pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Cache la fenêtre : la page continue d'écouter et de parler.
pub fn hide_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let _ = APP.set(app.clone());
    let status = MenuItem::with_id(app, "status", "Démarrage…", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Afficher Kopilia", true, None::<&str>)?;
    let keys_item = MenuItem::with_id(app, "keys", "Autoriser ⌥ droite partout…", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Relancer le serveur", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Arrêter le serveur", true, None::<&str>)?;
    let journal = MenuItem::with_id(app, "journal", "Journal du serveur", true, None::<&str>)?;
    let login_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Ouvrir Kopilia avec le Mac", true, login_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter (le serveur continue)", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[&status, &sep()?, &show, &keys_item, &sep()?, &start, &stop, &journal, &sep()?, &login, &sep()?, &quit],
    )?;
    let icon = TrayIconBuilder::with_id("kopilia")
        .icon(Image::from_bytes(OFF)?)
        .icon_as_template(true)
        .tooltip("Kopilia")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "keys" => {
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
                    .spawn();
            }
            "start" => {
                if server::state() == State::Down {
                    server::start();
                } else {
                    log("serveur : relance demandée depuis la barre des menus");
                    server::restart();
                }
                refresh();
            }
            "stop" => {
                log("serveur : arrêt demandé depuis la barre des menus");
                server::stop(|| ());
                refresh();
            }
            "journal" => {
                let _ = std::process::Command::new("open").arg(server::log_file()).spawn();
            }
            "login" => toggle_login(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    let _ = TRAY.set(Tray { icon, status, keys: keys_item, start, stop, login });
    refresh();
    poll_phase(app.clone());
    Ok(())
}

/// Ouvrir Kopilia avec le Mac, ou plus : c'est toi qui le coches.
fn toggle_login(app: &AppHandle) {
    let auto = app.autolaunch();
    let on = auto.is_enabled().unwrap_or(false);
    let res = if on { auto.disable() } else { auto.enable() };
    if let Err(e) = res {
        log(format!("ouverture avec le Mac : impossible ({e})"));
    }
    let now = auto.is_enabled().unwrap_or(on);
    log(format!("ouverture avec le Mac : {}", if now { "oui" } else { "non" }));
    if let Some(t) = TRAY.get() {
        let _ = t.login.set_checked(now);
    }
}

/// Ouverte avec le Mac (`--hidden`) : la fenêtre se range dès que le micro est ouvert.
/// macOS n'ouvre pas le micro d'une page jamais montrée ; une fois ouvert, il tient fenêtre cachée.
pub static HIDE_WHEN_ARMED: AtomicBool = AtomicBool::new(false);

/// Lit la phase de la page toutes les 250 ms (fenêtre cachée comprise).
fn poll_phase(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(w) = app.get_webview_window("main") {
            let hide = w.clone();
            let _ = w.eval_with_callback("(window.__kopiliaPhase?.() ?? null)", move |json| {
                let phase = json.trim().trim_matches('"').to_string();
                let armed = matches!(phase.as_str(), "listening" | "hearing" | "thinking" | "speaking");
                if armed && HIDE_WHEN_ARMED.swap(false, Ordering::SeqCst) {
                    log("ouverte avec le Mac : micro ouvert, fenêtre rangée");
                    let _ = hide.hide();
                }
                let changed = PHASE.lock().map(|mut p| if *p != phase { *p = phase; true } else { false }).unwrap_or(false);
                if changed {
                    refresh();
                }
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    });
}

/// La page d'attente dit où en est le serveur.
pub fn waiting_text(server: State) -> &'static str {
    match server {
        State::Starting => "Kopilia se réveille…",
        State::Stopping => "Kopilia arrête son serveur…",
        State::Down => "Le serveur de Kopilia est arrêté. Démarre-le depuis l'icône de Kopilia, dans la barre des menus.",
        State::Up => "Le serveur répond, la page s'ouvre…",
    }
}
