import { app } from "../../scripts/app.js";

// Register extension for both nodes that output text via UI
const TEXT_DISPLAY_NODES = ["QwenVLVideoAnalyzer", "VLMResponseDisplay"];

app.registerExtension({
    name: "vlm.video.sampler.display",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (!TEXT_DISPLAY_NODES.includes(nodeData.name)) return;

        // Hook into the node's onExecuted callback to show VLM response
        const origOnExecuted = nodeType.prototype.onExecuted;

        nodeType.prototype.onExecuted = function (message) {
            if (origOnExecuted) origOnExecuted.apply(this, arguments);

            if (!message || !message.text || !message.text[0]) return;

            const responseText = message.text[0];
            const sampledCount = message.sampled_count ? message.sampled_count[0] : null;
            const totalFrames = message.total_frames ? message.total_frames[0] : null;

            // Build header line
            let header = "";
            if (totalFrames !== null && sampledCount !== null) {
                header = `[${sampledCount} / ${totalFrames} frames sampled]\n\n`;
            }

            const fullText = header + responseText;

            // Find or create the display widget
            let widget = this.widgets?.find(w => w.name === "vlm_response_display");
            if (!widget) {
                widget = this.addWidget("customtext", "vlm_response_display", fullText, () => {}, {
                    multiline: true,
                    dynamicPrompts: false,
                });
                widget.inputEl.readOnly = true;
                widget.inputEl.style.opacity = "0.85";
                widget.inputEl.style.fontFamily = "monospace";
                widget.inputEl.style.fontSize = "11px";
                widget.inputEl.style.lineHeight = "1.4";
                widget.inputEl.style.padding = "8px";
                widget.inputEl.style.backgroundColor = "rgba(0,0,0,0.15)";
                widget.inputEl.style.border = "1px solid rgba(255,255,255,0.1)";
                widget.inputEl.style.borderRadius = "4px";
                widget.inputEl.style.color = "#e0e0e0";
                widget.inputEl.style.resize = "vertical";
                widget.inputEl.style.minHeight = "120px";
                widget.inputEl.style.maxHeight = "500px";
            }

            widget.value = fullText;
            if (widget.inputEl) {
                widget.inputEl.value = fullText;
            }

            // Resize node to accommodate the text
            this.setSize([
                Math.max(this.size[0], 420),
                this.computeSize()[1],
            ]);

            app.graph.setDirtyCanvas(true);
        };
    },
});
