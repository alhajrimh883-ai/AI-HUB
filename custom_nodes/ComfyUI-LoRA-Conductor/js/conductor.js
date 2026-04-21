import { app } from "../../scripts/app.js";

const CONDUCTOR_NODE = "LoRAConductor";
const MAX_SLOTS = 20;

app.registerExtension({
    name: "LoRAConductor.DynamicSlots",

    async beforeRegisterNodeDef(nodeType, nodeData, appRef) {
        if (nodeData.name !== CONDUCTOR_NODE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            // Track visible slot count
            this._visibleSlots = 1;

            // Fetch lora list for new slots
            this._loraList = null;
            this._fetchLoraList();

            // Style the node
            this._updateSize();
        };

        // Fetch LoRA file list from the server
        nodeType.prototype._fetchLoraList = async function () {
            try {
                const resp = await fetch("/object_info/" + CONDUCTOR_NODE);
                const data = await resp.json();
                const info = data[CONDUCTOR_NODE];
                if (info && info.input) {
                    // Get list from lora_1 (required) or lora_2 (optional)
                    const req = info.input.required || {};
                    const opt = info.input.optional || {};
                    const source = req.lora_1 || opt.lora_2;
                    if (source && Array.isArray(source[0])) {
                        this._loraList = source[0];
                    }
                }
            } catch (e) {
                console.log("[LoRA Conductor] Could not fetch LoRA list:", e);
            }
        };

        // Add LoRA slot
        nodeType.prototype.addLoraSlot = function () {
            const nextIdx = this._visibleSlots + 1;
            if (nextIdx > MAX_SLOTS) {
                console.log("[LoRA Conductor] Max slots reached");
                return;
            }

            const inputName = `lora_${nextIdx}`;

            // Check if input already exists (from loading saved workflow)
            if (this.inputs && this.inputs.find(inp => inp.name === inputName)) {
                this._visibleSlots = nextIdx;
                this._updateSize();
                return;
            }

            // Add as optional input with combo widget
            const loraList = this._loraList || ["None"];

            this.addInput(inputName, loraList);

            // ComfyUI needs a widget for combo inputs
            const widget = this.addWidget("combo", inputName, "None", () => {}, {
                values: loraList,
            });
            widget.label = `LoRA ${nextIdx}`;

            this._visibleSlots = nextIdx;
            this._updateSize();
            this.setDirtyCanvas(true, true);
        };

        // Remove last LoRA slot
        nodeType.prototype.removeLoraSlot = function () {
            if (this._visibleSlots <= 1) return;

            const idx = this._visibleSlots;
            const inputName = `lora_${idx}`;

            // Remove widget
            const widgetIdx = this.widgets?.findIndex(w => w.name === inputName);
            if (widgetIdx !== undefined && widgetIdx >= 0) {
                this.widgets.splice(widgetIdx, 1);
            }

            // Remove input
            const inputIdx = this.inputs?.findIndex(inp => inp.name === inputName);
            if (inputIdx !== undefined && inputIdx >= 0) {
                this.removeInput(inputIdx);
            }

            this._visibleSlots--;
            this._updateSize();
            this.setDirtyCanvas(true, true);
        };

        nodeType.prototype._updateSize = function () {
            if (this.computeSize) {
                this.setSize(this.computeSize());
            }
        };

        // Add context menu options
        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            if (origGetExtraMenuOptions) {
                origGetExtraMenuOptions.apply(this, arguments);
            }

            options.unshift(
                {
                    content: `\u2795 Add LoRA (${this._visibleSlots || 1}/${MAX_SLOTS})`,
                    callback: () => { this.addLoraSlot(); },
                    disabled: (this._visibleSlots || 1) >= MAX_SLOTS,
                },
                {
                    content: "\u2796 Remove last LoRA",
                    callback: () => { this.removeLoraSlot(); },
                    disabled: (this._visibleSlots || 1) <= 1,
                },
                null  // separator
            );
        };

        // Serialize slot count
        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (origOnSerialize) origOnSerialize.apply(this, arguments);
            o._visibleSlots = this._visibleSlots || 1;
        };

        // Restore slot count on load
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (origOnConfigure) origOnConfigure.apply(this, arguments);

            const savedSlots = info._visibleSlots || 1;
            this._visibleSlots = 1; // Reset, addLoraSlot increments

            // Re-add slots up to saved count
            if (savedSlots > 1) {
                this._fetchLoraList().then(() => {
                    for (let i = 2; i <= savedSlots; i++) {
                        this.addLoraSlot();
                    }
                });
            }
        };
    },
});
