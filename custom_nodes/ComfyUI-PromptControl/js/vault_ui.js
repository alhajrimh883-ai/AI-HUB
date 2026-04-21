import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "PromptVaults.UI",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (["CharacterVault", "PoseVault", "ClothesVault"].includes(nodeData.name)) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                
                let vaultType = "char";
                let btnLabel = "🌐 Manage Characters";
                
                if (nodeData.name === "PoseVault") {
                    vaultType = "pose";
                    btnLabel = "🌐 Manage Poses";
                } else if (nodeData.name === "ClothesVault") {
                    vaultType = "clothes";
                    btnLabel = "🌐 Manage Clothes";
                }

                this.addWidget("button", btnLabel, "manage", () => {
                    window.open(`/vault_manager?type=${vaultType}`, '_blank');
                });

                return r;
            };
        }
    }
});