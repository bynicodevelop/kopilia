import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { adoptLegacyStorage } from "./app/legacy-storage";

try {
  adoptLegacyStorage(localStorage);
} catch {
  /* stockage indisponible (navigation privée) : rien à reprendre */
}

bootstrapApplication(AppComponent).catch((err) => console.error(err));
