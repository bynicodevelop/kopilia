import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import { formatDateTime } from "../format";

/** Un brief de veille ouvert en plein écran. */
@Component({
  selector: "kp-brief-sheet",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .sheet { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow-y: auto; }
      .sheet-inner { max-width: 760px; margin: 0 auto; padding: 0 16px 48px; }
      header { display: flex; align-items: center; gap: 10px; padding: 18px 0 10px; }
      .sheet header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); }
      .sheet h1 { font-size: 18px; margin: 0; flex: 1; }
      .sheet time { font-size: 12px; color: var(--muted); }
      /* Le contenu du brief (innerHTML) est stylé dans styles.css : les styles
         de composant ne s'appliquent pas au HTML injecté. */
    `,
  ],
  template: `
    @if (kopilia.briefOpen(); as b) {
      <div class="sheet" role="dialog" aria-modal="true" [attr.aria-label]="b.title">
        <div class="sheet-inner">
          <header>
            <h1>{{ b.title }}</h1>
            <time>{{ when(b.createdAt) }}</time>
            <button type="button" class="icon" aria-label="Fermer le brief" (click)="kopilia.closeBrief()">×</button>
          </header>
          <!-- HTML échappé puis rendu par renderBrief ; liens ouverts dans un nouvel onglet. -->
          <article class="brief" [innerHTML]="b.html" (click)="openLink($event)"></article>
        </div>
      </div>
    }
  `,
})
export class BriefSheetComponent {
  readonly kopilia = inject(KopiliaService);
  readonly when = formatDateTime;

  /** Un lien du brief ne doit jamais remplacer la page (l'appel serait coupé). */
  openLink(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest("a");
    if (!a?.href || !/^https?:/.test(a.href)) return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener,noreferrer");
  }
}
