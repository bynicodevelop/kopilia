//! La touche pour parler, où que tu sois (sur TradingView, Kopilia derrière) :
//!
//! - ⌥ droite seule : écoute du clavier de tout le Mac (`CGEventTap`, en
//!   lecture seule). Demande une fois l'autorisation « Surveillance de
//!   l'entrée » ; sans elle, ⌥ droite ne marche que la fenêtre de Kopilia devant.
//! - ⌥ Espace : raccourci global (Carbon), sans autorisation.
//!
//! Les évènements partent à la page comme ceux de son propre clavier
//! (évènement `kopilia-key`, mêmes champs qu'un KeyboardEvent) : c'est elle qui
//! décide (règle des 0,2 s, appui bref, raccourci annulé), avec le même code.
//! Rien ne part tant qu'aucun ⌥ n'est enfoncé : la page ne voit jamais ce que
//! tu tapes ailleurs, et pendant un geste, une autre touche n'arrive que comme
//! « Other », sans dire laquelle.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, Wry};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Avant tout script de la page : elle est dans l'application, sans écoute du clavier pour l'instant, toi devant.
pub const INIT_SCRIPT: &str = "window.__KOPILIA_APP__ = { tap: false, away: false };";

static APP: OnceLock<AppHandle> = OnceLock::new();
/// L'écoute du clavier de tout le Mac est en place.
static TAP_ON: AtomicBool = AtomicBool::new(false);
static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// ⌥ enfoncés : bit 1 = gauche, bit 2 = droite.
static OPTIONS: AtomicU8 = AtomicU8::new(0);
/// L'appui sur Espace d'un ⌥ Espace est parti à la page : son relâchement aussi doit partir.
static SPACE_SENT: AtomicBool = AtomicBool::new(false);

/* ------------------------------ Journal ------------------------------ */

/// Une ligne dans ~/Library/Logs/Kopilia/kopilia.log : démarrage, autorisations, serveur, état affiché (jamais quelle touche).
pub fn log(msg: impl AsRef<str>) {
    use std::io::Write;
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::Path::new(&home).join("Library/Logs/Kopilia");
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("kopilia.log");
    if std::fs::metadata(&file).map(|m| m.len() > 5 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("kopilia.log.1")); // mis de côté au-delà de 5 Mo
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = writeln!(f, "{t} {}", msg.as_ref());
    }
}

/* ----------------------------- Vers la page ----------------------------- */

/// Dit à la page si l'écoute du clavier est en place (si oui, elle laisse ses propres touches de côté)
/// et si tu es absent (Mac verrouillé ou inactif : elle le dit au serveur à la place de sa visibilité).
pub fn announce<R: Runtime>(w: &WebviewWindow<R>) {
    let tap = TAP_ON.load(Ordering::SeqCst);
    let away = crate::presence::away();
    let _ = w.eval(format!(
        "window.__KOPILIA_APP__ = {{ tap: {tap}, away: {away} }}; window.dispatchEvent(new CustomEvent('kopilia-app'));"
    ));
}

pub fn announce_all() {
    if let Some(w) = APP.get().and_then(|a| a.get_webview_window("main")) {
        announce(&w);
    }
    crate::tray::refresh();
}

/// L'écoute du clavier de tout le Mac est en place (« Surveillance de l'entrée » donnée).
pub fn tap_on() -> bool {
    TAP_ON.load(Ordering::SeqCst)
}

const ALT: u64 = 0x0008_0000;
const SHIFT: u64 = 0x0002_0000;
const CTRL: u64 = 0x0004_0000;
const CMD: u64 = 0x0010_0000;

/// Un évènement clavier pour la page. `t` : l'heure (ms) où il a eu lieu, pour mesurer le délai.
fn send(kind: &str, code: &str, flags: u64, repeat: bool) {
    let Some(w) = APP.get().and_then(|a| a.get_webview_window("main")) else {
        return;
    };
    let key = match code {
        "AltRight" | "AltLeft" => "Alt",
        "Space" => " ",
        _ => "",
    };
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let on = |m: u64| flags & m != 0;
    let _ = w.eval(format!(
        "window.dispatchEvent(new CustomEvent('kopilia-key', {{ detail: {{ type: '{kind}', code: '{code}', key: '{key}', \
         altKey: {}, shiftKey: {}, ctrlKey: {}, metaKey: {}, repeat: {repeat}, t: {t} }} }}));",
        on(ALT),
        on(SHIFT),
        on(CTRL),
        on(CMD),
    ));
}

/* ------------------------------ ⌥ Espace ------------------------------ */

/// ⌥ Espace, raccourci global : marche sans autorisation. Avec l'écoute du
/// clavier, l'appui arrive souvent deux fois (elle et lui) : sans effet, la
/// page traite un ⌥ Espace déjà en cours comme le même geste.
pub fn option_space_plugin() -> TauriPlugin<Wry> {
    let option_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(option_space)
        .expect("⌥ Espace")
        .with_handler(move |_app, shortcut, event| {
            if shortcut != &option_space {
                return;
            }
            log(format!("⌥ Espace (raccourci global) : {:?}", event.state()));
            match event.state() {
                ShortcutState::Pressed => {
                    if !SPACE_SENT.swap(true, Ordering::SeqCst) {
                        send("keydown", "Space", ALT, false);
                    }
                }
                ShortcutState::Released => {
                    if SPACE_SENT.swap(false, Ordering::SeqCst) {
                        send("keyup", "Space", 0, false);
                    }
                }
            }
        })
        .build()
}

