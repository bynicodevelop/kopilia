//! Es-tu devant ton Mac ? Dans l'application, la fenêtre de Kopilia est souvent
//! cachée ou derrière TradingView alors que tu es là : « page cachée » ne dit
//! plus ton absence. Ici, tu es absent quand le Mac est verrouillé, ou sans
//! clavier ni souris depuis 3 minutes (toutes applications confondues). La
//! page le dit au serveur à la place de sa visibilité : ce que Kopilia dit part
//! alors aussi sur Telegram.
//!
//! Aucune autorisation : macOS donne à toute application le temps écoulé
//! depuis la dernière action, pas laquelle.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::keys::{self, log};

/// Sans clavier ni souris depuis ce temps (s), tu es absent. `KOPILIA_AWAY_AFTER` (s) le change, pour un essai.
const AWAY_AFTER_SECS: f64 = 180.0;

static AWAY: AtomicBool = AtomicBool::new(false);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGSessionCopyCurrentDictionary() -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(alloc: *const c_void, s: *const std::ffi::c_char, encoding: u32) -> *const c_void;
    fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
    fn CFBooleanGetValue(b: *const c_void) -> bool;
    fn CFRelease(cf: *const c_void);
}

const COMBINED_SESSION_STATE: i32 = 0;
const ANY_INPUT_EVENT: u32 = u32::MAX;
const UTF8: u32 = 0x0800_0100;

/// Tu es absent (Mac verrouillé, ou inactif depuis 3 min).
pub fn away() -> bool {
    AWAY.load(Ordering::SeqCst)
}

/// Secondes depuis ta dernière action, clavier ou souris, dans n'importe quelle application.
fn idle_secs() -> f64 {
    unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) }
}

/// L'écran est verrouillé.
fn screen_locked() -> bool {
    unsafe {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return false;
        }
        let key = CFStringCreateWithCString(std::ptr::null(), c"CGSSessionScreenIsLocked".as_ptr(), UTF8);
        let value = CFDictionaryGetValue(dict, key);
        let locked = !value.is_null() && CFBooleanGetValue(value);
        CFRelease(key);
        CFRelease(dict);
        locked
    }
}

/// Regarde toutes les 5 s si tu es là ; à chaque changement, la page le sait (et le serveur par elle).
pub fn watch() {
    let after = std::env::var("KOPILIA_AWAY_AFTER").ok().and_then(|s| s.parse().ok()).unwrap_or(AWAY_AFTER_SECS);
    std::thread::spawn(move || loop {
        let (idle, locked) = (idle_secs(), screen_locked());
        let now = locked || idle >= after;
        if AWAY.swap(now, Ordering::SeqCst) != now {
            log(if !now {
                "présence : de retour".to_string()
            } else if locked {
                "présence : absent (Mac verrouillé)".to_string()
            } else {
                format!("présence : absent (inactif depuis {} s)", idle.round())
            });
            keys::announce_all();
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}
