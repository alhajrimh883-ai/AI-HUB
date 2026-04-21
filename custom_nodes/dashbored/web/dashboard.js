import { app } from "../../scripts/app.js";

function ensurePanel() {
  let panel = document.getElementById("dash-mini-panel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "dash-mini-panel";
  Object.assign(panel.style, {
    position: "fixed",
    top: "12px",
    right: "12px",
    width: "360px",
    background: "#111",
    color: "#eee",
    border: "1px solid #333",
    padding: "10px",
    zIndex: 99999,
    fontFamily: "system-ui, sans-serif",
    display: "none",
  });

  panel.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;">
      <div style="font-weight:600;flex:1;">Dashboard</div>
      <button id="dash-hide">Close</button>
    </div>
    <div style="margin-top:10px; display:flex; gap:8px;">
      <button id="dash-pick-toggle">Pick Nodes</button>
      <button id="dash-clear">Clear</button>
    </div>
    <div style="margin-top:10px; font-size:12px; color:#aaa;">Picked node IDs:</div>
    <pre id="dash-picked" style="margin-top:6px; white-space:pre-wrap; background:#0b0b0b; border:1px solid #222; padding:8px; color:#ddd;">(none)</pre>
  `;

  panel.querySelectorAll("button").forEach((b) => {
    Object.assign(b.style, {
      background: "#1b1b1d",
      color: "#eee",
      border: "1px solid #333",
      padding: "6px 10px",
      cursor: "pointer",
    });
  });

  document.body.appendChild(panel);
  return panel;
}

function attachButtonsWhenReady(getState) {
  const tryAttach = () => {
    const type = app?.registered_node_types?.["DashboardUI"];
    if (!type?.prototype) return false;

    const proto = type.prototype;
    if (proto.__dashmini_patched) return true;
    proto.__dashmini_patched = true;

    const orig = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      if (orig) orig.apply(this, arguments);

      this.addWidget("button", "Open Dashboard", null, () => {
        const { panel, render } = getState();
        panel.style.display = "block";
        render();
      });

      this.addWidget("button", "Pick Nodes", null, () => {
        const { panel, setPicking, picking, render } = getState();
        panel.style.display = "block";
        setPicking(!picking());
        render();
      });
    };

    return true;
  };

  if (tryAttach()) return;
  let n = 0;
  const t = setInterval(() => {
    if (tryAttach() || n++ > 60) clearInterval(t); // ~6s
  }, 100);
}

app.registerExtension({
  name: "dashboard_ui",

  setup() {
    const panel = ensurePanel();

    let _picking = false;
    const picked = new Set();

    const pickedEl = panel.querySelector("#dash-picked");
    const pickBtn = panel.querySelector("#dash-pick-toggle");

    function render() {
      pickBtn.textContent = _picking ? "Picking… (click nodes)" : "Pick Nodes";
      pickedEl.textContent = picked.size ? [...picked].join(", ") : "(none)";
    }

    function setPicking(v) {
      _picking = !!v;
    }

    panel.querySelector("#dash-hide").onclick = () => (panel.style.display = "none");
    panel.querySelector("#dash-clear").onclick = () => {
      picked.clear();
      render();
    };
    pickBtn.onclick = () => {
      _picking = !_picking;
      render();
    };

    // click nodes to pick
    const oldOnMouseDown = app.canvas.onMouseDown?.bind(app.canvas);
    app.canvas.onMouseDown = function (e) {
      if (_picking) {
        const pos = app.canvas.convertEventToCanvasOffset(e);
        const node = app.graph.getNodeOnPos(pos[0], pos[1]);
        if (node) {
          const id = String(node.id);
          if (picked.has(id)) picked.delete(id);
          else picked.add(id);
          render();
          return; // consume click
        }
      }
      return oldOnMouseDown ? oldOnMouseDown(e) : undefined;
    };

    attachButtonsWhenReady(() => ({
      panel,
      render,
      setPicking,
      picking: () => _picking,
    }));

    render();
  },
});