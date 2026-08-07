import { app } from "@azure/functions";

app.setup({ enableHttpStream: true });

// Import modules for side-effect registration
import "./functions/clear-mail-queue.js";
import "./functions/notify.js";
import "./functions/process-mail.js";
import "./functions/helpdesk.js";
import "./functions/renew-subscriptions.js";
import "./functions/sweep-inbox.js";
import "./functions/mail-poison.js";
import "./functions/sync-teams.js";
