//! Le serveur de Kopilia, vu de l'application : il est lancé s'il ne répond pas
//! à l'ouverture, avec `scripts/start.sh` du dossier de Kopilia (comme
//! `pnpm start`), et se relance ou s'arrête depuis la barre des menus.
//!
//! Quitter l'application ne l'arrête pas : il continue de surveiller tes
//! alertes et d'écrire sur Telegram, page fermée. `pnpm stop` l'arrête aussi.
//! Sa sortie va dans ~/Library/Logs/Kopilia/serveur.log.

use std::fs::{File, OpenOptions};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::Url;

use crate::keys::log;

/// Où en est le serveur.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    /// Il ne répond pas, et l'application ne le lance pas.
    Down = 0,
    /// L'application le lance (ou le relance) : il ne répond pas encore.
    Starting = 1,
    Up = 2,
    Stopping = 3,
}

static STATE: AtomicU8 = AtomicU8::new(State::Down as u8);
static CONFIG: OnceLock<Config> = OnceLock::new();

pub struct Config {
    pub url: Url,
    /// Le dossier de Kopilia (celui de `pnpm start`).
    pub repo: PathBuf,
}

pub fn state() -> State {
    match STATE.load(Ordering::SeqCst) {
        1 => State::Starting,
        2 => State::Up,
        3 => State::Stopping,
        _ => State::Down,
    }
}

fn set_state(s: State) {
    STATE.store(s as u8, Ordering::SeqCst);
}

pub fn init(config: Config) {
    let _ = CONFIG.set(config);
}

fn config() -> &'static Config {
    CONFIG.get().expect("serveur : configuration absente")
}

/// Le dossier de Kopilia : `--repo`, sinon celui où l'application a été construite.
pub fn default_repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

/// Le serveur accepte une connexion.
pub fn reachable(url: &Url) -> bool {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs.any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(300)).is_ok())
}

/// Suit l'état du serveur (toutes les secondes) : il répond, ou plus.
pub fn watch(on_change: impl Fn(State) + Send + 'static) {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let up = reachable(&config().url);
            let cur = state();
            let next = match (cur, up) {
                (State::Stopping, _) => State::Stopping, // stop() dira quand c'est fini
                (_, true) => State::Up,
                (State::Starting, false) => State::Starting,
                _ => State::Down,
            };
            // Sans écraser un changement fait entre-temps (arrêt ou lancement demandé).
            let _ = STATE.compare_exchange(cur as u8, next as u8, Ordering::SeqCst, Ordering::SeqCst);
            let s = state();
            if last != Some(s) {
                last = Some(s);
                on_change(s);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Le PATH de ton terminal : ouverte depuis le Finder ou à l'ouverture de
/// session, l'application n'a que celui du système (ni node, ni pnpm).
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", "printf '<<PATH>>%s<<PATH>>' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.try_wait().ok()?.is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.split("<<PATH>>").nth(1).map(str::to_string)
}

/// Le journal du serveur, mis de côté au-delà de 20 Mo.
pub fn log_file() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Logs/Kopilia/serveur.log")
}

fn open_log() -> Option<File> {
    let path = log_file();
    let _ = std::fs::create_dir_all(path.parent()?);
    if std::fs::metadata(&path).map(|m| m.len() > 20 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Un script du dossier de Kopilia (start.sh, stop.sh), avec le PATH du terminal et le port de la page.
fn script(name: &str, path: &Option<String>) -> Command {
    let c = config();
    let mut cmd = Command::new("/bin/bash");
    cmd.arg(c.repo.join("scripts").join(name)).current_dir(&c.repo).stdin(Stdio::null());
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    if let Some(port) = c.url.port_or_known_default() {
        cmd.env("KOPILIA_PORT", port.to_string());
    }
    cmd
}

/// Lance le serveur s'il ne répond pas. Il tourne à part : quitter l'application ne l'arrête pas.
pub fn start() {
    if reachable(&config().url) || state() == State::Starting {
        return;
    }
    set_state(State::Starting);
    std::thread::spawn(|| {
        let path = login_path();
        if path.is_none() {
            log("serveur : PATH du terminal introuvable, celui du système est pris");
        }
        let Some(out) = open_log() else {
            log("serveur : journal impossible à ouvrir");
            set_state(State::Down);
            return;
        };
        let err = out.try_clone().ok();
        let mut cmd = script("start.sh", &path);
        cmd.stdout(out).stderr(err.map(Stdio::from).unwrap_or_else(Stdio::null)).process_group(0);
        match cmd.spawn() {
            Ok(mut child) => {
                log(format!("serveur : lancé depuis {}", config().repo.display()));
                let status = child.wait();
                log(format!("serveur : arrêté ({})", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string())));
                if state() == State::Starting {
                    set_state(State::Down); // il n'a jamais répondu : voir le journal
                }
            }
            Err(e) => {
                log(format!("serveur : lancement impossible ({e})"));
                set_state(State::Down);
            }
        }
    });
}

/// Arrête le serveur (comme `pnpm stop`), puis `then`.
pub fn stop(then: impl FnOnce() + Send + 'static) {
    set_state(State::Stopping);
    std::thread::spawn(move || {
        let path = login_path();
        let status = script("stop.sh", &path).stdout(Stdio::null()).stderr(Stdio::null()).status();
        log(format!("serveur : arrêt demandé ({})", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string())));
        // Le port se libère : attendre qu'il ne réponde plus (5 s au plus).
        let deadline = Instant::now() + Duration::from_secs(5);
        while reachable(&config().url) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        set_state(State::Down);
        then();
    });
}

pub fn restart() {
    stop(start);
}