/* ------------------------ ⌥ droite, l'écoute du clavier ------------------------ */

type CGEventTapCallBack = extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: CGEventTapCallBack, user: *mut c_void) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

const SESSION_TAP: u32 = 1;
const HEAD_INSERT: u32 = 0;
const LISTEN_ONLY: u32 = 1;
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
const FIELD_AUTOREPEAT: u32 = 8;
const FIELD_KEYCODE: u32 = 9;
/// Quel ⌥ est enfoncé (bits propres au clavier, dans les drapeaux de l'évènement).
const LEFT_ALT_BIT: u64 = 0x20;
const RIGHT_ALT_BIT: u64 = 0x40;

const KC_SPACE: i64 = 49;
const KC_LEFT_OPTION: i64 = 58;
const KC_RIGHT_OPTION: i64 = 61;

/// La touche de modification d'un code (⌘, ⇧, ⌃, Verr. Maj, fn) : son drapeau.
fn modifier_flag(keycode: i64) -> Option<u64> {
    match keycode {
        54 | 55 => Some(CMD),
        56 | 60 => Some(SHIFT),
        59 | 62 => Some(CTRL),
        57 => Some(0x0001_0000),
        63 => Some(0x0080_0000),
        _ => None,
    }
}

extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: *mut c_void, _user: *mut c_void) -> *mut c_void {
    if kind == DISABLED_BY_TIMEOUT || kind == DISABLED_BY_USER_INPUT {
        // macOS coupe une écoute qu'il juge trop lente : on la remet aussitôt.
        unsafe { CGEventTapEnable(TAP_PORT.load(Ordering::SeqCst), true) };
        return event;
    }
    let (keycode, flags) = unsafe { (CGEventGetIntegerValueField(event, FIELD_KEYCODE), CGEventGetFlags(event)) };
    let option_key = kind == FLAGS_CHANGED && (keycode == KC_RIGHT_OPTION || keycode == KC_LEFT_OPTION);
    // Un relâchement manqué ne laisse rien d'enfoncé. Pas sur le relâchement de ⌥ lui-même :
    // il doit encore voir qu'il était enfoncé, sinon il ne partirait jamais à la page.
    if !option_key && flags & ALT == 0 {
        OPTIONS.store(0, Ordering::SeqCst);
    }
    match kind {
        FLAGS_CHANGED => match keycode {
            KC_RIGHT_OPTION | KC_LEFT_OPTION => {
                let (bit, side_bit, code) = if keycode == KC_RIGHT_OPTION {
                    (2, RIGHT_ALT_BIT, "AltRight")
                } else {
                    (1, LEFT_ALT_BIT, "AltLeft")
                };
                let down = flags & side_bit != 0;
                let before = if down { OPTIONS.fetch_or(bit, Ordering::SeqCst) } else { OPTIONS.fetch_and(!bit, Ordering::SeqCst) };
                if (before & bit != 0) != down {
                    send(if down { "keydown" } else { "keyup" }, code, flags, false);
                }
            }
            other => {
                // ⌘, ⇧, ⌃… enfoncée pendant un ⌥ : la page annule (c'était un raccourci).
                if OPTIONS.load(Ordering::SeqCst) != 0 && modifier_flag(other).is_some_and(|m| flags & m != 0) {
                    send("keydown", "Other", flags, false);
                }
            }
        },
        KEY_DOWN => {
            if OPTIONS.load(Ordering::SeqCst) != 0 {
                let repeat = unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } != 0;
                if keycode == KC_SPACE {
                    SPACE_SENT.store(true, Ordering::SeqCst);
                    send("keydown", "Space", flags, repeat);
                } else {
                    send("keydown", "Other", flags, repeat);
                }
            }
        }
        KEY_UP => {
            if keycode == KC_SPACE && SPACE_SENT.swap(false, Ordering::SeqCst) {
                send("keyup", "Space", flags, false);
            }
        }
        _ => {}
    }
    event
}

/// Crée l'écoute et la fait tourner sur ce fil (ne revient pas). Faux : pas d'autorisation.
fn run_tap() -> bool {
    let mask = (1u64 << KEY_DOWN) | (1u64 << KEY_UP) | (1u64 << FLAGS_CHANGED);
    unsafe {
        let port = CGEventTapCreate(SESSION_TAP, HEAD_INSERT, LISTEN_ONLY, mask, on_event, std::ptr::null_mut());
        if port.is_null() {
            log("écoute du clavier : refusée par macOS");
            return false;
        }
        log("écoute du clavier : en place");
        TAP_PORT.store(port, Ordering::SeqCst);
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(port, true);
        TAP_ON.store(true, Ordering::SeqCst);
        announce_all();
        CFRunLoopRun();
    }
    true
}

/// Lance l'écoute du clavier. Sans autorisation, macOS la demande une fois, et
/// l'écoute démarre dès qu'elle est donnée (vérifiée toutes les 2 s).
pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| {
        let mut asked = false;
        loop {
            let allowed = unsafe { CGPreflightListenEventAccess() };
            if allowed && run_tap() {
                return;
            }
            if !asked {
                log(format!("Surveillance de l'entrée : {}", if allowed { "donnée" } else { "pas encore donnée, demandée" }));
                unsafe { CGRequestListenEventAccess() };
                asked = true;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}
