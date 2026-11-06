import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { KopiliaService } from "../kopilia.service";
import { ACCEPTED_DOCUMENTS, docMeta, docType } from "../documents/documents";

/**
 * Le bas de l'écran : les documents en attente, et de quoi en joindre un. On
 * parle à Kopilia en tenant ⌥ droite : ni décroché, ni micro à couper. À
 * hauteur fixe : rien ne déplace le bouton. Dans le pied de la coquille (ses
 * enfants s'y placent directement).
 */
@Component({
  selector: "kp-call-bar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host { display: contents; }
      /* Le bas de l'écran laisse passer les clics vers les encarts : seuls le bouton et les documents les arrêtent. */
      .call { display: flex; justify-content: center; width: 100%; max-width: 360px; pointer-events: auto; }
      .slot { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .callbtn {
        width: 52px; height: 52px; border-radius: 50%; padding: 0; display: grid; place-items: center;
        background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
        transition: transform .15s ease, border-color .2s ease;
      }
      .callbtn svg { width: 24px; height: 24px; }
      .callbtn:hover:not(:disabled) { transform: scale(1.05); }
      .callbtn:active:not(:disabled) { transform: scale(.95); }
      .callbtn:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
      .calllabel { font-size: 12px; color: var(--muted); }

      /* ---------- Documents déposés : ils partent avec la prochaine phrase ---------- */
      /* Au-dessus des boutons, sans changer leur place (ni celle de l'orbe). */
      .docs {
        position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; pointer-events: auto;
        list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
      }
      .doc {
        display: flex; align-items: center; gap: 8px; max-width: 280px;
        background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px 4px 6px 8px;
      }
      .doc.busy { opacity: .7; }
      .doc-type {
        font-size: 10px; font-weight: 600; letter-spacing: .04em; color: var(--accent);
        border: 1px solid currentColor; border-radius: 4px; padding: 1px 4px;
      }
      .doc-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
      .doc-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .doc-text small { font-size: 11px; color: var(--muted); }
    `,
  ],
  template: `
    @if (kopilia.documents().length) {
      <ul class="docs" aria-label="Documents à envoyer avec ta prochaine phrase">
        @for (d of kopilia.documents(); track d.localId) {
          <li class="doc" [class.busy]="d.status === 'uploading'">
            <span class="doc-type" aria-hidden="true">{{ docType(d.name) }}</span>
            <span class="doc-text">
              <span class="doc-name" [attr.title]="d.name">{{ d.name }}</span>
              <small>{{ docMeta(d) }}</small>
            </span>
            <button type="button" class="icon" [attr.aria-label]="'Retirer ' + d.name" (click)="kopilia.removeDocument(d.localId)">×</button>
          </li>
        }
      </ul>
    }
    <div class="call">
      <div class="slot">
        <button
          type="button"
          class="callbtn attach"
          aria-label="Joindre un document"
          title="Joindre un document — tu peux aussi le glisser dans la fenêtre ou coller une capture"
          [disabled]="!kopilia.connected()"
          (click)="picker.click()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" [attr.d]="attachIcon" /></svg>
        </button>
        <span class="calllabel">Joindre</span>
        <input #picker type="file" multiple hidden [accept]="acceptedDocuments" (change)="onPick(picker)" />
      </div>
    </div>
  `,
})
export class CallBarComponent {
  readonly kopilia = inject(KopiliaService);
  // Icône Material « attach_file » (Apache 2.0).
  readonly attachIcon =
    "M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z";
  readonly acceptedDocuments = ACCEPTED_DOCUMENTS;
  readonly docMeta = docMeta;
  readonly docType = docType;

  onPick(input: HTMLInputElement): void {
    this.kopilia.addFiles(Array.from(input.files ?? []));
    input.value = ""; // le même fichier pourra être choisi à nouveau
  }
}
