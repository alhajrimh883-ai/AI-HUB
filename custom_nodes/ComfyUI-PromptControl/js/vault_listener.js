import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Listen for the special message from our HTML manager
api.addEventListener("vault_trigger_queue", () => {
    console.log("Vault Manager requested generation! Queueing prompt...");
    // This is the code that literally clicks the "Queue Prompt" button for you
    app.queuePrompt(0); 
});