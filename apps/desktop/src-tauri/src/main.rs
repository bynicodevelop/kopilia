//! Kopilia, l'application : la page de Kopilia dans sa fenêtre à elle, la touche
//! pour parler même quand tu es sur une autre application (TradingView), son
//! serveur lancé s'il ne tourne pas, et son état dans la barre des menus.
//!
//! La page est celle que sert le serveur (http://127.0.0.1:4317 par défaut) :
//! rien n'est copié dans l'application, elle suit chaque nouvelle version du
//! site. Tant que le serveur ne répond pas, une page d'attente s'affiche.
//! Fermer la fenêtre la cache : Kopilia continue de t'entendre (⌥ droite) et de
//! parler ; « Quitter » ferme l'application, le serveur continue.
//!
//! Options (open Kopilia.app --args …) : `--url <adresse>` (ou KOPILIA_URL),
//! `--repo <dossier de Kopilia>` (par défaut celui où l'application a été
//! construite), `--no-server` (ne jamais lancer le serveur : une page d'essai),
//! `--hidden` (sans fenêtre, l'icône seule : l'ouverture avec le Mac).
//! Kopilia déjà ouverte, `open -n Kopilia.app --args --restart-server` relance
//! son serveur ; sans option, montre sa fenêtre.

mod keys;
mod presence;
mod server;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

const DEFAULT_URL: &str = "http://127.0.0.1:4317/";

/// La page du serveur est chargée (et non la page d'attente).
static ON_PAGE: AtomicBool = AtomicBool::new(false);

struct Options {
    url: Url,
    repo: PathBuf,
    manage_server: bool,
    hidden: bool,
}

fn options() -> Options {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    let url = value("--url")
        .or_else(|| std::env::var("KOPILIA_URL").ok())
        .and_then(|u| u.parse().ok())
        .unwrap_or_else(|| DEFAULT_URL.parse().unwrap());
    let repo = value("--repo").map(PathBuf::from).unwrap_or_else(server::default_repo);
    let has = |flag: &str| args.iter().any(|a| a == flag);
    Options { url, repo, manage_server: !has("--no-server"), hidden: has("--hidden") }
}

fn main() {
    let o = options();
    keys::log(format!("démarrage, page : {}, dossier : {}", o.url, o.repo.display()));
    let url = o.url.clone();
    server::init(server::Config { url: o.url.clone(), repo: o.repo.clone() });

    let app = tauri::Builder::default()
        // Une seule Kopilia : la rouvrir (Finder, ouverture avec le Mac) montre celle qui tourne.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--restart-server") {
                keys::log("serveur : relance demandée par --restart-server");
                server::restart();
            } else if args.iter().any(|a| a == "--hidden") {
                tray::hide_window(app);
            } else {
                tray::show_window(app);
            }
        }))
        // Ouverte avec le Mac : sans fenêtre, l'icône seule dans la barre des menus.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(keys::option_space_plugin())
        .setup(move |app| {
            let page = url.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kopilia")
                .inner_size(1440.0, 900.0)
                .min_inner_size(720.0, 480.0)
                // Derrière TradingView, la page continue de tourner à pleine vitesse :
                // ses minuteries (la règle des 0,2 s de ⌥ droite) ne sont pas ralenties.
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .initialization_script(keys::INIT_SCRIPT)
                .on_page_load(move |w, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        ON_PAGE.store(payload.url().origin() == page.origin(), Ordering::SeqCst);
                        keys::announce(&w);
                        if !ON_PAGE.load(Ordering::SeqCst) {
                            show_waiting(&w, server::state());
                        }
                    }
                })
                .build()?;
            // Fermer la fenêtre la cache : la page continue d'écouter et de parler.
            let hide = window.clone();
            window.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = hide.hide();
                }
            });

            // `--hidden` : montrée le temps que le micro s'ouvre (macOS ne l'ouvre pas avant), puis rangée.
            tray::HIDE_WHEN_ARMED.store(o.hidden, std::sync::atomic::Ordering::SeqCst);
            tray::build(app.handle())?;
            let (w, page) = (window.clone(), url.clone());
            server::watch(move |s| {
                keys::log(format!("serveur : {s:?}"));
                if !ON_PAGE.load(Ordering::SeqCst) {
                    if s == server::State::Up {
                        let _ = w.navigate(page.clone());
                    } else {
                        show_waiting(&w, s);
                    }
                }
                tray::refresh();
            });
            if o.manage_server {
                server::start();
            }
            keys::start(app.handle().clone());
            presence::watch();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Kopilia n'a pas pu démarrer");

    app.run(|app, event| {
        // Clic sur l'icône du Dock, fenêtre cachée : elle revient.
        if let RunEvent::Reopen { .. } = event {
            tray::show_window(app);
        }
    });
}

/// La page d'attente dit où en est le serveur.
fn show_waiting<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, s: server::State) {
    let text = tray::waiting_text(s).replace('\'', "\\'");
    // Serveur arrêté : la boule se calme ; il démarre : elle s'agite.
    let busy = s != server::State::Down;
    let _ = w.eval(format!("window.kopiliaStatus?.('{text}', {busy})"));
}
